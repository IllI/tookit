import { EventEmitter } from 'events';
import GoogleEventsSearcher from './google-events-searcher';
import StubHubSearcher from './stub-hub';
import VividSeatsSearcher from './vivid-seats';
import type { SearchParams, SearchResult } from '../types/api';

export class SearchService extends EventEmitter {
  private googleEventsSearcher: GoogleEventsSearcher;
  private stubHubSearcher: StubHubSearcher;
  private vividSeatsSearcher: VividSeatsSearcher;

  constructor() {
    super();
    this.googleEventsSearcher = new GoogleEventsSearcher();
    this.stubHubSearcher = new StubHubSearcher();
    this.vividSeatsSearcher = new VividSeatsSearcher();
  }

  async searchAll(params: SearchParams): Promise<SearchResult> {
    try {
      const promises = [];
      const metadata: SearchResult['metadata'] = {};

      // First try Google Events API to find all available sources
      this.emit('status', 'Searching via Google Events...');
      const googleResults = await this.googleEventsSearcher.searchConcerts(
        params.keyword,
        undefined,
        params.location
      );

      if (googleResults.length > 0) {
        this.emit('status', `Found ${googleResults.length} events via Google`);
        
        // Process Google results first
        for (const event of googleResults) {
          if (event.link) {
            await this.processEventLink(event);
          }
        }
      }

      // Then do direct vendor searches based on source parameter
      if (!params.source || params.source === 'all' || params.source === 'stubhub') {
        this.emit('status', 'Searching StubHub...');
        promises.push(this.stubHubSearcher.searchConcerts(params.keyword, undefined, params.location));
        metadata.stubhub = { isLive: true };
      }

      if (!params.source || params.source === 'all' || params.source === 'vividseats') {
        this.emit('status', 'Searching VividSeats...');
        promises.push(this.vividSeatsSearcher.searchConcerts(params.keyword, undefined, params.location));
        metadata.vividseats = { isLive: true };
      }

      const vendorResults = await Promise.all(promises);
      const allEvents = [...googleResults, ...vendorResults.flat()];

      return {
        success: true,
        data: allEvents,
        metadata
      };

    } catch (error) {
      console.error('Search error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Search failed',
        metadata: {
          error: 'Search operation failed'
        }
      };
    }
  }

  private async processEventLink(event: any) {
    try {
      this.emit('status', `Processing event: ${event.name}`);
      
      // Use crawler service to get ticket data
      const result = await this.crawlerService.crawlPage({
        url: event.link,
        waitForSelector: '.ticket-list, .TicketList-row',
        eventData: event
      });

      if (result?.tickets?.length) {
        this.emit('status', `Found ${result.tickets.length} tickets for ${event.name}`);
      }

    } catch (error) {
      console.error('Error processing event link:', error);
    }
  }
}

export const searchService = new SearchService();