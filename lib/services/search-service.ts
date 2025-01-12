import { EventEmitter } from 'events';
import { HfInference } from '@huggingface/inference';
import type { SearchParams, SearchResult } from '../types/api';
import type { Event, TicketData, EventData, SearchMetadata } from '@/lib/types/schemas';
import { createClient } from '@supabase/supabase-js';
import { config } from '@/src/config/env';
import GoogleEventsSearcher from '../services/google-events-searcher';
import { webReaderService } from './parsehub-service';
import * as cheerio from 'cheerio';

// Initialize HuggingFace client
const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) {
  console.warn('No HuggingFace API token found in environment variables (HF_TOKEN). Some features may be limited.');
}
console.log('HF Token available:', !!HF_TOKEN);

const hf = new HfInference(HF_TOKEN || '');

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

interface GoogleSearchResult {
  id?: string;
  name: string;
  date: string;
  venue: string;
  location: {
    city: string;
    state: string;
    country: string;
  };
  ticket_links: Array<{
    source: string;
    url: string;
    is_primary: boolean;
  }>;
}

export class SearchService extends EventEmitter {
  private supabase;
  private googleEventsSearcher: GoogleEventsSearcher;

  constructor() {
    super();
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.serviceKey || config.supabase.anonKey
    );
    this.googleEventsSearcher = new GoogleEventsSearcher();
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
        ticket_url: ticket.ticket_url,
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
          section: ticket.section,
          row: ticket.row || '',
          price: parseFloat(ticket.price.toString()),
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

  private async processEventPage(eventId: string, source: string, url: string, html?: string) {
    try {
      this.emit('status', `Processing event page from ${source}...`);
      
      // Only fetch HTML if not provided
      const pageHtml = await webReaderService.fetchPage(url);
      const result = await this.parseEventPage(pageHtml, source, eventId);
      
      if (result?.tickets?.length) {
        try {
          // Save to database first
          const savedTickets = await this.saveTickets(eventId, result.tickets);
          console.log(`Saved ${savedTickets.length} tickets to database for event`);

          // Emit updated ticket list to frontend even if some tickets failed to save
          await this.emitAllTickets(eventId);
        } catch (error) {
          console.error(`Error saving/emitting tickets for ${source}:`, error);
          // Still return the parsed tickets even if saving failed
        }
      }

      return result;
    } catch (error) {
      console.error(`Error in processEventPage for ${source}:`, error);
      this.emit('error', `Error processing ${source} event page: ${error instanceof Error ? error.message : 'Unknown error'}`);
      // Return empty result but don't throw
      return { tickets: [] };
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
        await Promise.all(existingEvents.map(async event => {
          const linkPromises = event.event_links.map(async (link: { source: string; url: string }) => {
            this.emit('status', `Updating tickets for ${event.name} from ${link.source}...`);
            try {
             // await this.processEventPage(event.id, link.source, link.url);
            } catch (error) {
              // Log error but continue with other sources
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
      this.emit('status', 'Searching via Google Events...');
      
      const googleResults = await this.googleEventsSearcher.searchConcerts(
        params.keyword,
        undefined,
        params.location
      ) as GoogleSearchResult[];

      if (googleResults.length > 0) {
        this.emit('status', `Found ${googleResults.length} events via Google`);
        
        // Filter Google results by location and keyword
        let filteredResults = googleResults;
        
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
          console.log('No matching events found in Google results');
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
        
        // Collect ticket links from best event
        bestEvent.ticket_links?.forEach(link => {
          if (!link.source || !link.url) return;
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
            date: bestEvent.date,
            venue: bestEvent.venue,
            city: bestEvent.location.city,
            state: bestEvent.location.state,
            country: bestEvent.location.country,
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

          // Process Ticketmaster links first
          const ticketmasterLinks = eventLinks.filter(link => link.source === 'ticketmaster');
          for (const tmLink of ticketmasterLinks) {
            await this.processTicketmasterEvent(savedEvent.id, tmLink.url, bestEvent);
          }

          // Continue with other ticket sources
          for (const service of ['stubhub', 'vividseats']) {
            try {
              // Check if we have a direct event link from Google results
              const serviceLink = Array.from(allTicketLinks.values())
                .find(link => link.source === service);

              if (serviceLink) {
                // If we have a direct link, process it
                console.log(`Processing ${service} event page from direct link:`, serviceLink.url);
                await this.processEventPage(savedEvent.id, service, serviceLink.url);
              } else {
                // If no direct link, we need to search the service
                console.log(`No direct ${service} link found, searching ${service} for event match`);
                
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
                        if (!result.url) {
                          console.log('Search result missing URL, skipping');
                          continue;
                        }

                        // Check venue match first
                        const venueMatch = this.compareVenues(result.venue, bestEvent.venue);
                        if (!venueMatch) {
                          console.log(`Venue mismatch: "${result.venue}" vs "${bestEvent.venue}"`);
                          continue;
                        }

                        // Check date proximity (within 2 hours)
                        const resultDate = new Date(result.date);
                        const eventDate = new Date(bestEvent.date);
                        
                        // Set both dates to UTC midnight for comparison
                        resultDate.setUTCHours(0, 0, 0, 0);
                        eventDate.setUTCHours(0, 0, 0, 0);
                        
                        const dateMatch = resultDate.getTime() === eventDate.getTime();
                        
                        if (!dateMatch) {
                          console.log(`Date mismatch: "${result.date}" (${resultDate.toISOString()}) vs "${bestEvent.date}" (${eventDate.toISOString()})`);
                          continue;
                        }

                        console.log(`Found matching ${service} event:`, {
                          resultName: result.name,
                          venue: result.venue,
                          date: result.date
                        });

                        // Save the event link first
                        const { error: linkError } = await this.supabase
                          .from('event_links')
                          .insert({
                            event_id: savedEvent.id,
                            source: service,
                            url: result.url
                          });

                        if (linkError) {
                          console.error('Error saving event link:', linkError);
                        }

                        // Process tickets for this match and stop searching
                        await this.processEventPage(savedEvent.id, service, result.url, searchHtml);
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
          .in('event_id', googleResults.filter(event => event.id).map(event => event.id!))
          .order('price');

        const formattedTickets = savedTickets?.map((ticket: any) => ({
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
          ticket_url: ticket.ticket_url
        })) || [];

        return {
          success: true,
          data: formattedTickets,
          metadata: {
            sources: Array.from(new Set(formattedTickets.map(t => t.source)))
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

  private async searchSite(url: string, source: string, params: { keyword: string; location?: string; html?: string }): Promise<EventData[]> {
    this.emit('status', `Searching ${source}...`);
    
    try {
      // Get HTML from Jina Reader only if not provided
      const html = params.html || await webReaderService.fetchPage(url);
      console.log(`Received HTML from ${source} (${html.length} bytes)`);

      const response = await hf.textGeneration({
        model: 'mistralai/Mistral-7B-Instruct-v0.2',
        inputs: `<s>[INST]Extract events from HTML as JSON array. Format: [{"name":"event name","venue":"venue name","date":"YYYY-MM-DD","city":"city name","state":"ST","country":"US","url":"url path"}]. Return only JSON array.

${html}[/INST]</s>`,
        parameters: {
          max_new_tokens: 1000,
          temperature: 0.1,
          do_sample: false,
          stop: ["</s>", "[INST]"]
        }
      });

      console.log(`Chunk response:`, response.generated_text);

      let eventsData: any[];
      // Find the last occurrence of a JSON array (after the HTML)
      const lastJsonMatch = response.generated_text.split('</body></html>')[1]?.match(/\[\s*{[\s\S]*}\s*\]/);
      const cleanedResponse = lastJsonMatch ? lastJsonMatch[0] : '[]';
      console.log('Cleaned response:', cleanedResponse);
      const parsed = JSON.parse(cleanedResponse);
      eventsData = Array.isArray(parsed) ? parsed : [parsed];
      console.log('Parsed event data:', eventsData);

      // Filter and convert events to EventData format
      const events = eventsData
        .filter(eventData => {
          // Skip obvious auxiliary events by checking venue
          if (eventData.venue.toLowerCase().includes('parking')) {
            return false;
          }

          const normalizedEventName = normalizeEventName(eventData.name);
          const normalizedKeyword = normalizeEventName(params.keyword);
          
          // Check if either name contains the other
          return normalizedEventName.includes(normalizedKeyword) || 
                 normalizedKeyword.includes(normalizedEventName);
        })
        .map(eventData => ({
          name: eventData.name,
          venue: eventData.venue,
          date: eventData.date,
          location: {
            city: eventData.city,
            state: eventData.state,
            country: eventData.country || 'US'
          },
          source,
          url: eventData.url.startsWith('http') ? eventData.url : 
               source === 'vividseats' ? `https://www.vividseats.com${eventData.url}` :
               `https://www.stubhub.com${eventData.url}`,
          tickets: [] as TicketData[]
        }));

      return events;
    } catch (error) {
      console.error(`Error searching ${source}:`, error);
      return [];
    }
  }

  private async processVividSeatsChunks(
    $: cheerio.Root,
    elementArray: cheerio.Element[],
    startIndex: number,
    chunkSize: number,
    eventId?: string
  ): Promise<TicketData[]> {
    try {
      // Get all listing containers
      const listingContainers = $('[data-testid="listings-container"] a');
      console.log(`Found ${listingContainers.length} listing containers in HTML`);
      
      const chunks: cheerio.Element[][] = [];
      
      // Split into chunks
      for (let i = 0; i < listingContainers.length; i += chunkSize) {
        chunks.push(listingContainers.slice(i, i + chunkSize).toArray());
      }

      console.log(`Processing ${listingContainers.length} tickets in ${chunks.length} chunks`);

      // If we have an eventId, first delete existing tickets for this source
      if (eventId) {
        console.log('Deleting existing tickets for event before processing new ones');
        const { error: deleteError } = await this.supabase
          .from('tickets')
          .delete()
          .eq('event_id', eventId)
          .eq('source', 'vividseats');

        if (deleteError) {
          console.error('Error deleting existing tickets:', deleteError);
          throw deleteError;
        }
      }

      const allTickets: TicketData[] = [];
      const processedListingIds = new Set<string>();

      // Process each chunk asynchronously
      const processChunk = async (chunk: cheerio.Element[], chunkIndex: number): Promise<TicketData[]> => {
        try {
          // Wrap each ticket element in a div with a data attribute for better parsing
          const wrappedHtml = chunk.map((el, i) => {
            const ticketHtml = $.html(el);
            return `<div data-ticket-index="${chunkIndex * chunkSize + i}">${ticketHtml}</div>`;
          }).join('\n');

          console.log(`Processing chunk ${chunkIndex + 1}, tickets ${chunkIndex * chunkSize + 1}-${Math.min((chunkIndex + 1) * chunkSize, listingContainers.length)}`);

          const response = await hf.textGeneration({
            model: 'mistralai/Mistral-7B-Instruct-v0.2',
            inputs: `<s>[INST]Extract ticket listings from HTML. Each ticket is wrapped in a div. For each ticket extract:
- section: The section name (e.g. "GA Main Floor", "GA Balcony", "GA4")
- row: The row number/letter (e.g. "G4", "12", "GA")
- price: The numeric price value
- quantity: The number of tickets available
- source: Always "vividseats"
- listing_id: The data-testid attribute value
- ticket_url: The href attribute from the anchor tag

Example output:
[{"section":"GA4","row":"G4","price":79,"quantity":1,"source":"vividseats","listing_id":"VB11556562645","ticket_url":"https://www.vividseats.com/poppy-tickets-chicago-house-of-blues-chicago-3-21-2025--concerts-pop/production/5369315?showDetails=VB11556562645"}]

HTML to extract from:
${wrappedHtml}[/INST]</s>`,
            parameters: {
              max_new_tokens: 4000,
              temperature: 0.1,
              do_sample: false,
              stop: ["</s>", "[INST]"]
            }
          });

          const responseText = response.generated_text.split('[/INST]</s>')[1];
          if (!responseText) {
            console.log(`No response text found after [/INST]</s> in chunk ${chunkIndex + 1}`);
            return [];
          }

          const cleanedResponse = responseText
            .replace(/\\\\/g, '\\')
            .replace(/\\"/g, '"')
            .replace(/\\n/g, ' ')
            .replace(/\\t/g, ' ')
            .replace(/\\_/g, '_')
            .replace(/[^\x20-\x7E]/g, '')
            .trim();

          // Try to find the last complete JSON object if response was truncated
          const jsonMatch = cleanedResponse.match(/\[\s*{[\s\S]*?}\s*\]/);
          let chunkTickets: TicketData[] = [];

          if (!jsonMatch) {
            // Try to find any complete JSON objects in the response
            const objectMatches = cleanedResponse.match(/{\s*"section"[\s\S]*?}/g);
            if (objectMatches) {
              try {
                chunkTickets = JSON.parse(`[${objectMatches.join(',')}]`);
              } catch (e) {
                console.error(`Error parsing individual tickets from chunk ${chunkIndex + 1}:`, e);
              }
            }
          } else {
            try {
              const parsed = JSON.parse(jsonMatch[0]);
              chunkTickets = Array.isArray(parsed) ? parsed : [parsed];
            } catch (error) {
              console.error(`Error parsing JSON from chunk ${chunkIndex + 1}:`, error);
            }
          }

          // Filter out duplicates by listing_id
          const uniqueTickets = chunkTickets.filter(ticket => {
            if (!ticket.listing_id || processedListingIds.has(ticket.listing_id)) {
              return false;
            }
            processedListingIds.add(ticket.listing_id);
            return true;
          });

          if (uniqueTickets.length > 0) {
            console.log(`Found ${uniqueTickets.length} tickets in chunk ${chunkIndex + 1}`);
            
            // Save tickets to database and update frontend immediately if we have an eventId
            if (eventId) {
              try {
                await this.saveTickets(eventId, uniqueTickets);
                await this.emitAllTickets(eventId);
              } catch (error) {
                console.error(`Error saving tickets from chunk ${chunkIndex + 1}:`, error);
              }
            }

            allTickets.push(...uniqueTickets);
          }

          return uniqueTickets;
        } catch (error) {
          console.error(`Error processing chunk ${chunkIndex + 1}:`, error);
          return [];
        }
      };

      // Process all chunks concurrently
      const chunkPromises = chunks.map((chunk, index) => processChunk(chunk, index));

      // Wait for all chunks to complete
      await Promise.all(chunkPromises);

      console.log(`Total unique tickets found: ${processedListingIds.size}`);
      return allTickets;
    } catch (error) {
      console.error('Error in processVividSeatsChunks:', error);
      return [];
    }
  }

  private async parseEventPage(html: string, source: string, eventId?: string) {
    try {
      // More accurate token estimation - HTML characters tend to encode to more tokens
      const estimatedTokens = Math.ceil(html.length / 2.5); // Conservative estimate
      const MAX_TOKENS = 22000; // Leave room for max_new_tokens and prompt

      if (source === 'vividseats' && estimatedTokens > MAX_TOKENS) {
        // For large VividSeats HTML, process in chunks
        console.log(`VividSeats HTML exceeds token limit (${estimatedTokens} estimated tokens), processing in chunks`);
        const $ = cheerio.load(html);
        const ticketElements = $('[data-testid="listings-container"]');
        const elementArray = ticketElements.toArray();
        const CHUNK_SIZE = 10;

        console.log(`Found ${elementArray.length} ticket elements to process in chunks of ${CHUNK_SIZE}`);
        const tickets = await this.processVividSeatsChunks($, elementArray, 0, CHUNK_SIZE, eventId);
        return { tickets };
      }

      // Use existing logic for small HTML or non-VividSeats sources
      const prompt = source === 'vividseats' ?
        `<s>[INST]Extract ticket listings from HTML as JSON array. Each ticket should be a JSON object with these fields:
- section: The section name (e.g. "GA", "Floor", "Balcony")
- row: The row number/letter (use "GA" for general admission)
- price: The numeric price value (e.g. 192)
- quantity: The number of tickets (e.g. "2" or range like "1-8")
- source: Always "vividseats"
- listing_id: The data-testid attribute value
- ticket_url: The href attribute from the anchor tag

Example output:
[{"section":"GA","row":"GA","price":192,"quantity":"1-8","source":"vividseats","listing_id":"VB11572186950","ticket_url":"https://www.vividseats.com/..."}]

Return only the JSON array, no explanations.

${html}[/INST]</s>` :
        `<s>[INST]Extract ticket listings from HTML as JSON array. Each ticket should be a JSON object with these fields:
- section: The section name (e.g. "Floor GA", "GA Standing")
- row: The row number/letter (use "GA" for general admission)
- price: The numeric price value (e.g. 123.45)
- quantity: The number of tickets (e.g. "2" or range like "1-4")
- source: Always "stubhub"
- listing_id: The data-listing-id attribute value
- ticket_url: The href attribute from the anchor tag

Example output:
[{"section":"Floor GA","row":"GA","price":123.45,"quantity":"2","source":"stubhub","listing_id":"123456","ticket_url":"https://www.stubhub.com/..."}]

Return only the JSON array, no explanations.

${html}[/INST]</s>`;

      const response = await hf.textGeneration({
        model: 'mistralai/Mistral-7B-Instruct-v0.2',
        inputs: prompt,
        parameters: { 
          max_new_tokens: 10000,
          temperature: 0.1,
          do_sample: false,
          stop: ["</s>", "[INST]"]
        }
      });

      let tickets: TicketData[];
      try {
        // Extract JSON array from response
        const responseText = response.generated_text.split('[/INST]</s>')[1];
        console.log('Raw response text:', responseText);

        // Clean up the response text
        const cleanedResponse = responseText
          .replace(/\[\s*\[/g, '[{')           // Convert [[ to [{
          .replace(/\]\s*\]/g, '}]')           // Convert ]] to }]
          .replace(/\\\\/g, '\\')              // Fix escaped backslashes
          .replace(/\\"/g, '"')                // Fix escaped quotes
          .replace(/\\n/g, ' ')                // Replace newlines
          .replace(/\\t/g, ' ')                // Replace tabs
          .replace(/\\_/g, '_')                // Fix escaped underscores
          .replace(/[^\x20-\x7E]/g, '')        // Remove non-printable chars
          .trim();

        // Try to find a valid JSON array in the cleaned response
        const jsonMatch = cleanedResponse.match(/\[\s*\{[\s\S]*?\}\s*\]/);
        if (!jsonMatch) {
          // If no object format found, try array format
          const arrayMatch = cleanedResponse.match(/\[\s*\[[\s\S]*?\]\s*\]/);
          if (arrayMatch) {
            // Convert array format to object format
            const arrayData = JSON.parse(arrayMatch[0]);
            if (Array.isArray(arrayData) && arrayData.length > 0 && Array.isArray(arrayData[0])) {
              const objectData = arrayData.map(([section, row, price, quantity, listing_id, ticket_url]) => ({
                section,
                row,
                price,
                quantity,
                source: source,
                listing_id,
                ticket_url
              }));
              tickets = objectData;
            } else {
              console.log('Invalid array format in response');
              return { tickets: [] };
            }
          } else {
            console.log('No valid JSON found in response');
            return { tickets: [] };
          }
        } else {
          try {
            const parsed = JSON.parse(jsonMatch[0]);
            tickets = Array.isArray(parsed) ? parsed : [parsed];
          } catch (e) {
            console.error('JSON parse error:', e);
            console.error('Failed to parse string:', jsonMatch[0]);
            return { tickets: [] };
          }
        }

        // Clean up and validate the data
        tickets = tickets.map(ticket => {
          // Convert quantity string to number (take the first number in a range)
          const quantityStr = ticket.quantity?.toString() || '1';
          const quantity = parseInt(quantityStr.split('-')[0]);

          // Clean up ticket URL if it's a relative path
          let ticketUrl = ticket.ticket_url || null;
          if (ticketUrl && !ticketUrl.startsWith('http')) {
            ticketUrl = source === 'vividseats' 
              ? `https://www.vividseats.com${ticketUrl}`
              : `https://www.stubhub.com${ticketUrl}`;
          }

          return {
            section: ticket.section || 'General Admission',
            row: ticket.row === 'NA' ? 'GA' : ticket.row || 'GA',
            price: parseFloat(ticket.price?.toString() || '0'),
            quantity: quantity,
            source: ticket.source || source,
            listing_id: ticket.listing_id || crypto.randomUUID(),
            ticket_url: ticketUrl
          };
        }).filter(ticket => 
          ticket.price > 0 && 
          ticket.section.length > 0
        );

        // Remove duplicates based on section, row, and price
        tickets = tickets.filter((ticket, index, self) =>
          index === self.findIndex((t) => (
            t.section === ticket.section &&
            t.row === ticket.row &&
            t.price === ticket.price
          ))
        );

        console.log(`Found ${tickets.length} tickets from ${source}`);
      } catch (e) {
        console.error('Failed to parse HF response:', e);
        return { tickets: [] };
      }

      return { tickets };
    } catch (error) {
      console.error(`Error parsing ${source} event page:`, error);
      return { tickets: [] };
    }
  }


  private filterEventsByLocation(events: GoogleSearchResult[], searchLocation: string): GoogleSearchResult[] {
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
        const tickets = tmEvent.priceRanges.flatMap((range: any) => ([
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
        ]));

        console.log('Saving tickets:', tickets);
        await this.saveTickets(eventId, tickets);
      } else {
        console.log('No price ranges found for event');
      }
    } catch (error) {
      console.error('Error processing Ticketmaster event:', error);
    }
  }

  private findBestEvent(events: GoogleSearchResult[]): GoogleSearchResult {
    return events.reduce((best, current) => {
      // Score each event based on information completeness
      const getEventScore = (event: GoogleSearchResult) => {
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
