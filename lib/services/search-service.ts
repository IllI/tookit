import { EventEmitter } from 'events';
import type { SearchParams, SearchResult } from '../types/api';
import type { Event } from '@/lib/types/schemas';
import { createClient } from '@supabase/supabase-js';
import { config } from '@/src/config/env';
import { scraperService } from '@/src/lib/scraper';

export class SearchService extends EventEmitter {
  private supabase;

  constructor() {
    super();
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.serviceKey || config.supabase.anonKey
    );
  }

  async findMatchingEvent(event: Event) {
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
    const bestMatch = venueTimeMatches.reduce((best, current) => {
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

  async saveTickets(eventId: string, tickets: any[]) {
    try {
      for (const ticket of tickets) {
        await this.supabase
          .from('tickets')
          .upsert({
            event_id: eventId,
            section: ticket.section,
            row: ticket.row,
            price: ticket.price?.amount || 0,
            quantity: ticket.quantity,
            source: ticket.source,
            listing_id: ticket.listingId,
            created_at: new Date().toISOString()
          }, {
            onConflict: 'event_id,section,row,listing_id'
          });
      }
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
            
            const result = await scraperService.crawlPage({ url: link.url });
            if (result?.parsedContent?.tickets) {
              // Save tickets to database
              await this.saveTickets(event.id, result.parsedContent.tickets);
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
        const formattedTickets = tickets?.map(ticket => ({
          id: ticket.id,
          name: ticket.event.name,
          date: ticket.event.date,
          venue: ticket.event.venue,
          location: {
            city: ticket.event.city,
            state: ticket.event.state,
            country: ticket.event.country
          },
          price: {
            amount: ticket.price,
            currency: 'USD'
          },
          section: ticket.section,
          row: ticket.row,
          quantity: ticket.quantity,
          source: ticket.source,
          listingId: ticket.listing_id
        })) || [];

        return {
          success: true,
          data: formattedTickets,
          metadata: { totalTickets: formattedTickets.length }
        };
      }

      // If no existing events, run new searches
      this.emit('status', 'No existing events found. Starting new search...');
      const results = await scraperService.search(params);
      
      // Save new events and tickets to database
      if (results.data?.length) {
        for (const event of results.data) {
          const existingEvent = await this.findMatchingEvent(event);
          let eventId;

          if (existingEvent) {
            eventId = existingEvent.id;
            await this.addEventLink(eventId, event.source, event.url);
          } else {
            // Create new event
            const { data: newEvent } = await this.supabase
              .from('events')
              .insert({
                name: event.name,
                date: event.date,
                venue: event.venue,
                city: event.location.city,
                state: event.location.state,
                country: event.location.country,
                created_at: new Date().toISOString()
              })
              .select()
              .single();

            if (newEvent) {
              eventId = newEvent.id;
              await this.addEventLink(eventId, event.source, event.url);
            }
          }

          // Save tickets if we have them
          if (eventId && event.tickets?.length) {
            for (const ticket of event.tickets) {
              await this.supabase
                .from('tickets')
                .upsert({
                  event_id: eventId,
                  section: ticket.section,
                  row: ticket.row,
                  price: ticket.price,
                  quantity: ticket.quantity,
                  source: event.source,
                  listing_id: ticket.listing_id,
                  created_at: new Date().toISOString()
                }, {
                  onConflict: 'event_id,section,row,listing_id'
                });
            }
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
}

// Helper functions
function normalizeEventName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '') // Remove special characters
    .replace(/\s+/g, ' ')        // Normalize spaces
    .trim();
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

function calculateSimilarity(str1: string, str2: string): number {
  const normalized1 = normalizeEventName(str1);
  const normalized2 = normalizeEventName(str2);
  const maxLength = Math.max(normalized1.length, normalized2.length);
  const distance = levenshteinDistance(normalized1, normalized2);
  return (maxLength - distance) / maxLength;
}

export const searchService = new SearchService(); 