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