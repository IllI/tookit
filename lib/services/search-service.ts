import StubHubSearcher from '@/src/stub-hub';
import VividSeatsSearcher from '@/src/vivid-seats';
import { createClient } from '@supabase/supabase-js';
import { config } from '@/src/config/env';
import type { SearchParams, SearchResult, Event, Ticket, TicketSource } from '../types/api';
import { findMatchingEvent } from '@/src/event-utils';
import { logger } from '../utils/logger';

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
      // Get existing events and tickets from database first
      const { data: existingEvents } = await this.supabase
        .from('events')
        .select(`
          *,
          event_links (*),
          tickets (*)
        `)
        .ilike('name', `%${params.keyword || params.artist}%`);

      // Start searches in parallel
      const searches = [];
      const sources: Record<string, TicketSource> = {};
      
      if (params.source === 'all' || params.source === 'stubhub') {
        searches.push(
          this.searchStubHub(params)
            .then(results => {
              sources.stubhub = { isLive: true, lastUpdated: new Date().toISOString() };
              return results;
            })
            .catch(error => {
              sources.stubhub = {
                isLive: false,
                lastUpdated: existingEvents?.[0]?.updated_at || new Date().toISOString(),
                error: error.message
              };
              // Return existing StubHub tickets if search fails
              return existingEvents?.filter(e => 
                e.tickets.some(t => t.source === 'stubhub')
              ) || [];
            })
        );
      }
      
      if (params.source === 'all' || params.source === 'vividseats') {
        searches.push(this.searchVividSeats(params));
      }

      const searchResults = await Promise.all(searches);
      const combinedResults = searchResults.flat();

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

      // Transform raw events into Event type
      return rawEvents.map(event => ({
        id: event.id || '', // Will be assigned when stored
        name: event.name,
        date: new Date(event.date).toISOString(),
        venue: event.venue,
        type: event.type || 'Concert',
        category: event.category || 'Concert',
        source: 'stubhub',
        link: event.link,
        tickets: event.tickets?.sections?.map(section => ({
          section: section.section,
          tickets: section.tickets.map(ticket => ({
            ...ticket,
            source: 'stubhub'
          }))
        }))
      }));
    } catch (error) {
      logger.error('StubHub search error:', error);
      return [];
    }
  }

  private async searchVividSeats(params: SearchParams): Promise<Event[]> {
    try {
      const rawEvents = await this.vividSeatsSearcher.searchConcerts(
        params.artist || params.keyword || '',
        params.venue || '',
        params.location || ''
      );

      // Transform raw events into Event type
      return rawEvents.map(event => ({
        id: event.id || '', // Will be assigned when stored
        name: event.title || event.name,
        date: new Date(event.date).toISOString(),
        venue: event.venue,
        type: event.type || 'Concert',
        category: event.category || 'Concert',
        source: 'vividseats',
        link: event.link,
        tickets: event.tickets?.sections?.map(section => ({
          section: section.section,
          tickets: section.tickets.map(ticket => ({
            ...ticket,
            source: 'vividseats'
          }))
        }))
      }));
    } catch (error) {
      logger.error('VividSeats search error:', error);
      return [];
    }
  }
}

export const searchService = new SearchService(); 