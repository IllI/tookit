import StubHubSearcher from '@/src/stub-hub';
import VividSeatsSearcher from '@/src/vivid-seats';
import { createClient } from '@supabase/supabase-js';
import { config } from '@/src/config/env';
import type { SearchParams, SearchResult, Event, Ticket, TicketSource } from '../types/api';
import { findMatchingEvent } from '@/src/event-utils';
import { logger } from '../utils/logger';
import { parse } from 'date-fns';

export class SearchService {
  private supabase;
  private stubHubSearcher: StubHubSearcher;
  private vividSeatsSearcher: VividSeatsSearcher;

  constructor() {
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.serviceKey
    );
    this.stubHubSearcher = new StubHubSearcher();
    this.vividSeatsSearcher = new VividSeatsSearcher();
  }

  async searchAll(params: SearchParams): Promise<SearchResult> {
    try {
      const searchStartTime = new Date();
      let searchCompleted = false;
      let searchTimeout: NodeJS.Timeout;

      // Get existing events first
      const { data: existingEvents } = await this.supabase
        .from('events')
        .select(`
          *,
          event_links (*),
          tickets (*)
        `)
        .ilike('name', `%${params.keyword || params.artist}%`)
        .gte('date', new Date().toISOString());

      logger.info('Found existing events:', existingEvents?.length || 0);

      // Create a promise that rejects after timeout
      const timeoutPromise = new Promise((_, reject) => {
        searchTimeout = setTimeout(() => {
          reject(new Error('Search timeout'));
        }, 60000); // 60 second timeout
      });

      // Run searches with timeout
      const searches = [];
      const sources: Record<string, TicketSource> = {};

      if (params.source === 'all' || params.source === 'stubhub') {
        searches.push(
          this.searchStubHub(params)
            .then(results => {
              sources.stubhub = { 
                isLive: true, 
                lastUpdated: searchStartTime.toISOString() 
              };
              return results;
            })
            .catch(error => {
              logger.error('StubHub search error:', error);
              sources.stubhub = {
                isLive: false,
                lastUpdated: existingEvents?.find(e => 
                  e.event_links.some(l => l.source === 'stubhub')
                )?.updated_at || searchStartTime.toISOString(),
                error: error.message
              };
              return existingEvents?.filter(e => 
                e.event_links.some(l => l.source === 'stubhub')
              ) || [];
            })
        );
      }

      if (params.source === 'all' || params.source === 'vividseats') {
        searches.push(
          this.searchVividSeats(params)
            .then(results => {
              sources.vividseats = { 
                isLive: true, 
                lastUpdated: searchStartTime.toISOString() 
              };
              return results;
            })
            .catch(error => {
              logger.error('VividSeats search error:', error);
              sources.vividseats = {
                isLive: false,
                lastUpdated: existingEvents?.find(e => 
                  e.event_links.some(l => l.source === 'vividseats')
                )?.updated_at || searchStartTime.toISOString(),
                error: error.message
              };
              return existingEvents?.filter(e => 
                e.event_links.some(l => l.source === 'vividseats')
              ) || [];
            })
        );
      }

      // Wait for all searches or timeout
      const results = await Promise.race([
        Promise.all(searches),
        timeoutPromise
      ]).finally(() => {
        clearTimeout(searchTimeout);
        searchCompleted = true;
      });

      // Combine and deduplicate results
      const eventMap = new Map<string, Event>();
      results.flat().forEach(event => {
        const key = `${event.name}-${event.date}-${event.venue}`;
        if (!eventMap.has(key) || event.tickets?.length > (eventMap.get(key)?.tickets?.length || 0)) {
          eventMap.set(key, event);
        }
      });

      const combinedResults = Array.from(eventMap.values());

      logger.info('Search completed', {
        totalResults: combinedResults.length,
        sources: Object.keys(sources)
      });

      return {
        success: true,
        data: combinedResults,
        metadata: {
          total: combinedResults.length,
          sources
        }
      };
    } catch (error) {
      logger.error('Search error:', error);
      return {
        success: false,
        error: 'Failed to perform search',
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }

  private async storeEvent(event: any): Promise<Event | null> {
    try {
      // Check for existing event
      const matchingEvent = await findMatchingEvent(
        this.supabase,
        {
          name: event.name || event.title,
          date: event.date,
          venue: event.venue
        },
        event.source
      );

      if (matchingEvent) {
        logger.info(`Found matching event: ${matchingEvent.name}`);
        
        // Add source-specific link if it doesn't exist
        if (!matchingEvent.hasSourceLink) {
          const { error: linkError } = await this.supabase
            .from('event_links')
            .insert({
              event_id: matchingEvent.id,
              source: event.source,
              url: event.link
            });

          if (linkError) {
            logger.error('Error inserting event link:', linkError);
          }
        }

        // Insert new tickets
        if (event.tickets?.sections) {
          const tickets = this.transformTickets(matchingEvent.id, event);
          const { error: ticketError } = await this.supabase
            .from('tickets')
            .insert(tickets);

          if (ticketError) {
            logger.error('Error inserting tickets:', ticketError);
          }
        }

        // Return updated event data
        const { data: updatedEvent } = await this.supabase
          .from('events')
          .select(`
            *,
            event_links (*),
            tickets (*)
          `)
          .eq('id', matchingEvent.id)
          .single();

        return updatedEvent;
      }

      // Insert new event
      const { data: newEvent, error: eventError } = await this.supabase
        .from('events')
        .insert({
          name: event.name || event.title,
          type: event.type || 'Concert',
          category: event.category || 'Concert',
          date: new Date(event.date).toISOString(),
          venue: event.venue
        })
        .select()
        .single();

      if (eventError || !newEvent) {
        logger.error('Error inserting event:', eventError);
        return null;
      }

      // Insert event link
      await this.supabase
        .from('event_links')
        .insert({
          event_id: newEvent.id,
          source: event.source,
          url: event.link
        });

      // Insert tickets
      if (event.tickets?.sections) {
        const tickets = this.transformTickets(newEvent.id, event);
        await this.supabase
          .from('tickets')
          .insert(tickets);
      }

      // Return complete event data
      const { data: completeEvent } = await this.supabase
        .from('events')
        .select(`
          *,
          event_links (*),
          tickets (*)
        `)
        .eq('id', newEvent.id)
        .single();

      return completeEvent;
    } catch (error) {
      logger.error('Error storing event:', error);
      return null;
    }
  }

  private transformTickets(eventId: string, event: any): any[] {
    return event.tickets.sections.flatMap((section: any) =>
      section.tickets.map((ticket: any) => ({
        event_id: eventId,
        price: ticket.rawPrice,
        section: section.section,
        row: ticket.row,
        quantity: parseInt(ticket.quantity) || 1,
        source: event.source,
        url: ticket.listingUrl || ticket.url,
        listing_id: ticket.listingId,
        raw_data: ticket
      }))
    );
  }

  private async searchStubHub(params: SearchParams): Promise<Event[]> {
    try {
      const rawEvents = await this.stubHubSearcher.searchConcerts(
        params.artist || params.keyword || '',
        params.venue || '',
        params.location || ''
      );

      logger.info(`Found ${rawEvents.length} StubHub events`);

      // Process each event sequentially to avoid race conditions
      const storedEvents = [];
      for (const event of rawEvents) {
        try {
          // Parse the date string properly
          const dateRegex = /([A-Za-z]+)\s+(\d+)\s+(\d{4}).*?(\d+:\d+\s*[AP]M)/i;
          const match = event.date.match(dateRegex);
          
          if (!match) {
            logger.error('Failed to parse StubHub date:', event.date);
            continue;
          }

          const [_, month, day, year, time] = match;
          const standardDateStr = `${month} ${day} ${year} ${time}`;
          const parsedDate = parse(standardDateStr, 'MMM d yyyy h:mm a', new Date());

          if (isNaN(parsedDate.getTime())) {
            logger.error('Invalid date after parsing:', standardDateStr);
            continue;
          }

          // Check for existing event
          const matchingEvent = await findMatchingEvent(
            this.supabase,
            {
              name: event.name,
              date: parsedDate.toISOString(),
              venue: event.venue
            },
            'stubhub'
          );

          if (matchingEvent) {
            logger.info(`Found matching event for StubHub: ${matchingEvent.name}`);
            
            // Add StubHub link if it doesn't exist
            if (!matchingEvent.hasSourceLink) {
              const { error: linkError } = await this.supabase
                .from('event_links')
                .insert({
                  event_id: matchingEvent.id,
                  source: 'stubhub',
                  url: event.link
                });

              if (linkError) {
                logger.error('Error inserting StubHub link:', linkError);
              } else {
                logger.info('Added StubHub link to existing event');
              }
            }

            // Insert or update tickets
            if (event.tickets?.sections) {
              const tickets = this.transformTickets(matchingEvent.id, {
                ...event,
                source: 'stubhub'
              });

              if (tickets.length > 0) {
                const { error: ticketError } = await this.supabase
                  .from('tickets')
                  .insert(tickets);

                if (ticketError) {
                  logger.error('Error inserting StubHub tickets:', ticketError);
                } else {
                  logger.info(`Inserted ${tickets.length} StubHub tickets`);
                }
              }
            }

            // Get updated event data
            const { data: updatedEvent } = await this.supabase
              .from('events')
              .select(`
                *,
                event_links (*),
                tickets (*)
              `)
              .eq('id', matchingEvent.id)
              .single();

            if (updatedEvent) {
              storedEvents.push(updatedEvent);
            }
          } else {
            // Insert new event
            const { data: newEvent, error: eventError } = await this.supabase
              .from('events')
              .insert({
                name: event.name,
                type: 'Concert',
                category: event.category || 'Concert',
                date: parsedDate.toISOString(),
                venue: event.venue
              })
              .select()
              .single();

            if (eventError) {
              logger.error('Error inserting new StubHub event:', eventError);
              continue;
            }

            logger.info(`Created new event: ${newEvent.name}`);

            // Insert StubHub link
            const { error: linkError } = await this.supabase
              .from('event_links')
              .insert({
                event_id: newEvent.id,
                source: 'stubhub',
                url: event.link
              });

            if (linkError) {
              logger.error('Error inserting new StubHub link:', linkError);
            }

            // Insert tickets
            if (event.tickets?.sections) {
              const tickets = this.transformTickets(newEvent.id, {
                ...event,
                source: 'stubhub'
              });

              if (tickets.length > 0) {
                const { error: ticketError } = await this.supabase
                  .from('tickets')
                  .insert(tickets);

                if (ticketError) {
                  logger.error('Error inserting new StubHub tickets:', ticketError);
                } else {
                  logger.info(`Inserted ${tickets.length} new StubHub tickets`);
                }
              }
            }

            // Get complete event data
            const { data: completeEvent } = await this.supabase
              .from('events')
              .select(`
                *,
                event_links (*),
                tickets (*)
              `)
              .eq('id', newEvent.id)
              .single();

            if (completeEvent) {
              storedEvents.push(completeEvent);
            }
          }
        } catch (error) {
          logger.error('Error processing StubHub event:', error);
        }
      }

      logger.info(`Successfully stored ${storedEvents.length} StubHub events`);
      return storedEvents;
    } catch (error) {
      logger.error('StubHub search error:', error);
      return [];
    }
  }

  private async searchVividSeats(params: SearchParams): Promise<Event[]> {
    let browser = null;
    try {
      const rawEvents = await this.vividSeatsSearcher.searchConcerts(
        params.artist || params.keyword || '',
        params.venue || '',
        params.location || ''
      );

      logger.info(`Found ${rawEvents.length} VividSeats events`);

      // Process each event sequentially to avoid race conditions
      const storedEvents = [];
      for (const event of rawEvents) {
        try {
          // Parse VividSeats date format
          const dateRegex = /([A-Za-z]+)\s+(\d+)\s+[A-Za-z]+\s+(\d+:\d+[ap]m)/i;
          const match = event.date.match(dateRegex);
          
          if (!match) {
            logger.error('Failed to parse VividSeats date:', event.date);
            continue;
          }

          const [_, month, day, time] = match;
          const year = '2025'; // Default to 2025 for future dates
          const standardDateStr = `${month} ${day} ${year} ${time}`;
          const parsedDate = parse(standardDateStr, 'MMM d yyyy h:mma', new Date());

          if (isNaN(parsedDate.getTime())) {
            logger.error('Invalid date after parsing:', standardDateStr);
            continue;
          }

          // Check for existing event
          const matchingEvent = await findMatchingEvent(
            this.supabase,
            {
              name: event.title,
              date: parsedDate.toISOString(),
              venue: event.venue
            },
            'vividseats'
          );

          if (matchingEvent) {
            logger.info(`Found matching event for VividSeats: ${matchingEvent.name}`);
            
            // Add VividSeats link if it doesn't exist
            if (!matchingEvent.hasSourceLink) {
              const { error: linkError } = await this.supabase
                .from('event_links')
                .insert({
                  event_id: matchingEvent.id,
                  source: 'vividseats',
                  url: event.link
                });

              if (linkError) {
                logger.error('Error inserting VividSeats link:', linkError);
              } else {
                logger.info('Added VividSeats link to existing event');
              }
            }

            // Insert or update tickets
            if (event.tickets?.sections) {
              const tickets = this.transformTickets(matchingEvent.id, {
                ...event,
                source: 'vividseats'
              });

              if (tickets.length > 0) {
                const { error: ticketError } = await this.supabase
                  .from('tickets')
                  .insert(tickets);

                if (ticketError) {
                  logger.error('Error inserting VividSeats tickets:', ticketError);
                } else {
                  logger.info(`Inserted ${tickets.length} VividSeats tickets`);
                }
              }
            }

            // Get updated event data
            const { data: updatedEvent } = await this.supabase
              .from('events')
              .select(`
                *,
                event_links (*),
                tickets (*)
              `)
              .eq('id', matchingEvent.id)
              .single();

            if (updatedEvent) {
              storedEvents.push(updatedEvent);
            }
          } else {
            // Insert new event
            const { data: newEvent, error: eventError } = await this.supabase
              .from('events')
              .insert({
                name: event.title,
                type: 'Concert',
                category: 'Concert',
                date: parsedDate.toISOString(),
                venue: event.venue
              })
              .select()
              .single();

            if (eventError) {
              logger.error('Error inserting new VividSeats event:', eventError);
              continue;
            }

            logger.info(`Created new event: ${newEvent.name}`);

            // Insert VividSeats link
            const { error: linkError } = await this.supabase
              .from('event_links')
              .insert({
                event_id: newEvent.id,
                source: 'vividseats',
                url: event.link
              });

            if (linkError) {
              logger.error('Error inserting new VividSeats link:', linkError);
            }

            // Insert tickets
            if (event.tickets?.sections) {
              const tickets = this.transformTickets(newEvent.id, {
                ...event,
                source: 'vividseats'
              });

              if (tickets.length > 0) {
                const { error: ticketError } = await this.supabase
                  .from('tickets')
                  .insert(tickets);

                if (ticketError) {
                  logger.error('Error inserting new VividSeats tickets:', ticketError);
                } else {
                  logger.info(`Inserted ${tickets.length} new VividSeats tickets`);
                }
              }
            }

            // Get complete event data
            const { data: completeEvent } = await this.supabase
              .from('events')
              .select(`
                *,
                event_links (*),
                tickets (*)
              `)
              .eq('id', newEvent.id)
              .single();

            if (completeEvent) {
              storedEvents.push(completeEvent);
            }
          }
        } catch (error) {
          logger.error('Error processing VividSeats event:', error);
        }
      }

      logger.info(`Successfully stored ${storedEvents.length} VividSeats events`);
      return storedEvents;
    } catch (error) {
      logger.error('VividSeats search error:', error);
      return [];
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch (error) {
          logger.error('Error closing browser:', error);
        }
      }
    }
  }
}

export const searchService = new SearchService(); 