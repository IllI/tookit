import type { EventData, SearchMetadata } from './schemas';

export interface SearchParams {
  keyword: string;
  location?: string;
  source?: 'all' | 'stubhub' | 'vividseats';
}

export interface SearchResult {
  success: boolean;
  data: EventData[];
  metadata: SearchMetadata;
  error?: string;
} 