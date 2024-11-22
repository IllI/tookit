import StubHubSearcher from '@/src/stub-hub';
import VividSeatsSearcher from '@/src/vivid-seats';
import { createClient } from '@supabase/supabase-js';
import { config } from '@/src/config/env';
import type { SearchParams, SearchResult, Event } from '../types/api';

export class SearchService {
  private supabase;
  private stubHubSearcher: StubHubSearcher;
  private vividSeatsSearcher: VividSeatsSearcher;

  constructor() {
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.serviceKey
    );
    this.stubHubSearcher = new StubHubSearcher();
    this.vividSeatsSearcher = new VividSeatsSearcher();
  }

  async searchAll(params: SearchParams): Promise<SearchResult> {
    try {
      const searches = [];
      
      if (params.source === 'all' || params.source === 'stubhub') {
        searches.push(this.searchStubHub(params));
      }
      
      if (params.source === 'all' || params.source === 'vividseats') {
        searches.push(this.searchVividSeats(params));
      }

      const results = await Promise.all(searches);
      const combinedResults = results.flat();

      return {
        success: true,
        data: combinedResults,
        metadata: {
          total: combinedResults.length,
          sources: {
            stubhub: results[0]?.length || 0,
            vividseats: results[1]?.length || 0
          }
        }
      };
    } catch (error) {
      console.error('Search error:', error);
      return {
        success: false,
        error: 'Failed to perform search',
        metadata: {
          error: error instanceof Error ? error.message : 'Unknown error'
        }
      };
    }
  }

  private async searchStubHub(params: SearchParams): Promise<Event[]> {
    return this.stubHubSearcher.searchConcerts(
      params.artist || params.keyword || '',
      params.venue || '',
      params.location || ''
    );
  }

  private async searchVividSeats(params: SearchParams): Promise<Event[]> {
    return this.vividSeatsSearcher.searchConcerts(
      params.artist || params.keyword || '',
      params.venue || '',
      params.location || ''
    );
  }
}

export const searchService = new SearchService(); 