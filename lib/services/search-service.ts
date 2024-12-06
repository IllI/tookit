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
      // Initialize crawler first
      this.emit('status', 'Setting up browser...');
      await crawlerService.initialize();

      // Run searches in parallel
      this.emit('status', 'Starting searches...');
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

      // After searches complete, fetch all tickets from database
      this.emit('status', 'Fetching tickets...');
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
          event:events(
            name,
            date,
            venue
          )
        `)
        .order('price');

      if (error) {
        throw error;
      }

      // Format ticket data
      const formattedTickets = tickets?.map(ticket => ({
        ...ticket,
        price: parseFloat(ticket.price) || 0,
        event: ticket.event ? {
          ...ticket.event,
          date: ticket.event.date ? new Date(ticket.event.date).toLocaleString() : 'Date TBD'
        } : null
      })) || [];

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