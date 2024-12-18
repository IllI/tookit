import type { EventEmitter } from 'events';

export interface ICrawlerService {
  searchService: EventEmitter | null;
  crawlPage(options: { url: string; waitForSelector?: string; eventId?: string }): Promise<any>;
  sendStatus(message: string): void;
}

export interface ISearchService extends EventEmitter {
  searchAll(params: SearchParams): Promise<SearchResult>;
}

export interface SearchParams {
  keyword: string;
  location?: string;
  source?: 'all' | 'stubhub' | 'vividseats';
}

export interface SearchResult {
  success: boolean;
  data?: any[];
  error?: string;
  metadata: Record<string, any>;
}