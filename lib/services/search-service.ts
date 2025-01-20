import { EventEmitter } from 'events';
import type { SearchParams, SearchResult } from '../types/api';
import type { Event, TicketData, EventData, SearchMetadata, EventSearchResult } from '../types/schemas';
import { createClient } from '@supabase/supabase-js';
import { config } from '@/src/config/env';
import { webReaderService } from './parsehub-service';
import { DuckDuckGoSearcher } from './duckduckgo-searcher';
import { normalizeDateTime, areDatesMatching, doDateTimesMatch, isValidDate } from '../utils/date-utils';
import * as cheerio from 'cheerio';
import { getParser } from './llm-service';

interface DbEvent {
  id: string;
  name: string;
  date: string;
  venue: string;
  event_links: Array<{
    source: string;
    url: string;
  }>;
}

interface DbTicket {
  id: string;
  event_id: string;
  section: string;
  row?: string;
  price: number;
  quantity: number;
  source: string;
  listing_id: string;
  event: {
    id: string;
    name: string;
    date: string;
    venue: string;
    city: string;
    state: string;
    country: string;
  };
}

// Add internal result type
interface InternalSearchResult {
  events: EventSearchResult[];
}

export class SearchService extends EventEmitter {
  private supabase;
  private duckDuckGoSearcher: DuckDuckGoSearcher;
  private parser;

  constructor() {
    super();
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.serviceKey || config.supabase.anonKey
    );
    this.duckDuckGoSearcher = new DuckDuckGoSearcher();
    this.parser = getParser('gemini');
  }

  async findMatchingEvent(event: Event): Promise<DbEvent | null> {
    // First get all events at the same venue within the time window
    const { data: venueTimeMatches } = await this.supabase
      .from('events')
      .select(`
        id,
        name,
        date,
        venue,
        event_links!inner(
          source,
          url
        )
      `)
      .eq('venue', event.venue)
      // Use a time window of ±2 hours for the date comparison
      .gte('date', new Date(new Date(event.date).getTime() - 2 * 60 * 60 * 1000).toISOString())
      .lte('date', new Date(new Date(event.date).getTime() + 2 * 60 * 60 * 1000).toISOString());

    if (!venueTimeMatches?.length) return null;

    // Extract the core event name by removing venue and location info
    function extractCoreName(fullName: string): string {
      const name = normalizeEventName(fullName);
      
      // Remove common venue/location patterns
      const patterns = [
        /\bat .+$/i,           // "at Venue Name"
        /\bin .+$/i,           // "in City Name"
        /,.+$/,                // ", City, State"
        /\s*-\s*.+$/,         // "- Additional Info"
        /\s+tickets?$/i,      // "tickets" at the end
        /\s+concert$/i,       // "concert" at the end
        /\s+live$/i,          // "live" at the end
        /\s+tour$/i           // "tour" at the end
      ];
      
      let coreName = name;
      patterns.forEach(pattern => {
        coreName = coreName.replace(pattern, '');
      });
      
      return coreName.trim();
    }

    // Among venue/time matches, find the best name match using fuzzy logic
    const bestMatch = venueTimeMatches.reduce<DbEvent | null>((best, current) => {
      const eventCoreName = extractCoreName(event.name);
      const currentCoreName = extractCoreName(current.name);
      
      // Calculate similarity between core names
      const similarity = calculateJaroWinklerSimilarity(eventCoreName, currentCoreName);
      const bestSimilarity = best ? calculateJaroWinklerSimilarity(eventCoreName, extractCoreName(best.name)) : 0;

      console.log(`Comparing event names:
        Original: "${event.name}" -> Core: "${eventCoreName}"
        Current: "${current.name}" -> Core: "${currentCoreName}"
        Similarity: ${similarity}
      `);

      return similarity > bestSimilarity ? current : best;
    }, null);

    // Use a lower threshold (0.8) since we're matching core names
    const matchSimilarity = bestMatch ? 
      calculateJaroWinklerSimilarity(
        extractCoreName(event.name),
        extractCoreName(bestMatch.name)
      ) : 0;

    if (bestMatch && matchSimilarity >= 0.8) {
      console.log(`Found matching event: "${event.name}" matches "${bestMatch.name}" (${matchSimilarity.toFixed(2)} similarity)`);
      return bestMatch;
    }

    console.log(`No match found for "${event.name}" at ${event.venue}`);
    return null;
  }

  async addEventLink(eventId: string, source: string, url: string) {
    const { data: existingLink } = await this.supabase
      .from('event_links')
      .select()
      .eq('event_id', eventId)
      .eq('source', source)
      .single();

    if (!existingLink) {
      await this.supabase
        .from('event_links')
        .insert({
          event_id: eventId,
          source,
          url
        });
    }
  }

  async saveTickets(eventId: string, tickets: TicketData[]) {
    try {
      const formattedTickets = tickets.map(ticket => ({
        event_id: eventId,
        section: ticket.section || '',
        row: ticket.row || '',
        price: parseFloat(ticket.price.toString()),
        quantity: parseInt(ticket.quantity?.toString() || '1'),
        source: ticket.source,
        listing_id: ticket.listing_id || crypto.randomUUID(),
        ticket_url: ticket.source === 'vividseats' ? ticket.ticket_url : null,
        created_at: new Date().toISOString()
      }));

      console.log('Saving tickets to database:', formattedTickets);
      
      // First, delete existing tickets for this event/source combination
      const { error: deleteError } = await this.supabase
        .from('tickets')
        .delete()
        .eq('event_id', eventId)
        .eq('source', tickets[0]?.source);

      if (deleteError) {
        console.error('Error deleting existing tickets:', deleteError);
        // Continue processing even if delete fails
      }

      // Then insert new tickets in batches to avoid conflicts
      const batchSize = 50;
      const savedTickets: any[] = [];
      
      for (let i = 0; i < formattedTickets.length; i += batchSize) {
        const batch = formattedTickets.slice(i, i + batchSize);
        try {
          const { data, error: insertError } = await this.supabase
            .from('tickets')
            .upsert(batch, {
              onConflict: 'event_id,section,row,price',
              ignoreDuplicates: true
            })
            .select();

          if (insertError) {
            console.warn('Database warning saving tickets batch:', insertError);
            // Continue processing other batches
          }

          if (data) {
            savedTickets.push(...data);
          }
        } catch (error) {
          console.warn(`Error saving batch ${i / batchSize + 1}:`, error);
          // Continue with next batch
        }
      }

      // Get all saved tickets for verification
      const { data: verifiedTickets, error: selectError } = await this.supabase
        .from('tickets')
        .select()
        .eq('event_id', eventId)
        .eq('source', tickets[0]?.source);

      if (selectError) {
        console.warn('Warning fetching saved tickets:', selectError);
      }

      const successCount = verifiedTickets?.length || 0;
      console.log(`Successfully saved ${successCount} out of ${tickets.length} tickets to database`);
      
      return verifiedTickets || [];
    } catch (error) {
      console.error('Error in saveTickets:', error);
      // Return empty array but don't throw, allowing processing to continue
      return [];
    }
  }

  private async emitAllTickets(eventId: string) {
    // Get ALL tickets for this event from ALL sources, including event links
    const { data: tickets, error: ticketsError } = await this.supabase
      .from('tickets')
      .select(`
        id,
        event_id,
        section,
        row,
        price,
        quantity,
        source,
        listing_id,
        ticket_url,
        event:events (
          id,
          name,
          date,
          venue,
          city,
          state,
          country,
          event_links (
            source,
            url
          )
        )
      `)
      .eq('event_id', eventId)
      .order('price');

    if (ticketsError) {
      console.error('Error fetching all tickets:', ticketsError);
      return;
    }

    if (tickets?.length) {
      // Format tickets with event data for frontend
      const allTicketsWithEvent = tickets.map((ticket: any) => {
        // Find the event link for this ticket's source
        const eventLink = ticket.event.event_links?.find((link: any) => link.source === ticket.source);
        
        // Use ticket-specific URL if available, otherwise fall back to event URL
        const ticketUrl = ticket.ticket_url || (eventLink ? eventLink.url : null);

        // Format the date string to remove timezone and preserve local time
        const dateStr = ticket.event.date.replace(/[+-]\d{2}:?\d{2}$/, '');
        const [datePart, timePart] = dateStr.split(' ');
        const [year, month, day] = datePart.split('-').map(Number);
        const [hours, minutes] = timePart ? timePart.split(':').map(Number) : [0, 0];
        const localDate = new Date(year, month - 1, day, hours, minutes);
        const formattedDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')} ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00`;

        // Add a label for Ticketmaster/LiveNation tickets
        const isTicketmaster = ticket.source === 'ticketmaster' || ticket.source === 'livenation';
        const priceLabel = isTicketmaster ? 'Face value price' : 'Price';

        return {
          id: ticket.id,
          name: ticket.event.name,
          date: formattedDate,
          venue: ticket.event.venue,
          location: {
            city: ticket.event.city,
            state: ticket.event.state,
            country: ticket.event.country
          },
          section: ticket.section,
          row: ticket.row || '',
          price: parseFloat(ticket.price.toString()),
          price_label: priceLabel,
          quantity: parseInt(ticket.quantity.toString()),
          source: ticket.source,
          listing_id: ticket.listing_id,
          ticket_url: ticketUrl
        };
      });

      console.log('Found total tickets:', allTicketsWithEvent.length);
      // Emit ALL tickets to frontend
      this.emit('tickets', allTicketsWithEvent);
      console.log(`Emitted ${allTicketsWithEvent.length} total tickets to frontend`);
    }
  }

  async processEventPage(eventId: string, source: string, url: string, html?: string): Promise<void> {
    try {
      // Get HTML from Jina Reader only if not provided
      if (!html) {
        console.log(`Fetching event page from Jina Reader: ${url}`);
        html = await webReaderService.fetchPage(url);
      } else {
        console.log(`Using provided HTML for event page: ${url}`);
      }
      console.log(`Processing ${source} event page (${html.length} bytes)`);

      // Parse tickets using Gemini
      const parsedData = await this.parser.parseTickets(html);
      console.log('Parsed ticket data:', parsedData);

      // Convert ticket data to database format
      const tickets = parsedData.tickets.map(ticket => ({
        section: ticket.section,
        row: ticket.row || '',
        price: ticket.price,
        quantity: ticket.quantity,
        source,
        ticket_url: url,
        listing_id: ticket.listing_id || crypto.randomUUID()
      }));

      if (tickets.length) {
        // Save tickets to database
        await this.saveTickets(eventId, tickets);
        
        // Emit updated tickets
        await this.emitAllTickets(eventId);
      } else {
        console.log(`No tickets found on ${source} event page: ${url}`);
      }
    } catch (error) {
      console.error(`Error processing ${source} event page (${url}):`, error);
    }
  }

  async searchAll(params: SearchParams): Promise<SearchResult> {
    try {
      // First, check for existing events
      this.emit('status', 'Checking for existing events...');
      const { data: existingEvents } = await this.supabase
        .from('events')
        .select(`
          id,
          name,
          date,
          venue,
          event_links!inner(
            source,
            url
          )
        `)
        .ilike('name', `%${params.keyword}%`)
        .gte('date', new Date().toISOString());

      // If we found existing events, update their tickets
      if (existingEvents?.length) {
        this.emit('status', `Found ${existingEvents.length} existing events. Updating tickets...`);
        
        // Process all events concurrently but wait for completion
        await Promise.all(existingEvents.map(async (event: DbEvent) => {
          const linkPromises = event.event_links.map(async (link: { source: string; url: string }) => {
            this.emit('status', `Updating tickets for ${event.name} from ${link.source}...`);
            try {
              await this.processEventPage(event.id, link.source, link.url);
            } catch (error) {
              console.error(`Error updating tickets from ${link.source}:`, error);
              this.emit('status', error instanceof Error ? error.message : 'Error updating tickets');
            }
          });
          await Promise.all(linkPromises);
        }));

        // Get all tickets for these events after processing is complete
        const { data: tickets } = await this.supabase
          .from('tickets')
          .select(`
            id,
            event_id,
            section,
            row,
            price,
            quantity,
            source,
            listing_id,
            ticket_url,
            event:events (
              id,
              name,
              date,
              venue,
              city,
              state,
              country,
              event_links (
                source,
                url
              )
            )
          `)
          .in('event_id', existingEvents.map(e => e.id))
          .order('price');

        // Format tickets with event data for frontend
        const allTicketsWithEvent = tickets?.map((ticket: any) => {
          const eventLink = ticket.event.event_links?.find((link: any) => link.source === ticket.source);
          const ticketUrl = ticket.ticket_url || (eventLink ? eventLink.url : null);

          return {
            id: ticket.id,
            name: ticket.event.name,
            date: ticket.event.date,
            venue: ticket.event.venue,
            location: {
              city: ticket.event.city,
              state: ticket.event.state,
              country: ticket.event.country
            },
            tickets: [],
            price: parseFloat(ticket.price.toString()),
            section: ticket.section,
            row: ticket.row || '',
            quantity: parseInt(ticket.quantity.toString()),
            source: ticket.source,
            listing_id: ticket.listing_id,
            ticket_url: ticketUrl
          };
        }) || [];

        const metadata: SearchMetadata = {
          sources: Array.from(new Set(allTicketsWithEvent.map(t => t.source)))
        };

        return {
          success: true,
          data: allTicketsWithEvent,
          metadata
        };
      }

      // If no existing events, run new searches
      this.emit('status', 'Starting new search...');
      this.emit('status', 'Searching via DuckDuckGo...');
      
      const searchResults = await this.duckDuckGoSearcher.searchConcerts(
        params.keyword,
        params.location,
        params.location
      );

      if (searchResults.length > 0) {
        this.emit('status', `Found ${searchResults.length} events via DuckDuckGo`);
        
        // Format tickets with event data for frontend
        const formattedResults: EventSearchResult[] = searchResults.map((result: { 
          name: string;
          date: string;
          venue: string;
          location?: {
            city: string;
            state: string;
            country: string;
          };
          source?: string;
          link?: string;
          description?: string;
          ticket_links: Array<{
            source: string;
            url: string;
            is_primary: boolean;
          }>;
          has_ticketmaster: boolean;
        }) => ({
          name: result.name,
          date: result.date,
          venue: result.venue,
          location: result.location ? {
            city: result.location.city || '',
            state: result.location.state || '',
            country: result.location.country || 'US'
          } : undefined,
          source: result.source,
          link: result.link,
          description: result.description,
          ticket_links: result.ticket_links || [],
          has_ticketmaster: result.has_ticketmaster || false
        }));
        
        // Filter results by location and keyword
        let filteredResults = formattedResults;
        
        // Filter by location if provided
        if (params.location) {
          console.log('Filtering events by location:', params.location);
          filteredResults = this.filterEventsByLocation(filteredResults, params.location);
          console.log(`Found ${filteredResults.length} events matching location`);
        }

        // Filter by keyword
        filteredResults = filteredResults.filter(event => {
          const normalizedEventName = normalizeEventName(event.name);
          const normalizedKeyword = normalizeEventName(params.keyword);
          const nameMatch = normalizedEventName.includes(normalizedKeyword) || 
                          normalizedKeyword.includes(normalizedEventName);
          
          if (!nameMatch) {
            console.log(`Event name mismatch: "${event.name}" vs keyword "${params.keyword}"`);
          }
          return nameMatch;
        });

        console.log(`Found ${filteredResults.length} events matching keyword and location`);

        if (filteredResults.length === 0) {
          console.log('No matching events found in search results');
          return {
            success: false,
            data: [],
            metadata: { sources: [] }
          };
        }

        // Find the best matching event from filtered results
        const bestEvent = this.findBestEvent(filteredResults);
        console.log('Selected best matching event:', bestEvent);

        // Initialize ticket links collection
        const allTicketLinks = new Map<string, { source: string; url: string }>();
        
        // Helper function to validate ticket vendor URLs
        const isValidEventUrl = (url: string, source: string) => {
          if (source === 'stubhub') {
            // StubHub event URLs contain /event/ or end with a numeric event ID
            return /\/event\/|\/[0-9]+$/.test(url);
          }
          if (source === 'vividseats') {
            // VividSeats event URLs contain /tickets/ but not /search?
            return url.includes('/tickets/') && !url.includes('/search?');
          }
          return true; // Other sources like Ticketmaster are handled separately
        };
        
        // Collect ticket links from best event
        bestEvent.ticket_links?.forEach(link => {
          if (!link.source || !link.url) return;
          
          // Only add valid event URLs for StubHub and VividSeats
          if (!isValidEventUrl(link.url, link.source)) {
            console.log(`Skipping invalid ${link.source} URL: ${link.url}`);
            return;
          }
          
          const key = `${link.source}-${link.url}`;
          allTicketLinks.set(key, {
            source: link.source,
            url: link.url
          });
        });

        // Collect ticket links from other matching events
        filteredResults.forEach(event => {
          if (event !== bestEvent) {
            event.ticket_links?.forEach(link => {
              if (!link.source || !link.url) return;
              
              // Only add valid event URLs for StubHub and VividSeats
              if (!isValidEventUrl(link.url, link.source)) {
                console.log(`Skipping invalid ${link.source} URL: ${link.url}`);
                return;
              }
              
              const key = `${link.source}-${link.url}`;
              allTicketLinks.set(key, {
                source: link.source,
                url: link.url
              });
            });
          }
        });

        console.log('All collected ticket links:', Array.from(allTicketLinks.values()));

        // Create single event from best match
        const { data: savedEvent, error: eventError } = await this.supabase
          .from('events')
          .upsert({
            name: bestEvent.name,
            date: bestEvent.date.split('T')[0],
            venue: bestEvent.venue,
            city: bestEvent.location?.city || '',
            state: bestEvent.location?.state || '',
            country: bestEvent.location?.country || 'US',
            created_at: new Date().toISOString()
          })
          .select()
          .single();

        if (eventError) {
          console.error('Error saving event:', eventError);
          return {
            success: false,
            data: [],
            metadata: { sources: [] }
          };
        }

        if (savedEvent) {
          // Save all collected ticket links
          const eventLinks = Array.from(allTicketLinks.values()).map(link => ({
            event_id: savedEvent.id,
            source: link.source,
            url: link.url
          }));

          console.log('Saving event links:', eventLinks);

          // First delete existing links for this event
          const { error: deleteError } = await this.supabase
            .from('event_links')
            .delete()
            .eq('event_id', savedEvent.id);

          if (deleteError) {
            console.error('Error deleting existing event links:', deleteError);
          }

          // Then insert new links
          const { error: linkError } = await this.supabase
            .from('event_links')
            .insert(eventLinks);

          if (linkError) {
            console.error('Error saving event links:', linkError);
          }

          // Check if the best event has a Ticketmaster/LiveNation link
          if (bestEvent.has_ticketmaster) {
            const tmLink = eventLinks.find(link => 
              link.source === 'ticketmaster' || link.source === 'livenation'
            );
            if (tmLink) {
              console.log('Processing Ticketmaster event from link:', tmLink.url);
              await this.processTicketmasterEvent(savedEvent.id, tmLink.url, bestEvent);
            }
          }

          // Continue with other ticket sources
          for (const service of ['stubhub', 'vividseats']) {
            try {
              // Check if we have a direct event link from search results
              const serviceLink = Array.from(allTicketLinks.values())
                .find(link => link.source === service);

              // If we have a valid direct link, process it
              if (serviceLink && isValidEventUrl(serviceLink.url, service)) {
                console.log(`Found direct ${service} event link:`, serviceLink.url);
                console.log(`Processing ${service} event page from direct link:`, serviceLink.url);
                await this.processEventPage(savedEvent.id, service, serviceLink.url);
              } else {
                // If no valid direct link, we need to search the service
                console.log(`No valid ${service} event link found, searching ${service} for event match`);
                
                // Create search terms that combine both the keyword and best event name
                const searchTerms = [
                  params.keyword,
                  bestEvent.name,
                  // Extract artist/band name (usually before special characters)
                  bestEvent.name.split(/[-–—(]/)[0].trim()
                ].filter((term): term is string => Boolean(term));

                // Remove duplicates and very short terms
                const uniqueSearchTerms = Array.from(new Set(searchTerms))
                  .filter(term => term.length > 2);

                console.log('Using search terms:', uniqueSearchTerms);

                const locationTerm = bestEvent.location?.city || params.location || '';
                
                // Try each search term until we find matches
                let foundMatches = false;
                for (const searchTerm of uniqueSearchTerms) {
                  if (foundMatches) break;

                  const searchUrl = service === 'stubhub' ?
                    `https://www.stubhub.com/secure/search?q=${encodeURIComponent(searchTerm)}+${encodeURIComponent(locationTerm)}` :
                    `https://www.vividseats.com/search?searchTerm=${encodeURIComponent(searchTerm)}${locationTerm ? '+' + encodeURIComponent(locationTerm) : ''}`;
                    
                  console.log(`Searching ${service} with term: "${searchTerm}"`);
                  const searchHtml = await webReaderService.fetchPage(searchUrl);
                  
                  // Parse the search results using the already fetched HTML
                  const searchResults = await this.searchSite(searchUrl, service, {
                    keyword: searchTerm,
                    location: locationTerm,
                    html: searchHtml  // Pass the HTML we already have
                  });

                  if (searchResults.length > 0) {
                    console.log(`Found ${searchResults.length} potential matches from ${service}`);

                    // For each search result, try to match it with our event
                    for (const result of searchResults) {
                      try {
                        const eventUrl = result.url || result.link;
                        if (!eventUrl) {
                          console.log('Search result missing URL (checked both url and link properties), skipping');
                          continue;
                        }

                        // Check venue match first
                        const venueMatch = this.compareVenues(result.venue, bestEvent.venue);
                        if (!venueMatch) {
                          console.log(`Venue mismatch: "${result.venue}" vs "${bestEvent.venue}"`);
                          continue;
                        }

                        // Check date proximity
                        const resultDate = normalizeDateTime(result.date);
                        const eventDate = normalizeDateTime(bestEvent.date);

                        if (!resultDate || !eventDate) {
                          console.log(`Invalid date format: "${result.date}" or "${bestEvent.date}"`);
                          continue;
                        }

                        // First check if they're on the same day
                        if (!areDatesMatching(resultDate, eventDate)) {
                          console.log(`Date mismatch: "${resultDate}" vs "${eventDate}"`);
                          continue;
                        }

                        // Check if there are multiple events by this artist at this venue on this day
                        const multipleEvents = filteredResults.filter(event => {
                          const otherDate = normalizeDateTime(event.date);
                          return event.name === bestEvent.name &&
                                 event.venue === bestEvent.venue &&
                                 areDatesMatching(otherDate, eventDate);
                        }).length > 1;

                        // If multiple events, also check the time
                        if (multipleEvents && !doDateTimesMatch(resultDate, eventDate)) {
                          console.log(`Time mismatch for multiple events: "${resultDate}" vs "${eventDate}"`);
                          continue;
                        }

                        console.log(`Found matching ${service} event:`, {
                            resultName: result.name,
                            venue: result.venue,
                            date: result.date,
                            multipleEvents,
                            url: eventUrl
                        });

                        // Save the event link first
                        const { error: linkError } = await this.supabase
                          .from('event_links')
                          .insert({
                            event_id: savedEvent.id,
                            source: service,
                            url: eventUrl
                          });

                        if (linkError) {
                          console.error('Error saving event link:', linkError);
                        }

                        // Process tickets for this match and stop searching
                        await this.processEventPage(savedEvent.id, service, eventUrl, searchHtml);
                        foundMatches = true;
                        break;
                      } catch (error) {
                        console.error(`Error processing search result:`, error);
                        continue;
                      }
                    }

                    // If we found and processed a match, stop searching with other terms
                    if (foundMatches) {
                      console.log('Match found and processed, skipping remaining search terms');
                      break;
                    }
                  }
                }

                if (!foundMatches) {
                  console.log(`No matching events found on ${service}`);
                }
              }
            } catch (error) {
              console.error(`Error processing ${service}:`, error);
            }
          }
        }

        // Return formatted results
        const { data: savedTickets } = await this.supabase
          .from('tickets')
          .select(`
            id,
            event_id,
            section,
            row,
            price,
            quantity,
            source,
            listing_id,
            ticket_url,
            event:events (
              id,
              name,
              date,
              venue,
              city,
              state,
              country,
              event_links (
                source,
                url
              )
            )
          `)
          .eq('event_id', savedEvent.id)
          .order('price');

        // Create a single event object with tickets
        const eventWithTickets = {
          id: savedEvent.id,
          name: savedEvent.name,
          date: savedEvent.date,
          venue: savedEvent.venue,
          location: {
            city: savedEvent.city,
            state: savedEvent.state,
            country: savedEvent.country
          },
          tickets: savedTickets?.map((ticket: any) => ({
            id: ticket.id,
            price: parseFloat(ticket.price.toString()),
            section: ticket.section,
            row: ticket.row || '',
            quantity: parseInt(ticket.quantity.toString()),
            source: ticket.source,
            listing_id: ticket.listing_id,
            ticket_url: ticket.ticket_url
          })) || []
        };

        return {
          success: true,
          data: [eventWithTickets],
          metadata: {
            sources: Array.from(new Set(savedTickets?.map(t => t.source) || [])),
            eventId: savedEvent.id
          }
        };
      }

      // If no results found
      return {
        success: true,
        data: [],
        metadata: { sources: [] }
      };

    } catch (error) {
      console.error('Search error:', error);
      return {
        success: false,
        data: [],
        metadata: { sources: [] }
      };
    }
  }

  async searchSite(url: string, source: string, params: { keyword: string; html?: string; location?: string }): Promise<EventSearchResult[]> {
    let html = params.html || '';
    try {
      // Get HTML from Jina Reader only if not provided
      if (!html) {
        html = await webReaderService.fetchPage(url);
      }
      console.log(`Received HTML from ${source} (${html.length} bytes)`);

      // Use Gemini to extract data
      const parsedEvents = await this.parser.parseEvents(html);

      if (!parsedEvents.events.length) {
        console.log('No events found by Gemini parser');
        // Fall back to Cheerio-based extraction
        const $ = cheerio.load(html);
        const events: EventSearchResult[] = [];

        // Extract event links based on source
        if (source === 'stubhub') {
          // Find all event cards in the grid
          const eventCards = $('[data-testid="primaryGrid"] [data-testid="eventCard"]');
          console.log(`Found ${eventCards.length} StubHub event cards`);
          
          eventCards.each((_, card) => {
            const $card = $(card);
            // The link is directly on the card or inside it
            const $link = $card.is('a') ? $card : $card.find('a').first();
            const href = $link.attr('href');
            
            if (!href) {
              console.log('No href found for StubHub event card');
              return;
            }
            
            const eventUrl = href.startsWith('http') ? href : `https://www.stubhub.com${href}`;
            const name = $card.find('[data-testid="eventTitle"]').text().trim() || 
                        $card.find('h3').text().trim();
            const dateText = $card.find('[data-testid="eventDate"]').text().trim() || 
                           $card.find('time').text().trim();
            const venueText = $card.find('[data-testid="eventVenue"]').text().trim() || 
                            $card.find('span:contains("•")').text().split('•')[0]?.trim();
            
            // Normalize the date with proper time
            const normalizedDate = normalizeDateTime(dateText);
            if (!normalizedDate) {
              console.log(`Invalid date format for StubHub event: ${dateText}`);
              return;
            }

            console.log('Found StubHub event:', { eventUrl, name, date: normalizedDate, venueText });
            
            if (name && eventUrl) {
              events.push({
                name,
                date: normalizedDate,
                venue: venueText || 'TBD',
                source,
                link: eventUrl,
                ticket_links: [{
                  source,
                  url: eventUrl,
                  is_primary: false
                }],
                has_ticketmaster: false
              });
            }
          });
        } else if (source === 'vividseats') {
          // Find all production cards
          const productionCards = $('[data-testid="productions-list"] [data-testid="production-card"]');
          console.log(`Found ${productionCards.length} VividSeats production cards`);
          
          productionCards.each((_, card) => {
            const $card = $(card);
            // Find the first link in the card
            const $link = $card.find('a').first();
            const href = $link.attr('href');
            
            if (!href) {
              console.log('No href found for VividSeats production card');
              return;
            }
            
            const eventUrl = href.startsWith('http') ? href : `https://www.vividseats.com${href}`;
            // Try both data-testid and class selectors
            const name = $card.find('[data-testid="production-name"]').text().trim() || 
                        $card.find('.production-name').text().trim();
            const dateText = $card.find('[data-testid="production-date"]').text().trim() || 
                           $card.find('.production-date').text().trim();
            const venueText = $card.find('[data-testid="production-venue"]').text().trim() || 
                            $card.find('.production-venue').text().trim();
            
            // Normalize the date with proper time
            const normalizedDate = normalizeDateTime(dateText);
            if (!normalizedDate) {
              console.log(`Invalid date format for VividSeats event: ${dateText}`);
              return;
            }

            console.log('Found VividSeats event:', { eventUrl, name, date: normalizedDate, venueText });
            
            if (name && eventUrl) {
              events.push({
                name,
                date: normalizedDate,
                venue: venueText || 'TBD',
                source,
                link: eventUrl,
                ticket_links: [{
                  source,
                  url: eventUrl,
                  is_primary: false
                }],
                has_ticketmaster: false
              });
            }
          });
        }

        console.log(`Extracted ${events.length} events using Cheerio parser`);
        return events;
      }

      // Convert parsed events to our internal format
      const validEvents = parsedEvents.events
        .filter((event: any) => event.eventUrl || url)
        .map((event: any) => {
          // Ensure we have a complete date with time
          let eventDate = normalizeDateTime(event.date);
          if (!eventDate) {
            // If we only have a year, default to January 1st of that year
            if (/^\d{4}$/.test(event.date)) {
              eventDate = `${event.date}-01-01T00:00:00Z`;
            } else {
              console.log(`Invalid date format for event: ${event.date}`);
              eventDate = new Date().toISOString(); // Fallback to current date
            }
          }

          return {
            name: event.name,
            date: eventDate,
            venue: event.venue,
            location: event.location ? {
              city: event.location.split(',')[0]?.trim() || '',
              state: event.location.split(',')[1]?.trim() || '',
              country: 'US'
            } : undefined,
            source,
            link: event.eventUrl || url,
            description: event.price ? `Tickets from ${event.price}` : undefined,
            ticket_links: [{
              source,
              url: event.eventUrl || url,
              is_primary: source === 'ticketmaster' || source === 'livenation'
            }],
            has_ticketmaster: source === 'ticketmaster' || source === 'livenation'
          };
        });

      return validEvents;

    } catch (error) {
      console.error(`Error searching ${source}:`, error);
      return [];
    }
  }

  private extractEventDataWithRegex(html: string, source: string, url: string): EventSearchResult[] {
    try {
      const $ = cheerio.load(html);
      const events: EventSearchResult[] = [];

      // Look for common event patterns in the HTML
      $('*').each((_, el) => {
        const $el = $(el);
        const text = $el.text().trim();

        // Skip empty or very short text
        if (text.length < 10) return;

        // Try to extract event data using regex patterns
        const dateMatch = text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}\b/i);
        const venueMatch = text.match(/\bat\s+([^,]+)(?:\s+in\s+([^,]+),\s*([A-Z]{2}))?/i);
        
        if (dateMatch || venueMatch) {
          const event: Partial<EventSearchResult> = {
            date: dateMatch ? normalizeDateTime(dateMatch[0]) : '',
            venue: venueMatch ? venueMatch[1].trim() : '',
            location: venueMatch ? {
              city: venueMatch[2]?.trim() || '',
              state: venueMatch[3]?.trim() || '',
              country: 'US'
            } : undefined
          };

          if (event.date || event.venue) {
            events.push({
              ...event,
              name: '', // Will be filled by the caller
              ticket_links: [],
              has_ticketmaster: false
            } as EventSearchResult);
          }
        }
      });

      return events;
    } catch (error) {
      console.error('Error in regex extraction:', error);
      return [];
    }
  }

  private filterEventsByLocation(events: EventSearchResult[], searchLocation: string): EventSearchResult[] {
    // Normalize the search location
    const normalizedSearch = searchLocation.toLowerCase().trim();
    
    return events.filter(event => {
      if (!event.location) return false;

      // Check if the location matches either city or state
      const cityMatch = event.location.city.toLowerCase().includes(normalizedSearch);
      const stateMatch = event.location.state.toLowerCase().includes(normalizedSearch);
      
      // Also check venue name as it might contain location info
      const venueMatch = event.venue?.toLowerCase().includes(normalizedSearch);

      // For US state codes, try to match exactly
      const isStateCode = normalizedSearch.length === 2;
      const stateCodeMatch = isStateCode && 
        event.location.state.toLowerCase() === normalizedSearch;

      const isMatch = cityMatch || stateMatch || stateCodeMatch || venueMatch;
      
      if (isMatch) {
        console.log(`Location match found for "${event.name}" at ${event.venue}:`, {
          searchLocation: normalizedSearch,
          eventCity: event.location.city,
          eventState: event.location.state,
          venue: event.venue,
          matched: isMatch ? 'yes' : 'no'
        });
      }

      return isMatch;
    });
  }

  private compareVenues(venue1: string, venue2: string): boolean {
    // Normalize venue names
    const normalize = (venue: string) => {
      return venue.toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')  // Remove special characters
        .replace(/\s+/g, ' ')         // Normalize spaces
        .replace(/(theatre|theater|arena|stadium|hall|amphitheatre|amphitheater|pavilion|center|centre)/g, '') // Remove common venue type words
        .trim();
    };

    const venue1Norm = normalize(venue1);
    const venue2Norm = normalize(venue2);

    // Check for exact match after normalization
    if (venue1Norm === venue2Norm) return true;

    // Check for substring match
    if (venue1Norm.includes(venue2Norm) || venue2Norm.includes(venue1Norm)) return true;

    // Use Jaro-Winkler for fuzzy matching with a high threshold
    return calculateJaroWinklerSimilarity(venue1Norm, venue2Norm) > 0.9;
  }

  private async processTicketmasterEvent(eventId: string, url: string, event: Event) {
    try {
      const consumerKey = process.env.TICKETMASTER_API_KEY;
      if (!consumerKey) {
        throw new Error('Ticketmaster API key not found in environment variables');
      }

      if (!event.location) {
        console.error('Event location not found');
        return;
      }

      // Search for the event using the Discovery API
      const searchUrl = `https://app.ticketmaster.com/discovery/v2/events.json?apikey=${consumerKey}&keyword=${encodeURIComponent(event.name)}&city=${encodeURIComponent(event.location.city)}&stateCode=${event.location.state}&sort=date,asc`;
      console.log('Searching Ticketmaster events:', searchUrl.replace(consumerKey, '***'));

      const searchResponse = await fetch(searchUrl);
      if (!searchResponse.ok) {
        throw new Error(`Ticketmaster API error: ${searchResponse.status} ${searchResponse.statusText}`);
      }

      const searchResults = await searchResponse.json();
      if (!searchResults._embedded?.events?.length) {
        console.log('No events found for search');
        return;
      }

      // Find the event that matches our venue and date
      const eventDate = new Date(event.date);
      const matchingEvent = searchResults._embedded.events.find((e: any) => {
        const venueMatch = e._embedded?.venues?.[0]?.name?.toLowerCase() === event.venue.toLowerCase();
        const eventDateTime = new Date(e.dates.start.dateTime);
        const dateMatch = Math.abs(eventDateTime.getTime() - eventDate.getTime()) < 24 * 60 * 60 * 1000; // Within 24 hours
        return venueMatch && dateMatch;
      });

      if (!matchingEvent) {
        console.log('No matching event found');
        return;
      }

      // Get the full event details including price ranges
      const eventUrl = `https://app.ticketmaster.com/discovery/v2/events/${matchingEvent.id}?apikey=${consumerKey}`;
      console.log('Fetching Ticketmaster event:', eventUrl.replace(consumerKey, '***'));

      const response = await fetch(eventUrl);
      if (!response.ok) {
        throw new Error(`Ticketmaster API error: ${response.status} ${response.statusText}`);
      }

      const tmEvent = await response.json();
      console.log('Got Ticketmaster event:', tmEvent);

      if (tmEvent.priceRanges?.length) {
        const tickets = tmEvent.priceRanges.flatMap((range: any) => {
          // If min and max are the same, just create one ticket
          if (range.min === range.max) {
            return [{
              section: range.type || 'General',
              row: 'GA',
              price: range.min,
              quantity: 1,
              source: 'ticketmaster',
              listing_id: `${matchingEvent.id}-${range.type || 'general'}`,
              ticket_url: tmEvent.url || matchingEvent.url
            }];
          }
          
          // Otherwise create min and max tickets
          return [
            {
              section: `${range.type || 'General'} - Minimum`,
              row: 'GA',
              price: range.min,
              quantity: 1,
              source: 'ticketmaster',
              listing_id: `${matchingEvent.id}-${range.type || 'general'}-min`,
              ticket_url: tmEvent.url || matchingEvent.url
            },
            {
              section: `${range.type || 'General'} - Maximum`,
              row: 'GA',
              price: range.max,
              quantity: 1,
              source: 'ticketmaster',
              listing_id: `${matchingEvent.id}-${range.type || 'general'}-max`,
              ticket_url: tmEvent.url || matchingEvent.url
            }
          ];
        });

        console.log('Saving tickets:', tickets);
        await this.saveTickets(eventId, tickets);
      } else {
        console.log('No price ranges found for event');
      }
    } catch (error) {
      console.error('Error processing Ticketmaster event:', error);
    }
  }

  private findBestEvent(events: EventSearchResult[]): EventSearchResult {
    return events.reduce((best, current) => {
      // Score each event based on information completeness
      const getEventScore = (event: EventSearchResult) => {
        let score = 0;
        // Prefer events with full title
        if (event.name.toLowerCase().includes('tour')) score += 2;
        if (event.name.toLowerCase().includes('album')) score += 1;
        // Ensure required fields are present
        if (event.venue && event.date && event.location) score += 3;
        // Prefer events with more ticket links
        if (event.ticket_links) score += event.ticket_links.length;
        return score;
      };

      const currentScore = getEventScore(current);
      const bestScore = getEventScore(best);
      
      return currentScore > bestScore ? current : best;
    }, events[0]);
  }

  // Public method to get all tickets for an event
  async getAllTickets(eventId: string) {
    const { data: tickets, error } = await this.supabase
      .from('tickets')
      .select(`
        id,
        event_id,
        section,
        row,
        price,
        quantity,
        source,
        listing_id,
        ticket_url,
        event:events (
          id,
          name,
          date,
          venue,
          city,
          state,
          country,
          event_links!inner (
            source,
            url
          )
        )
      `)
      .eq('event_id', eventId)
      .order('price');

    if (error) {
      console.error('Error fetching tickets:', error);
      return [];
    }
    return tickets?.map(ticket => {
      // Find the event link for this ticket's source
      const eventLink = ticket.event.event_links?.find((link: any) => link.source === ticket.source);
      
      // Use ticket-specific URL if available, otherwise fall back to event URL
      const ticketUrl = ticket.ticket_url || (eventLink ? eventLink.url : null);

      return {
        id: ticket.id,
        event_id: ticket.event_id,
        name: ticket.event.name,
        date: ticket.event.date,
        venue: ticket.event.venue,
        location: {
          city: ticket.event.city,
          state: ticket.event.state,
          country: ticket.event.country
        },
        price: parseFloat(ticket.price.toString()),
        section: ticket.section,
        row: ticket.row || '',
        quantity: parseInt(ticket.quantity.toString()),
        source: ticket.source,
        listing_id: ticket.listing_id,
        ticket_url: ticketUrl
      };
    }) || [];
  }

  private getTimezoneFromLocation(city: string, state: string): string {
    // Map of US states to their primary timezone
    const stateTimezones: Record<string, string> = {
      'AK': 'America/Anchorage',
      'AL': 'America/Chicago',
      'AR': 'America/Chicago',
      'AZ': 'America/Phoenix',
      'CA': 'America/Los_Angeles',
      'CO': 'America/Denver',
      'CT': 'America/New_York',
      'DC': 'America/New_York',
      'DE': 'America/New_York',
      'FL': 'America/New_York',
      'GA': 'America/New_York',
      'HI': 'Pacific/Honolulu',
      'IA': 'America/Chicago',
      'ID': 'America/Boise',
      'IL': 'America/Chicago',
      'IN': 'America/Indiana/Indianapolis',
      'KS': 'America/Chicago',
      'KY': 'America/New_York',
      'LA': 'America/Chicago',
      'MA': 'America/New_York',
      'MD': 'America/New_York',
      'ME': 'America/New_York',
      'MI': 'America/Detroit',
      'MN': 'America/Chicago',
      'MO': 'America/Chicago',
      'MS': 'America/Chicago',
      'MT': 'America/Denver',
      'NC': 'America/New_York',
      'ND': 'America/Chicago',
      'NE': 'America/Chicago',
      'NH': 'America/New_York',
      'NJ': 'America/New_York',
      'NM': 'America/Denver',
      'NV': 'America/Los_Angeles',
      'NY': 'America/New_York',
      'OH': 'America/New_York',
      'OK': 'America/Chicago',
      'OR': 'America/Los_Angeles',
      'PA': 'America/New_York',
      'RI': 'America/New_York',
      'SC': 'America/New_York',
      'SD': 'America/Chicago',
      'TN': 'America/Chicago',
      'TX': 'America/Chicago',
      'UT': 'America/Denver',
      'VA': 'America/New_York',
      'VT': 'America/New_York',
      'WA': 'America/Los_Angeles',
      'WI': 'America/Chicago',
      'WV': 'America/New_York',
      'WY': 'America/Denver'
    };

    // Special cases for cities that are in different timezones than their state's primary timezone
    const cityOverrides: Record<string, string> = {
      'Michigan City': 'America/Chicago', // IN
      'Tell City': 'America/Chicago',     // IN
      'Starke': 'America/Chicago',        // FL
      'Gulf': 'America/Chicago',          // FL
      'Bay': 'America/Chicago'            // FL
    };

    // Check for city override first
    if (cityOverrides[city]) {
      return cityOverrides[city];
    }

    // Fall back to state timezone, defaulting to Eastern if not found
    return stateTimezones[state] || 'America/New_York';
  }

  async searchEvents(keyword: string, location?: string): Promise<SearchResult> {
    this.emit('status', 'Starting multi-source event search...');
    
    try {
      // Run searches in parallel
      const [serpResults, stubHubResults, vividSeatsResults] = await Promise.allSettled([
        // 1. Use SerpAPI to get initial event data and discover more ticket sources
        this.searchSite(keyword, location || '', { keyword }),
        
        // 2. Direct StubHub search
        this.searchStubHub(keyword, location),
        
        // 3. Direct VividSeats search
        this.searchVividSeats(keyword, location)
      ]);

      const events: Event[] = [];
      const sources = new Set<string>();
      
      // Process SerpAPI results
      if (serpResults.status === 'fulfilled' && serpResults.value) {
        const serpEvents = this.processSerpApiResults(serpResults.value);
        events.push(...serpEvents);
        sources.add('serpapi');
      }

      // Process StubHub results
      if (stubHubResults.status === 'fulfilled' && stubHubResults.value?.events) {
        events.push(...stubHubResults.value.events);
        sources.add('stubhub');
      }

      // Process VividSeats results
      if (vividSeatsResults.status === 'fulfilled' && vividSeatsResults.value?.events) {
        events.push(...vividSeatsResults.value.events);
        sources.add('vividseats');
      }

      // Deduplicate events based on name, date, and venue
      const uniqueEvents = this.deduplicateEvents(events);

      // Convert Event[] to EventData[]
      const eventData: EventData[] = uniqueEvents.map(event => ({
        ...event,
        tickets: event.tickets || []
      }));

      return {
        success: true,
        data: eventData,
        metadata: {
          sources: Array.from(sources)
        }
      };
    } catch (error) {
      console.error('Error in searchEvents:', error);
      return {
        success: false,
        data: [],
        metadata: { sources: [] }
      };
    }
  }

  private async searchStubHub(keyword: string, location?: string): Promise<InternalSearchResult> {
    // Combine keyword and location with a space between them
    const searchTerm = location ? `${keyword} ${location}` : keyword;
    const url = `https://www.stubhub.com/secure/search?q=${encodeURIComponent(searchTerm)}`;
    
    try {
      const html = await webReaderService.fetchPage(url);
      const result = await this.searchSite(url, 'stubhub', { 
        keyword,
        location,
        html
      });

      return { events: result };
    } catch (error) {
      console.error('StubHub search error:', error);
      return { events: [] };
    }
  }

  private async searchVividSeats(keyword: string, location?: string): Promise<InternalSearchResult> {
    // Combine keyword and location with a space between them
    const searchTerm = location ? `${keyword} ${location}` : keyword;
    const url = `https://www.vividseats.com/search?searchTerm=${encodeURIComponent(searchTerm)}`;
    
    try {
      const html = await webReaderService.fetchPage(url);
      const result = await this.searchSite(url, 'vividseats', { 
        keyword,
        location,
        html
      });

      return { events: result };
    } catch (error) {
      console.error('VividSeats search error:', error);
      return { events: [] };
    }
  }

  private processSerpApiResults(serpData: any): Event[] {
    if (!serpData || !serpData.ticketLinks) return [];

    const event: Event = {
      name: serpData.name,
      date: serpData.date || '',
      venue: serpData.venue?.name || '',
      location: {
        city: serpData.venue?.city || '',
        state: serpData.venue?.state || '',
        country: serpData.venue?.country || 'US'
      },
      source: 'serpapi',
      url: serpData.ticketLinks[0]?.url || ''
    };

    return [event];
  }

  private deduplicateEvents(events: Event[]): Event[] {
    const seen = new Set<string>();
    return events.filter(event => {
      const key = `${event.name.toLowerCase()}-${event.date}-${event.venue?.toLowerCase()}-${event.location?.city?.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private parseEventData(text: string, source: string, url: string): EventSearchResult[] {
    try {
      // Extract event name (usually appears after "Event:" or at the start of a line)
      const nameMatch = text.match(/Event:?\s*([^\n]+)/i) || 
                     text.match(/Title:?\s*([^\n]+)/i) ||
                     text.match(/^([^\n]+)/);
      const name = nameMatch ? nameMatch[1].trim() : '';

      // Extract date and time using multiple patterns
      let dateStr = '';
      let timeStr = '';

      // Try to extract from Ticketmaster URL first (most reliable)
      if (url.includes('ticketmaster.com')) {
        const urlDateMatch = url.match(/(\d{2})-(\d{2})-(\d{4})/);
        if (urlDateMatch) {
          const [_, month, day, year] = urlDateMatch;
          dateStr = `${year}-${month}-${day}`;
        }
      }

      // If no date in URL, look in text
      if (!dateStr) {
        const dateMatch = text.match(/Date:?\s*([^\n]+)/i) ||
                       text.match(/\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}\b/i) ||
                       text.match(/\b\d{4}-\d{2}-\d{2}\b/);
        dateStr = dateMatch ? dateMatch[1] || dateMatch[0] : '';
      }

      // Look for time in the description
      const timeMatch = text.match(/\b(\d{1,2}):(\d{2})\s*(am|pm)\b/i) ||
                       text.match(/\b(\d{1,2})\s*(am|pm)\b/i);
      
      if (timeMatch) {
        let hours = parseInt(timeMatch[1]);
        const minutes = timeMatch[2]?.match(/\d{2}/) ? timeMatch[2] : '00';
        const meridiem = ((timeMatch[2]?.match(/am|pm/i) || timeMatch[3]) || '').toString().toLowerCase();
        
        // Convert to 24-hour format
        if (meridiem === 'pm' && hours < 12) hours += 12;
        if (meridiem === 'am' && hours === 12) hours = 0;
        
        timeStr = `${hours.toString().padStart(2, '0')}:${minutes}:00`;
      } else {
        // Default to 19:00 (7 PM) for evening events if no time found
        timeStr = '19:00:00';
      }

      // Combine date and time
      const date = dateStr ? normalizeDateTime(`${dateStr} ${timeStr}`) : '';

      // Extract venue
      const venueMatch = text.match(/Venue:?\s*([^\n]+)/i) ||
                      text.match(/at\s+([^,\n]+)/i);
      const venue = venueMatch ? venueMatch[1].trim() : '';

      // Extract location (city, state)
      const locationMatch = text.match(/Location:?\s*([^\n]+)/i) ||
                        text.match(/in\s+([^,\n]+),\s*([A-Z]{2})/i);
      
      const location = locationMatch ? {
        city: locationMatch[1].trim(),
        state: (locationMatch[2] || '').trim(),
        country: 'US'
      } : undefined;

      // Extract ticket links
      const ticketLinks: Array<{ source: string; url: string; is_primary: boolean }> = [];
      
      // Add the source URL as a ticket link
      if (url) {
        ticketLinks.push({
          source,
          url,
          is_primary: source === 'ticketmaster' || source === 'livenation'
        });
      }

      // Look for additional ticket links in the text
      const urlMatches = text.match(/https?:\/\/[^\s)]+/g) || [];
      urlMatches.forEach(matchedUrl => {
        const urlLower = matchedUrl.toLowerCase();
        const knownSources = ['ticketmaster', 'livenation', 'stubhub', 'vividseats', 'seatgeek'];
        const matchedSource = knownSources.find(s => urlLower.includes(s));
        
        if (matchedSource && !ticketLinks.some(link => link.url === matchedUrl)) {
          ticketLinks.push({
            source: matchedSource,
            url: matchedUrl,
            is_primary: matchedSource === 'ticketmaster' || matchedSource === 'livenation'
          });
        }
      });

      // Only return event if we have at least a name and either a date or venue
      if (name && (date || venue)) {
        return [{
          name,
          date: date || new Date().toISOString(),
          venue: venue || 'TBD',
          location,
          source,
          link: url,
          ticket_links: ticketLinks,
          has_ticketmaster: ticketLinks.some(link => 
            link.source === 'ticketmaster' || link.source === 'livenation'
          )
        }];
      }

      return [];
    } catch (error) {
      console.error('Error parsing event data:', error);
      return [];
    }
  }
}

// Helper functions
function normalizeEventName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Remove special characters
    .replace(/\s+/g, ' ')        // Normalize spaces
    .trim();
}

function calculateJaroWinklerSimilarity(s1: string, s2: string): number {
  const s1Norm = normalizeEventName(s1);
  const s2Norm = normalizeEventName(s2);
  
  if (s1Norm === s2Norm) return 1;
  if (s1Norm.length === 0 || s2Norm.length === 0) return 0;

  // Maximum distance between matching characters
  const matchDistance = Math.floor(Math.max(s1Norm.length, s2Norm.length) / 2) - 1;

  // Find matching characters
  const s1Matches: boolean[] = Array(s1Norm.length).fill(false);
  const s2Matches: boolean[] = Array(s2Norm.length).fill(false);
  let matches = 0;

  for (let i = 0; i < s1Norm.length; i++) {
    const start = Math.max(0, i - matchDistance);
    const end = Math.min(i + matchDistance + 1, s2Norm.length);

    for (let j = start; j < end; j++) {
      if (!s2Matches[j] && s1Norm[i] === s2Norm[j]) {
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0;

  // Count transpositions
  let transpositions = 0;
  let k = 0;

  for (let i = 0; i < s1Norm.length; i++) {
    if (!s1Matches[i]) continue;
    
    while (!s2Matches[k]) k++;
    
    if (s1Norm[i] !== s2Norm[k]) transpositions++;
    k++;
  }

  // Calculate Jaro similarity
  const jaroSimilarity = (
    matches / s1Norm.length +
    matches / s2Norm.length +
    (matches - transpositions / 2) / matches
  ) / 3;

  // Calculate common prefix length (up to 4 characters)
  let commonPrefix = 0;
  const maxPrefix = Math.min(4, Math.min(s1Norm.length, s2Norm.length));
  for (let i = 0; i < maxPrefix; i++) {
    if (s1Norm[i] === s2Norm[i]) commonPrefix++;
    else break;
  }

  // Winkler modification: give more weight to strings with matching prefixes
  const winklerModification = 0.1; // Standard scaling factor
  return jaroSimilarity + (commonPrefix * winklerModification * (1 - jaroSimilarity));
}
export const searchService = new SearchService();

