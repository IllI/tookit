import { EventEmitter } from 'events';
import StubHubSearcher from '@/src/stub-hub';
import VividSeatsSearcher from '@/src/vivid-seats';
import type { SearchParams } from '@/lib/types/api';
import { crawlerService } from '@/src/services/crawler-service';
import { createClient } from '@supabase/supabase-js';
import { config } from '@/src/config/env';

export class SearchService extends EventEmitter {
  private supabase;
  private processedEvents = new Map(); // Track processed events
  
  constructor() {
    super();
    crawlerService.setSearchService(this);
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.serviceKey || config.supabase.anonKey
    );
  }

  // Helper to safely parse dates
  private parseDateSafely(dateStr: string): Date {
    try {
      const date = new Date(dateStr);
      // Check if date is valid
      if (isNaN(date.getTime())) {
        throw new Error('Invalid date');
      }
      return date;
    } catch (error) {
      console.error('Date parsing error:', error);
      return new Date(); // Return current date as fallback
    }
  }

  // Helper to track processed events
  private async trackEvent(event: any, source: string) {
    const eventKey = `${event.venue}-${event.name}-${event.date}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    console.log('Checking event:', {
      key: eventKey,
      alreadyProcessed: this.processedEvents.has(eventKey),
      source: source
    });
    
    if (!this.processedEvents.has(eventKey)) {
      // First time seeing this event
      const { data: existingEvents, error } = await this.supabase
        .from('events')
        .select(`
          id,
          name,
          date,
          venue,
          event_links(
            source,
            url
          )
        `)
        .ilike('venue', `%${event.venue}%`)
        .gte('date', new Date(this.parseDateSafely(event.date).getTime() - (24 * 60 * 60 * 1000)).toISOString())
        .lte('date', new Date(this.parseDateSafely(event.date).getTime() + (24 * 60 * 60 * 1000)).toISOString());

      if (error) {
        console.error('Error checking for existing event:', error);
        return null;
      }

      console.log('Found potential matches:', existingEvents?.length || 0);

      const matchingEvent = existingEvents?.find(existing => {
        const normalizedExistingName = existing.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const normalizedNewName = event.name.toLowerCase().replace(/[^a-z0-9]/g, '');
        const nameMatch = normalizedExistingName.includes(normalizedNewName) || 
                         normalizedNewName.includes(normalizedExistingName);
        
        if (nameMatch) {
          console.log('Found name match:', {
            existing: existing.name,
            new: event.name,
            venue: existing.venue,
            date: existing.date
          });
        }
        
        return nameMatch;
      });

      if (matchingEvent) {
        console.log('Tracking existing event:', {
          id: matchingEvent.id,
          name: matchingEvent.name,
          existingLinks: matchingEvent.event_links.map(link => link.source)
        });
        
        this.processedEvents.set(eventKey, {
          id: matchingEvent.id,
          links: new Set(matchingEvent.event_links.map(link => link.source))
        });
      } else {
        console.log('No matching event found in database');
      }
    } else {
      console.log('Event already tracked:', {
        key: eventKey,
        trackedInfo: this.processedEvents.get(eventKey)
      });
    }

    return this.processedEvents.get(eventKey);
  }

  async searchAll(params: SearchParams) {
    this.emit('status', 'Initializing search...');

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

      // If we found existing events, update their tickets and return
      if (existingEvents?.length) {
        this.emit('status', `Found ${existingEvents.length} existing events. Updating tickets...`);
        
        try {
          for (const event of existingEvents) {
            for (const link of event.event_links) {
              this.emit('status', `Updating tickets for ${event.name} from ${link.source}...`);
              
              // Get current tickets from source
              await crawlerService.crawlPage({
                url: link.url,
                eventId: event.id
              });
            }
          }

          // After updating tickets, fetch all current tickets
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
              event:events!inner(
                id,
                name,
                date,
                venue,
                event_links!inner(
                  source,
                  url
                )
              )
            `)
            .order('price');

          if (error) throw error;

          // Format and return the tickets
          const formattedTickets = tickets?.map(ticket => {
            const eventLink = ticket.event?.event_links?.find(
              link => link.source === ticket.source
            );

            return {
              ...ticket,
              price: parseFloat(ticket.price) || 0,
              event: ticket.event ? {
                ...ticket.event,
                date: ticket.event.date ? new Date(ticket.event.date).toLocaleString() : 'Date TBD',
                url: eventLink?.url
              } : null
            };
          }) || [];

          this.emit('status', `Found ${formattedTickets.length} total tickets`);
          this.emit('tickets', formattedTickets);
          
          return {
            success: true,
            data: formattedTickets,
            metadata: { totalTickets: formattedTickets.length }
          };
        } finally {
          // await crawlerService.cleanup();
        }
      }

      // If no existing events found, proceed with new search
      this.emit('status', 'No existing events found. Starting new search...');
      
      // Run new searches
      this.emit('status', 'Searching for new events...');
      const combinedQuery = [params.keyword, params.location].filter(Boolean).join(' ');

      // Collect all search results with explicit source identification
      const [stubHubResults, vividSeatsResults] = await Promise.all([
        crawlerService.asyncCrawlSearch(
          `https://www.stubhub.com/secure/search?q=${encodeURIComponent(combinedQuery)}`,
          {
            formats: ['markdown', 'html', 'links', 'extract'],
            includeTags: ['[data-testid="primaryGrid"] a'],
            extract: {
              prompt: 'Find all events that match the search query ' + combinedQuery +
                ' and return ONLY a raw JSON object. No explanations, no notes, no markdown. Return only valid JSON matching this structure: ' +
                `{
          "events": [
            {
              "name": string,
              "date": string (format: "YYYY-MM-DDTHH:mm:ssZ"),
              "venue": string,
              "city": string,
              "state": string,
              "country": string,
              "location": string,
              "price": string (optional),
              "eventUrl": string (must be the exact href value from the event's <a> tag, including domain)
            }
          ]
        }`
            }
          }
        ).then(result => ({ ...result, source: 'stubhub' })),
        crawlerService.asyncCrawlSearch(
          `https://www.vividseats.com/search?searchTerm=${encodeURIComponent(combinedQuery)}`,
          {
            formats: ['markdown', 'html', 'links', 'extract'],
            includeTags: ['[data-testid="productions-list"] a'],
            extract: {
              prompt: 'Find all events that match the search query ' + combinedQuery +
                ' and return ONLY a raw JSON object. No explanations, no notes, no markdown. Return only valid JSON matching this structure: ' +
                `{
          "events": [
            {
              "name": string,
              "date": string (format: "YYYY-MM-DDTHH:mm:ssZ"),
              "venue": string,
              "city": string,
              "state": string,
              "country": string,
              "location": string,
              "price": string (optional),
              "eventUrl": string (must be the exact href value from the event's <a> tag, including domain)
            }
          ]
        }`
            }
          }
        ).then(result => ({ ...result, source: 'vividseats' }))
      ]);

      // Insert new events into database
      for (const result of [stubHubResults, vividSeatsResults]) {
        console.log(`Processing events from source: ${result.source}`);
        for (const event of result.events) {
          try {
            // Skip parking events
            if (event.name.toLowerCase().includes('parking')) {
              console.log('Skipping parking event:', event.name);
              continue;
            }

            // Check if we've processed this event before
            const trackedEvent = await this.trackEvent(event, result.source);

            if (trackedEvent) {
              // Event exists, check if we need to add the source link
              if (!trackedEvent.links.has(result.source)) {
                console.log(`Adding ${result.source} link to existing event:`, trackedEvent.id);
                const { error: linkError } = await this.supabase
                  .from('event_links')
                  .insert({
                    event_id: trackedEvent.id,
                    source: result.source,
                    url: event.eventUrl
                  });

                if (linkError) {
                  console.error(`Error adding ${result.source} link:`, linkError);
                } else {
                  console.log(`Successfully added ${result.source} link to event ${trackedEvent.id}`);
                  trackedEvent.links.add(result.source);
                }
              }

              // Crawl for tickets
             // await crawlerService.asyncCrawlEvent(event.eventUrl, { id: trackedEvent.id });

            } else {
              // Create new event
              console.log('Creating new event:', {
                name: event.name,
                venue: event.venue,
                date: event.date
              });

              const { data: newEvent, error: insertError } = await this.supabase
                .from('events')
                .insert({
                  name: event.name,
                  date: this.parseDateSafely(event.date),
                  venue: event.venue,
                  city: event.city,
                  state: event.state,
                  country: event.country || 'USA'
                })
                .select()
                .single();

              if (insertError) {
                console.error('Error inserting event:', insertError);
                continue;
              }

              if (newEvent) {
                // Add to tracked events
                this.processedEvents.set(
                  `${event.venue}-${event.name}-${event.date}`.toLowerCase().replace(/[^a-z0-9]/g, ''),
                  {
                    id: newEvent.id,
                    links: new Set([result.source])
                  }
                );

                // Add event link
                await this.supabase
                  .from('event_links')
                  .insert({
                    event_id: newEvent.id,
                    source: result.source,
                    url: event.eventUrl
                  });

                // Crawl for tickets
               //await crawlerService.asyncCrawlEvent(event.eventUrl, { id: newEvent.id });
              }
            }

          } catch (error) {
            console.error('Error processing event:', error);
          }
        }
      }

      // After all searches complete, fetch all tickets from database
      this.emit('status', 'Fetching final ticket list...');

      // First get matching event IDs
      const { data: matchingEvents } = await this.supabase
        .from('events')
        .select('id')
        .ilike('name', `%${params.keyword}%`)
        .gte('date', new Date().toISOString());

      const eventIds = matchingEvents?.map(e => e.id) || [];

      // Then get tickets for those events
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
          event:events!inner(
            id,
            name,
            date,
            venue,
            event_links!inner(
              source,
              url
            )
          )
        `)
        .in('event_id', eventIds)  // Filter by the event IDs we found
        .order('price');

      if (error) {
        throw error;
      }

      // Format ticket data
      const formattedTickets = tickets?.map(ticket => {
        // Find the matching event link for the ticket's source
        const eventLink = ticket.event?.event_links?.find(
          link => link.source === ticket.source
        );

        return {
          ...ticket,
          price: parseFloat(ticket.price) || 0,
          event: ticket.event ? {
            ...ticket.event,
            date: ticket.event.date ? new Date(ticket.event.date).toLocaleString() : 'Date TBD',
            url: eventLink?.url
          } : null
        };
      }) || [];

      if (formattedTickets.length > 0) {
        this.emit('status', `Found ${formattedTickets.length} total tickets`);
        this.emit('tickets', formattedTickets);
        
        return {
          success: true,
          data: formattedTickets,
          metadata: { totalTickets: formattedTickets.length }
        };
      }

      this.emit('status', 'No tickets found');
      return {
        success: true,
        data: [],
        metadata: { totalTickets: 0 }
      };

    } catch (error) {
      this.emit('error', error instanceof Error ? error.message : 'Search failed');
      throw error;
    } finally {
      // await crawlerService.cleanup();
    }
  }

  // private async searchStubHub(params: SearchParams) {
  //   // Remove old StubHub search implementation
  // }

  // private async searchVividSeats(params: SearchParams) {
  //   // Remove old VividSeats search implementation
  // }
} 