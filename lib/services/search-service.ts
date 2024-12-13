import { EventEmitter } from 'events';
import StubHubSearcher from '@/src/stub-hub';
import VividSeatsSearcher from '@/src/vivid-seats';
import type { SearchParams } from '@/lib/types/api';
import { crawlerService } from '@/src/services/crawler-service';
import { createClient } from '@supabase/supabase-js';
import { config } from '@/src/config/env';

export class SearchService extends EventEmitter {
  private supabase;

  constructor() {
    super();
    crawlerService.setSearchService(this);
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.serviceKey || config.supabase.anonKey
    );
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
        
        // Initialize crawler for updating existing events
        await crawlerService.initialize();
        
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
          const eventIds = existingEvents.map(e => e.id);  // Get IDs of matching events

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
            .in('event_id', eventIds)  // Add filter here too
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
          await crawlerService.cleanup();
        }
      }

      // If no existing events found, proceed with new search
      this.emit('status', 'No existing events found. Starting new search...');
      
      // Initialize crawler for new searches
      this.emit('status', 'Setting up browser...');
      await crawlerService.initialize();

      // Run new searches in parallel
      this.emit('status', 'Searching for new events...');
      await Promise.all([
        this.searchVividSeats(params).catch(error => {
          console.error('VividSeats search failed:', error);
          this.emit('status', 'VividSeats search failed');
          return [];
        }),
        this.searchStubHub(params).catch(error => {
          console.error('StubHub search failed:', error);
          this.emit('status', 'StubHub search failed');
          return [];
        })
      ]);

      // After all searches complete, fetch all tickets from database
      this.emit('status', 'Fetching final ticket list...');

      // First get matching event IDs
      const { data: matchingEvents } = await this.supabase
        .from('events')
        .select('id')
        .ilike('name', `%${params.keyword}%`)
        .gte('date', new Date().toISOString());

      if (!matchingEvents?.length) {
        this.emit('status', 'No matching events found');
        return {
          success: true,
          data: [],
          metadata: { totalTickets: 0 }
        };
      }

      const eventIds = matchingEvents.map(e => e.id);

      // Then get tickets only for matching events
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
        .in('event_id', eventIds)  // Only get tickets for matching events
        .order('price');

      if (error) throw error;

      // Format ticket data
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

    } catch (error) {
      this.emit('error', error instanceof Error ? error.message : 'Search failed');
      throw error;
    } finally {
      await crawlerService.cleanup();
    }
  }

  private async searchStubHub(params: SearchParams) {
    this.emit('status', 'Searching StubHub...');
    const stubHubSearcher = new StubHubSearcher();
    const events = await stubHubSearcher.searchConcerts(
      params.keyword,
      undefined,
      params.location
    );
    
    if (events.length) {
      this.emit('status', `Found ${events.length} events on StubHub`);
    } else {
      this.emit('status', 'No events found on StubHub');
    }
    
    return events;
  }

  private async searchVividSeats(params: SearchParams) {
    this.emit('status', 'Searching VividSeats...');
    const vividSeatsSearcher = new VividSeatsSearcher();
    const events = await vividSeatsSearcher.searchConcerts(
      params.keyword,
      undefined,
      params.location
    );
    
    if (events.length) {
      this.emit('status', `Found ${events.length} events on VividSeats`);
    } else {
      this.emit('status', 'No events found on VividSeats');
    }
    
    return events;
  }
} 