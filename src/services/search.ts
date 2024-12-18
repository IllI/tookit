import { EventEmitter } from 'events';
import { crawlPage } from './crawler';

export type SearchParams = {
  keyword: string;
  location?: string;
  source?: 'all' | 'stubhub' | 'vividseats';
};

export type SearchResult = {
  success: boolean;
  data?: any[];
  error?: string;
  metadata: Record<string, any>;
};

class SearchService extends EventEmitter {
  async searchAll(params: SearchParams): Promise<SearchResult> {
    try {
      const promises = [];
      const metadata: SearchResult['metadata'] = {};

      if (!params.source || params.source === 'all' || params.source === 'stubhub') {
        promises.push(this.searchStubHub(params));
        metadata.stubhub = { isLive: true };
      }

      if (!params.source || params.source === 'all' || params.source === 'vividseats') {
        promises.push(this.searchVividSeats(params));
        metadata.vividseats = { isLive: true };
      }

      const results = await Promise.all(promises);
      const allEvents = results.flat();

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

  private async searchStubHub(params: SearchParams) {
    this.emit('status', 'Searching StubHub...');
    try {
      const searchUrl = `https://www.stubhub.com/secure/search?q=${encodeURIComponent(
        [params.keyword, params.location].filter(Boolean).join(' ')
      )}`;

      const result = await crawlPage({
        url: searchUrl,
        waitForSelector: '#app'
      });

      const events = result?.parsedContent?.events || [];
      
      if (events.length) {
        this.emit('status', `Found ${events.length} events on StubHub`);
      } else {
        this.emit('status', 'No events found on StubHub');
      }
      
      return events;
    } catch (error) {
      console.error('StubHub search error:', error);
      this.emit('status', 'No events found on StubHub');
      return [];
    }
  }

  private async searchVividSeats(params: SearchParams) {
    this.emit('status', 'Searching VividSeats...');
    try {
      const searchUrl = `https://www.vividseats.com/search?searchTerm=${encodeURIComponent(
        [params.keyword, params.location].filter(Boolean).join(' ')
      )}`;

      const result = await crawlPage({
        url: searchUrl,
        waitForSelector: '[data-testid^="production-listing-"]'
      });

      const events = result?.parsedContent?.events || [];
      
      if (events.length) {
        this.emit('status', `Found ${events.length} events on VividSeats`);
      } else {
        this.emit('status', 'No events found on VividSeats');
      }
      
      return events;
    } catch (error) {
      console.error('VividSeats search error:', error);
      this.emit('status', 'No events found on VividSeats');
      return [];
    }
  }
}

export const searchService = new SearchService();