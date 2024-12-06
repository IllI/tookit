import { EventEmitter } from 'events';
import StubHubSearcher from '@/src/stub-hub';
import VividSeatsSearcher from '@/src/vivid-seats';
import type { SearchParams } from '@/lib/types/api';
import { crawlerService } from '@/src/services/crawler-service';

export class SearchService extends EventEmitter {
  constructor() {
    super();
    crawlerService.setSearchService(this);
  }

  async searchAll(params: SearchParams) {
    this.emit('status', 'Initializing search...');

    try {
      // Initialize crawler first
      this.emit('status', 'Setting up browser...');
      await crawlerService.initialize();

      // Run searches in parallel
      this.emit('status', 'Starting searches...');
      const [vividSeatsEvents, stubHubEvents] = await Promise.all([
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

      const allEvents = [...vividSeatsEvents, ...stubHubEvents];
      
      if (allEvents.length > 0) {
        this.emit('status', `Processing ${allEvents.length} events...`);
        
        // Process events and get tickets
        for (const event of allEvents) {
          this.emit('status', `Processing event: ${event.name}`);
          if (event.eventUrl) {
            this.emit('status', `Fetching tickets for ${event.name}...`);
            // Emit tickets as they're found
            this.emit('tickets', [event]);
          }
        }

        return {
          success: true,
          data: allEvents,
          metadata: { totalEvents: allEvents.length }
        };
      }

      this.emit('status', 'No events found');
      return {
        success: true,
        data: [],
        metadata: { totalEvents: 0 }
      };

    } catch (error) {
      this.emit('error', error instanceof Error ? error.message : 'Search failed');
      throw error;
    } finally {
      // Cleanup
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