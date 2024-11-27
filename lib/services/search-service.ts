import { createClient } from '@supabase/supabase-js';
import { config } from '@/src/config/env';
import StubHubSearcher from '@/src/stub-hub';
import VividSeatsSearcher from '@/src/vivid-seats';
import { parse, format } from 'date-fns';
import type { Event, SearchParams, SearchResult, TicketSource, Section, Ticket } from '../types/api';

export class SearchService {
  private supabase;
  private searchTimeout = 120000; // 2 minute timeout

  constructor() {
    this.supabase = createClient(config.supabase.url, config.supabase.serviceKey);
  }

  async searchAll(params: SearchParams): Promise<SearchResult> {
    console.log('[INFO] Starting search with params:', params);
    
    try {
      // Run searches independently to prevent one failure from affecting the other
      const results = await Promise.allSettled([
        this.searchVividSeats(params),
        this.searchStubHub(params)
      ]);

      // Log results of each search
      results.forEach((result, index) => {
        const source = index === 0 ? 'VividSeats' : 'StubHub';
        if (result.status === 'rejected') {
          console.error(`[ERROR] ${source} search failed:`, result.reason);
        }
      });

      // Get all events regardless of search success
      const events = await this.getEventsWithTickets(params);

      return {
        success: true,
        data: events,
        metadata: {
          stubhub: { 
            isLive: results[1].status === 'fulfilled',
            error: results[1].status === 'rejected' ? results[1].reason?.message : undefined
          },
          vividseats: {
            isLive: results[0].status === 'fulfilled',
            error: results[0].status === 'rejected' ? results[0].reason?.message : undefined
          }
        }
      };

    } catch (error) {
      console.error('[ERROR] Search error:', error);
      return {
        success: false,
        error: 'Failed to perform search',
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }

  private async searchVividSeats(params: SearchParams) {
    try {
      const searcher = new VividSeatsSearcher();
      const events = await searcher.searchConcerts(params.keyword, '', params.location);
      
      for (const event of events) {
        try {
          // Map VividSeats data structure to our expected format
          const normalizedEvent = {
            name: event.title,
            date: event.date,
            venue: event.venue,
            location: event.location,
            category: 'Concert',
            link: event.link,
            source: event.source,
            tickets: event.tickets?.sections
          };

          // Validate required fields
          if (!normalizedEvent.name || !normalizedEvent.date || !normalizedEvent.venue) {
            console.error('[ERROR] Missing required event data:', normalizedEvent);
            continue;
          }

          await this.upsertEvent(normalizedEvent);
          console.log(`[INFO] Stored VividSeats event: ${normalizedEvent.name}`);
        } catch (eventError) {
          console.error(`[ERROR] Failed to store VividSeats event:`, eventError);
        }
      }

      console.log(`[INFO] Successfully processed ${events.length} VividSeats events`);
    } catch (error) {
      console.error('[ERROR] VividSeats search failed:', error);
    }
  }

  private async searchStubHub(params: SearchParams) {
    try {
      const searcher = new StubHubSearcher();
      const events = await searcher.searchConcerts(params.keyword, '', params.location);
      
      // Store each event with its tickets
      for (const event of events) {
        try {
          // Log the event data including tickets for debugging
          console.log('[DEBUG] StubHub event data:', {
            name: event.name,
            tickets: event.tickets?.length || 0,
            sections: event.tickets?.map(s => ({
              section: s.section,
              ticketCount: s.tickets?.length
            }))
          });

          await this.upsertEvent({
            name: event.name,
            date: event.date,
            venue: event.venue,
            location: event.location,
            category: event.category,
            link: event.link,
            source: event.source,
            tickets: event.tickets // Make sure tickets are passed through
          });
          
          console.log(`[INFO] Stored StubHub event: ${event.name} with ${event.tickets?.length || 0} sections`);
        } catch (eventError) {
          console.error(`[ERROR] Failed to store StubHub event ${event.name}:`, eventError);
        }
      }

      console.log(`[INFO] Successfully processed ${events.length} StubHub events`);
    } catch (error) {
      console.error('[ERROR] StubHub search failed:', error);
    }
  }

  private async upsertEvent(eventData: {
    name: string;
    date: string;
    venue: string;
    location: string;
    category: string;
    link?: string;
    source: string;
    tickets?: Section[];
  }) {
    try {
      let parsedDate: Date;
      console.log('[DEBUG] Parsing date:', eventData.date);

      if (eventData.source === 'vividseats') {
        const [month, day, _, time] = eventData.date.split(' ');
        const year = '2025';
        const dateStr = `${month} ${day} ${year} ${time}`;
        parsedDate = parse(dateStr, 'MMM d yyyy h:mma', new Date());
      } else {
        parsedDate = parse(eventData.date, 'MMM d yyyy h:mm a', new Date());
      }

      // First, check if event exists
      const { data: existingEvents } = await this.supabase
        .from('events')
        .select('id')
        .eq('name', eventData.name)
        .eq('date', format(parsedDate, "yyyy-MM-dd'T'HH:mm:ssX"))
        .eq('venue', eventData.venue);

      let eventRecord;

      if (existingEvents && existingEvents.length > 0) {
        eventRecord = existingEvents[0];
        console.log(`[INFO] Found existing event with ID: ${eventRecord.id}`);
      } else {
        // Insert new event
        const { data, error } = await this.supabase
          .from('events')
          .insert([{
            name: eventData.name,
            type: 'concert',
            category: eventData.category || 'Concert',
            date: format(parsedDate, "yyyy-MM-dd'T'HH:mm:ssX"),
            venue: eventData.venue
          }])
          .select()
          .single();

        if (error) throw error;
        eventRecord = data;
        console.log(`[INFO] Created new event with ID: ${eventRecord.id}`);
      }

      // Store event link
      if (eventData.link) {
        const { error: linkError } = await this.supabase
          .from('event_links')
          .insert([{
            event_id: eventRecord.id,
            source: eventData.source,
            url: eventData.link
          }])
          .select();

        if (linkError && linkError.code !== '23505') { // Ignore unique violation
          throw linkError;
        }
      }

      // Delete existing tickets for this event from this source before adding new ones
      if (eventRecord.id) {
        console.log(`[INFO] Removing existing tickets for event ${eventRecord.id} from source ${eventData.source}`);
        const { error: deleteError } = await this.supabase
          .from('tickets')
          .delete()
          .eq('event_id', eventRecord.id)
          .eq('source', eventData.source);

        if (deleteError) {
          console.error('[ERROR] Failed to delete existing tickets:', deleteError);
          throw deleteError;
        }
      }

      // Store new tickets if available
      if (Array.isArray(eventData.tickets) && eventData.tickets.length > 0) {
        const tickets = eventData.tickets.flatMap((section: Section) => {
          if (!Array.isArray(section.tickets)) return [];
          
          return section.tickets.map((ticket: Ticket) => ({
            event_id: eventRecord.id,
            section: section.section,
            price: ticket.rawPrice,
            quantity: parseInt(ticket.quantity) || 1,
            source: eventData.source,
            type: section.category || 'standard',
            raw_data: {
              listingId: ticket.listingId,
              originalPrice: ticket.price,
              url: ticket.listingUrl
            }
          }));
        });

        if (tickets.length > 0) {
          console.log(`[INFO] Inserting ${tickets.length} new tickets for event ${eventRecord.id}`);
          const { error: ticketError } = await this.supabase
            .from('tickets')
            .insert(tickets);

          if (ticketError) {
            console.error('[ERROR] Failed to insert tickets:', ticketError);
            throw ticketError;
          }
        }
      }

      console.log(`[INFO] Successfully stored event: ${eventData.name}`);
      return eventRecord;

    } catch (error) {
      console.error('[ERROR] Failed to store event:', error);
      throw error;
    }
  }

  private async getEventsWithTickets(params: SearchParams) {
    try {
      const { data: events, error } = await this.supabase
        .from('events')
        .select(`
          *,
          event_links (
            source,
            url
          ),
          tickets (
            id,
            section,
            price,
            quantity,
            source,
            type,
            raw_data
          )
        `)
        .order('date', { ascending: true });

      if (error) throw error;
      return events || [];
    } catch (error) {
      console.error('[ERROR] Failed to get events with tickets:', error);
      return [];
    }
  }
} 