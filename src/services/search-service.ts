import { EventEmitter } from 'events';
import { crawlerService } from './crawler-service';
import type { ISearchService, SearchParams, SearchResult } from './types';

class SearchService extends EventEmitter implements ISearchService {
  constructor() {
    super();
    // Initialize the crawler relationship
    crawlerService.searchService = this;
  }

  // ... rest of implementation same as before ...
}

// Create and export the singleton instance
export const searchService = new SearchService();