import { EventEmitter } from 'events';
import { crawlerService } from '../../src/services/crawler-service';
import type { SearchParams, SearchResult } from '../types/api';

export class SearchService extends EventEmitter {
  constructor() {
    super();
  }

  async searchAll(params: SearchParams): Promise<SearchResult> {
    try {
      const content = await crawlerService.crawlPage(params.keyword);
      return {
        success: true,
        data: [content],
        metadata: {
          stubhub: { isLive: true },
          vividseats: { isLive: true }
        }
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
}

export const searchService = new SearchService();