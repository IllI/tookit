import { createClient } from '@supabase/supabase-js';
import StubHubSearcher from '@/src/stub-hub';
import VividSeatsSearcher from '@/src/vivid-seats';

interface SearchParams {
  keyword: string;
  location: string;
  source?: string;
}

interface ParsedEvent {
  name: string;
  date: string;
  venue: string;
  location: string;
  price?: string;
}

interface ParsedEvents {
  events: ParsedEvent[];
}

interface SearchResult {
  name: string;
  tickets: number;
  sections: Array<{
    section: string;
    ticketCount?: number;
  }>;
}

export class SearchService {
  private supabase;
  private stubHubSearcher;
  private vividSeatsSearcher;

  constructor() {
    this.supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    this.stubHubSearcher = new StubHubSearcher();
    this.vividSeatsSearcher = new VividSeatsSearcher();
  }

  async searchAll(params: SearchParams): Promise<SearchResult[]> {
    console.log('[INFO] Starting search with params:', params);
    
    // Run searches concurrently
    const [vividSeatsResults, stubHubResults] = await Promise.all([
      this.searchVividSeats(params).catch(error => {
        console.error('VividSeats search failed:', error);
        return [];
      }),
      this.searchStubHub(params).catch(error => {
        console.error('StubHub search failed:', error);
        return [];
      })
    ]);

    // Save results to DB
    await Promise.all([
      this.saveEvents(vividSeatsResults, 'vividseats'),
      this.saveEvents(stubHubResults, 'stubhub')
    ]);

    return [...vividSeatsResults, ...stubHubResults];
  }

  private async saveEvents(events: SearchResult[], source: string) {
    if (!events.length) {
      console.log(`No events to save for ${source}`);
      return;
    }

    try {
      const { data, error } = await this.supabase
        .from('events')
        .upsert(
          events.map(event => ({
            name: event.name,
            source,
            tickets: event.tickets,
            sections: event.sections,
            created_at: new Date().toISOString()
          })),
          { onConflict: 'name,source' }
        );

      if (error) throw error;
      console.log(`[INFO] Saved ${events.length} events from ${source}`);
    } catch (error) {
      console.error(`Error saving ${source} events:`, error);
    }
  }

  async searchStubHub(params: SearchParams): Promise<SearchResult[]> {
    const result = await this.stubHubSearcher.searchConcerts(
      params.keyword,
      undefined,
      params.location
    ) as ParsedEvents;

    if (!result?.events?.length) {
      console.log('No events found on StubHub');
      return [];
    }

    console.log(`[INFO] Successfully processed ${result.events.length} StubHub events`);

    return result.events.map((event: ParsedEvent) => ({
      name: event.name,
      tickets: 1,
      sections: [{
        section: event.venue,
        ticketCount: 1
      }]
    }));
  }

  async searchVividSeats(params: SearchParams): Promise<SearchResult[]> {
    const result = await this.vividSeatsSearcher.searchConcerts(
      params.keyword,
      undefined,
      params.location
    ) as ParsedEvents;

    if (!result?.events?.length) {
      console.log('No events found on VividSeats');
      return [];
    }

    console.log(`[INFO] Successfully processed ${result.events.length} VividSeats events`);

    return result.events.map((event: ParsedEvent) => ({
      name: event.name,
      tickets: 1,
      sections: [{
        section: event.venue,
        ticketCount: 1
      }]
    }));
  }
} 