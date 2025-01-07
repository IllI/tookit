import { EventEmitter } from 'events';
import { HfInference } from '@huggingface/inference';
import type { SearchParams, SearchResult } from '../types/api';
import type { Event, TicketData, EventData, SearchMetadata } from '@/lib/types/schemas';
import { createClient } from '@supabase/supabase-js';
import { config } from '@/src/config/env';
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

export class SearchService extends EventEmitter {
  private supabase;

  constructor() {
    super();
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.serviceKey || config.supabase.anonKey
    );
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
        throw deleteError;
      }

      // Then insert new tickets in batches to avoid conflicts
      const batchSize = 50;
      for (let i = 0; i < formattedTickets.length; i += batchSize) {
        const batch = formattedTickets.slice(i, i + batchSize);
        const { error: insertError } = await this.supabase
          .from('tickets')
          .insert(batch);

        if (insertError) {
          console.error('Database error saving tickets batch:', insertError);
          throw insertError;
        }
      }

      // Get all saved tickets
      const { data, error: selectError } = await this.supabase
        .from('tickets')
        .select()
        .eq('event_id', eventId)
        .eq('source', tickets[0]?.source);

      if (selectError) {
        console.error('Error fetching saved tickets:', selectError);
        throw selectError;
      }

      console.log('Successfully saved tickets to database:', data);
      return data;
    } catch (error) {
      console.error('Error saving tickets:', error);
      throw error;
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

  private async processEventPage(eventId: string, source: string, url: string) {
    try {
      this.emit('status', `Processing event page from ${source}...`);
      
      const html = await webReaderService.fetchPage(url);
      const result = await this.parseEventPage(html, source);
      
      if (result?.tickets?.length) {
        // Save to database first
        await this.saveTickets(eventId, result.tickets);
        console.log(`Saved ${result.tickets.length} tickets to database for event`);

        // Emit updated ticket list to frontend
        await this.emitAllTickets(eventId);
      }
    } catch (error) {
      console.error(`Error in processEventPage for ${source}:`, error);
      this.emit('error', `Error processing ${source} event page: ${error instanceof Error ? error.message : 'Unknown error'}`);
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
        
        for (const event of existingEvents) {
          for (const link of event.event_links) {
            this.emit('status', `Updating tickets for ${event.name} from ${link.source}...`);
            
            const html = await webReaderService.fetchPage(link.url);
            const result = await this.parseEventPage(html, link.source);
            
            if (result?.tickets) {
              // Save tickets to database
              await this.saveTickets(event.id, result.tickets);
              // Emit updated ticket list to frontend
              await this.emitAllTickets(event.id);
            }
          }
        }

        // Get all tickets for these events
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
            tickets: [], // This is needed for the EventData type but not used here
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
      this.emit('status', 'No existing events found. Starting new search...');
      const results: { data: EventData[]; metadata: { sources: string[] } } = {
        data: [],
        metadata: { sources: [] }
      };

      const searches = [];
      const searchQuery = params.location ? 
        `${params.keyword} ${params.location}` : 
        params.keyword;

      if (params.source === 'all' || params.source === 'stubhub') {
        const stubHubUrl = new URL('https://www.stubhub.com/secure/search');
        stubHubUrl.searchParams.set('q', searchQuery);
        searches.push(
          this.searchSite(stubHubUrl.toString(), 'stubhub', params)
            .catch(error => {
              this.emit('error', `StubHub search error: ${error.message}`);
              return [];
            })
        );
      }

      if (params.source === 'all' || params.source === 'vividseats') {
        const vividSeatsUrl = new URL('https://www.vividseats.com/search');
        vividSeatsUrl.searchParams.set('searchTerm', searchQuery);
        searches.push(
          this.searchSite(vividSeatsUrl.toString(), 'vividseats', params)
            .catch(error => {
              this.emit('error', `VividSeats search error: ${error.message}`);
              return [];
            })
        );
      }

      const searchResults = await Promise.all(searches);
      results.data = searchResults.flat();
      results.metadata.sources = Array.from(new Set(results.data.map(event => event.source!)));

      // Save new events and tickets to database
      if (results.data?.length) {
        for (const event of results.data) {
          const existingEvent = await this.findMatchingEvent(event);
          let eventId;

          if (existingEvent) {
            eventId = existingEvent.id;
            await this.addEventLink(eventId, event.source!, event.url!);
            // Immediately visit the event page after adding the link
            await this.processEventPage(eventId, event.source!, event.url!);
          } else {
            // Create new event
            const { data: newEvent } = await this.supabase
              .from('events')
              .insert({
                name: event.name,
                date: event.date,
                venue: event.venue,
                city: event.location?.city,
                state: event.location?.state,
                country: event.location?.country,
                created_at: new Date().toISOString()
              })
              .select()
              .single();

            if (newEvent) {
              eventId = newEvent.id;
              await this.addEventLink(eventId, event.source!, event.url!);
              // Immediately visit the event page after adding the link
              await this.processEventPage(eventId, event.source!, event.url!);
            }
          }

          // Save tickets if we have them
          if (eventId && event.tickets?.length) {
            await this.saveTickets(eventId, event.tickets);
          }
        }

        // Now get all tickets for the final response
        const eventIds = await Promise.all(results.data.map(async event => {
          const existingEvent = await this.findMatchingEvent(event);
          return existingEvent?.id;
        }));

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
          .in('event_id', eventIds.filter(id => id))
          .order('price');

        // Format tickets with event data for frontend
        const allTicketsWithEvent = tickets?.map((ticket: any) => {
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
            tickets: [], // This is needed for the EventData type but not used here
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

      return {
        success: true,
        data: [],
        metadata: { sources: [] }
      };

    } catch (error) {
      console.error('Search error:', error);
      throw error;
    }
  }

  private async searchSite(url: string, source: string, params: SearchParams): Promise<EventData[]> {
    this.emit('status', `Searching ${source}...`);
    console.log(`Fetching URL: ${url}`);
    
    try {
      // Get HTML from Jina Reader
      const html = await webReaderService.fetchPage(url);
      console.log(`Received HTML from ${source} (${html.length} bytes)`);

      try {
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
        try {
          // Find the last occurrence of a JSON array (after the HTML)
          const lastJsonMatch = response.generated_text.split('</body></html>')[1]?.match(/\[\s*{[\s\S]*}\s*\]/);
          const cleanedResponse = lastJsonMatch ? lastJsonMatch[0] : '[]';
          console.log('Cleaned response:', cleanedResponse);
          const parsed = JSON.parse(cleanedResponse);
          eventsData = Array.isArray(parsed) ? parsed : [parsed];
          console.log('Parsed event data:', eventsData);
        } catch (e) {
          console.error('Failed to parse HF response:', e);
          return [];
        }

        // Filter and convert events to EventData format
        const events = eventsData
          .filter(eventData => {
            // Skip obvious auxiliary events by checking venue
            if (eventData.venue.toLowerCase().includes('parking')) {
              return false;
            }

            const normalizedEventName = normalizeEventName(eventData.name);
            const normalizedKeyword = normalizeEventName(params.keyword);
            
            // Check if keyword is at the start of the name
            if (normalizedEventName.startsWith(normalizedKeyword)) {
              // Get the next word after the keyword
              const remainder = normalizedEventName
                .slice(normalizedKeyword.length)
                .trim()
                .split(/\s+/)[0];
              
              // Common words that indicate this is the main event
              const validConnectors = ['at', 'in', 'with', 'and', 'presents', '-'];
              return !remainder || validConnectors.includes(remainder);
            }

            return false;
          })
          .map(eventData => ({
            name: params.keyword, // Use the original search keyword as the normalized name
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
        console.error('HF API error:', error);
        throw error;
      }
    } catch (error) {
      console.error(`Error searching ${source}:`, error);
      throw error;
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
      const listingContainers = $('.styles_listingsList__xLDbK .styles_listingRowContainer__d8WLZ');
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

      // Process chunks sequentially to avoid database conflicts
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
          const chunkHtml = chunk.map(el => $.html(el)).join('\n');
          console.log(`Processing chunk ${i + 1}, tickets ${i * chunkSize + 1}-${Math.min((i + 1) * chunkSize, listingContainers.length)}`);

          const response = await hf.textGeneration({
            model: 'mistralai/Mistral-7B-Instruct-v0.2',
            inputs: `<s>[INST]You are a data extraction tool. Do not write code or explain anything. Only output a JSON array containing ticket data from this HTML.
Each ticket should have:
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
${chunkHtml}[/INST]</s>`,
            parameters: {
              max_new_tokens: 4000,
              temperature: 0.1,
              do_sample: false,
              stop: ["</s>", "[INST]"]
            }
          });

          const responseText = response.generated_text.split('[/INST]</s>')[1];
          if (!responseText) {
            console.log(`No response text found after [/INST]</s> in chunk ${i + 1}`);
            continue;
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
                console.error(`Error parsing individual tickets from chunk ${i + 1}:`, e);
              }
            }
          } else {
            try {
              const parsed = JSON.parse(jsonMatch[0]);
              chunkTickets = Array.isArray(parsed) ? parsed : [parsed];
            } catch (error) {
              console.error(`Error parsing JSON from chunk ${i + 1}:`, error);
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
            allTickets.push(...uniqueTickets);
            
            // Save this chunk's tickets if we have an eventId
            if (eventId) {
              try {
                await this.saveTickets(eventId, uniqueTickets);
                await this.emitAllTickets(eventId);
              } catch (error) {
                console.error(`Error saving tickets from chunk ${i + 1}:`, error);
              }
            }
          }
        } catch (error) {
          console.error(`Error processing chunk ${i + 1}:`, error);
        }
      }

      console.log(`Total unique tickets found: ${processedListingIds.size}`);
      return allTickets;
    } catch (error) {
      console.error('Error in processVividSeatsChunks:', error);
      return [];
    }
  }

  private async parseEventPage(html: string, source: string, eventId?: string) {
    try {
      // First check if HTML is small enough to process in one go
      const estimatedTokens = html.length / 4;
      const TOKEN_LIMIT = 32000;

      if (source === 'vividseats' && estimatedTokens > TOKEN_LIMIT) {
        // For large VividSeats HTML, process in chunks
        console.log('VividSeats HTML exceeds token limit, processing in chunks');
        const $ = cheerio.load(html);
        const ticketElements = $('a');
        const elementArray = ticketElements.toArray();
        const CHUNK_SIZE = 10;

        console.log(`Processing ${elementArray.length} tickets in chunks of ${CHUNK_SIZE}`);
        const tickets = await this.processVividSeatsChunks($, elementArray, 0, CHUNK_SIZE, eventId);
        return { tickets };
      }

      // Use existing logic for small HTML or non-VividSeats sources
      const prompt = source === 'vividseats' ?
        `<s>[INST]Extract ticket listings from HTML as JSON array. For VividSeats listings:
- Extract section name (e.g. "GA Main Floor", "GA Balcony", "GA4")
- Extract row number/letter after "Row" text
- Extract price as a number
- Extract quantity from text like "1-6 tickets" or "2 tickets"
- Extract ticket_url from the anchor tag href value
- Use the data-testid attribute as listing_id
Format: [{"section":"GA4","row":"G4","price":79,"quantity":1,"source":"vividseats","listing_id":"VB11556562645","ticket_url":"https://www.vividseats.com/poppy-tickets-chicago-house-of-blues-chicago-3-21-2025--concerts-pop/production/5369315?showDetails=VB11556562645"}]
Return only JSON array.

${html}[/INST]</s>` :
        `<s>[INST]Extract ticket listings from HTML as JSON array. For StubHub listings:
- Extract section from the section name text (e.g. "Floor GA", "GA Standing", etc)
- Extract row from the row text if available (e.g. "Row GA1", "GA", etc)
- Extract price as a number (e.g. 123.45)
- Extract quantity from text like "2 tickets available"
- Use the data-listing-id or similar attribute as listing_id
Format: [{"section":"Floor GA","row":"GA1","price":123.45,"quantity":2,"source":"stubhub","listing_id":"123456"}]
Return only JSON array.

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

        // Try to parse the response based on source
        let parsed;
        if (source === 'stubhub') {
          // StubHub format: [["section": "value", ...], [...]]
          // First clean up any escaped characters and normalize the format
          const cleanedResponse = responseText
            .replace(/\\_/g, '_')                             // Fix escaped underscores first
            .replace(/\\\\/g, '\\')                           // Fix double escaped backslashes
            .replace(/\\"/g, '"')                            // Fix escaped quotes
            .replace(/\\n/g, ' ')                            // Replace newlines with spaces
            .replace(/\\t/g, ' ')                            // Replace tabs with spaces
            .replace(/\[\s*\[/g, '[{')                       // Convert [[ to [{
            .replace(/\]\s*\]/g, '}]')                       // Convert ]] to }]
            .replace(/"\s*:\s*"/g, '":"')                    // Normalize "key":"value"
            .replace(/"\s*:\s*(\d+)/g, '":$1')              // Normalize "key":number
            .replace(/,\s*}/g, '}')                         // Remove trailing commas
            .replace(/,\s*]/g, ']')                         // Remove trailing commas in arrays
            .replace(/[^\x20-\x7E]/g, '')                   // Remove non-printable characters
            .trim();
          
          console.log('Cleaned StubHub response:', cleanedResponse);
          try {
            parsed = JSON.parse(cleanedResponse);
          } catch (e) {
            console.error('JSON parse error:', e);
            console.error('Failed to parse string:', cleanedResponse);
            throw e;
          }
        } else {
          // VividSeats format
          // First clean up any escaped characters
          const cleanedResponse = responseText
            .replace(/\\\\/g, '\\')                           // Fix double escaped backslashes
            .replace(/\\"/g, '"')                            // Fix escaped quotes
            .replace(/\\n/g, ' ')                            // Replace newlines with spaces
            .replace(/\\t/g, ' ')                            // Replace tabs with spaces
            .replace(/\\_/g, '_')                            // Fix escaped underscores
            .replace(/[^\x20-\x7E]/g, '')                    // Remove non-printable characters
            .trim();
            
          // Then find and parse the JSON array
          const jsonMatch = cleanedResponse.match(/\[\s*{[\s\S]*?}\s*\]/);
          if (!jsonMatch) {
            console.log('No JSON array found in response');
            return { tickets: [] };
          }
          
          console.log('VividSeats JSON:', jsonMatch[0]);
          try {
            parsed = JSON.parse(jsonMatch[0]);
          } catch (e) {
            console.error('JSON parse error:', e);
            console.error('Failed to parse string:', jsonMatch[0]);
            throw e;
          }
        }

        tickets = Array.isArray(parsed) ? parsed : [parsed];

        // Clean up and validate the data
        tickets = tickets.map(ticket => ({
          section: ticket.section || 'General Admission',
          row: ticket.row?.replace(/^Row\s+/i, '') || '',  // Remove 'Row ' prefix if present
          price: parseFloat(ticket.price?.toString() || '0'),
          quantity: parseInt(ticket.quantity?.toString() || '1'),
          source: ticket.source || source,
          listing_id: ticket.listing_id || crypto.randomUUID(),
          ticket_url: ticket?.ticket_url ? ticket.ticket_url : null,
        })).filter(ticket => 
          ticket.price > 0 && 
          ticket.quantity > 0 && 
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