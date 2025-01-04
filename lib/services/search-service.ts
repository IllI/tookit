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

    // Among venue/time matches, find the best name match using fuzzy logic
    const bestMatch = venueTimeMatches.reduce<DbEvent | null>((best, current) => {
      const similarity = calculateSimilarity(event.name, current.name);
      const bestSimilarity = best ? calculateSimilarity(event.name, best.name) : 0;

      return similarity > bestSimilarity ? current : best;
    }, null);

    // Return match if similarity is above threshold (0.6 is more lenient than 0.8)
    if (bestMatch && calculateSimilarity(event.name, bestMatch.name) >= 0.6) {
      console.log(`Found matching event: "${event.name}" matches "${bestMatch.name}" (${calculateSimilarity(event.name, bestMatch.name).toFixed(2)} similarity)`);
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
        created_at: new Date().toISOString()
      }));

      console.log('Saving tickets to database:', formattedTickets);
      const { data, error } = await this.supabase
        .from('tickets')
        .upsert(formattedTickets, {
          onConflict: 'event_id,section,row,listing_id'
        });

      if (error) {
        console.error('Database error saving tickets:', error);
        throw error;
      }

      console.log('Successfully saved tickets to database:', data);
      return data;
    } catch (error) {
      console.error('Error saving tickets:', error);
      throw error;
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
            }
          }
        }

        // Return updated tickets with full event data
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
            event:events (
              id,
              name,
              date,
              venue,
              city,
              state,
              country
            )
          `)
          .in('event_id', existingEvents.map(e => e.id))
          .order('price');

        // Format tickets for frontend
        const formattedTickets = (tickets as unknown as DbTicket[])?.map(ticket => ({
          id: ticket.id,
          name: ticket.event.name,
          date: ticket.event.date,
          venue: ticket.event.venue,
          location: {
            city: ticket.event.city,
            state: ticket.event.state,
            country: ticket.event.country
          },
          tickets: [], // Add empty tickets array to match EventData type
          price: ticket.price,
          section: ticket.section,
          row: ticket.row,
          quantity: ticket.quantity,
          source: ticket.source,
          listing_id: ticket.listing_id
        })) || [];

        const metadata: SearchMetadata = {
          sources: [params.source || 'all']
        };

        return {
          success: true,
          data: formattedTickets as EventData[],
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
      }

      return {
        success: true,
        data: results.data,
        metadata: results.metadata
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
            // Normalize event name and search keyword for comparison
            const normalizedEventName = eventData.name.toLowerCase().trim();
            const normalizedKeyword = params.keyword.toLowerCase().trim();
            
            // Only include exact matches for the artist name
            return normalizedEventName === normalizedKeyword || 
                   normalizedEventName === normalizedKeyword + ' concert' ||
                   normalizedEventName === normalizedKeyword + ' live';
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
        console.error('HF API error:', error);
        throw error;
      }
    } catch (error) {
      console.error(`Error searching ${source}:`, error);
      throw error;
    }
  }

  private async parseEventPage(html: string, source: string) {
    try {
      const response = await hf.textGeneration({
        model: 'mistralai/Mistral-7B-Instruct-v0.2',
        inputs: `<s>[INST]Extract ticket listings from HTML as JSON array. Format: [{"section":"section name","row":"row name","price":123.45,"quantity":2,"source":"${source}","listing_id":"unique id"}]. Return only JSON array.

${html}[/INST]</s>`,
        parameters: {
          max_new_tokens: 1000,
          temperature: 0.1,
          do_sample: false,
          stop: ["</s>", "[INST]"]
        }
      });

    //  console.log('Raw HF response:', response.generated_text);
      let tickets: TicketData[];
      try {
        // Find the last occurrence of a JSON array (after the HTML)
        const lastJsonMatch = response.generated_text.split('</body></html>')[1]?.match(/\[\s*{[\s\S]*}\s*\]/);
        const cleanedResponse = lastJsonMatch ? lastJsonMatch[0].replace(/\\_/g, '_') : '[]';
        console.log('Cleaned response:', cleanedResponse);
        const parsed = JSON.parse(cleanedResponse);
        tickets = Array.isArray(parsed) ? parsed : [parsed];
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

  // Add new method to handle event page processing
  private async processEventPage(eventId: string, source: string, url: string) {
    try {
      this.emit('status', `Processing event page from ${source}...`);
      
      const html = await webReaderService.fetchPage(url);
      const result = await this.parseEventPage(html, source);
      
      if (result?.tickets?.length) {
        // Get the full event data to include with tickets
        const { data: event, error: eventError } = await this.supabase
          .from('events')
          .select(`
            id,
            name,
            date,
            venue,
            city,
            state,
            country
          `)
          .eq('id', eventId)
          .single();

        if (eventError) {
          console.error('Error fetching event:', eventError);
          return;
        }

        if (event) {
          // Save to database first
          await this.saveTickets(eventId, result.tickets);
          console.log(`Saved ${result.tickets.length} tickets to database for event ${event.name}`);

          // Format tickets with event data for frontend
          const ticketsWithEvent = result.tickets.map(ticket => ({
            id: crypto.randomUUID(), // Generate a unique ID for the frontend
            name: event.name,
            date: event.date,
            venue: event.venue,
            location: {
              city: event.city,
              state: event.state,
              country: event.country
            },
            price: parseFloat(ticket.price.toString()),
            section: ticket.section || '',
            row: ticket.row || '',
            quantity: parseInt(ticket.quantity?.toString() || '1'),
            source: ticket.source,
            listing_id: ticket.listing_id || crypto.randomUUID()
          }));

          // Then emit to frontend
          this.emit('tickets', ticketsWithEvent);
          console.log(`Emitted ${ticketsWithEvent.length} tickets to frontend for event ${event.name}`);
        }
      }
    } catch (error) {
      console.error(`Error in processEventPage for ${source}:`, error);
      this.emit('error', `Error processing ${source} event page: ${error instanceof Error ? error.message : 'Unknown error'}`);
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

function calculateSimilarity(str1: string, str2: string): number {
  const normalized1 = normalizeEventName(str1);
  const normalized2 = normalizeEventName(str2);
  const maxLength = Math.max(normalized1.length, normalized2.length);
  const distance = levenshteinDistance(normalized1, normalized2);
  return (maxLength - distance) / maxLength;
}

function levenshteinDistance(a: string, b: string): number {
  const matrix = Array(b.length + 1).fill(null).map(() => Array(a.length + 1).fill(null));

  for (let i = 0; i <= a.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= b.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= b.length; j++) {
    for (let i = 1; i <= a.length; i++) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,                   // deletion
        matrix[j - 1][i] + 1,                   // insertion
        matrix[j - 1][i - 1] + substitutionCost // substitution
      );
    }
  }

  return matrix[b.length][a.length];
}

export const searchService = new SearchService(); 