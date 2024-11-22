import StubHubSearcher from '@/src/stub-hub';
import VividSeatsSearcher from '@/src/vivid-seats';
import { createClient } from '@supabase/supabase-js';
import { config } from '@/src/config/env';
import type { SearchParams, SearchResult, Event, Ticket } from '../types/api';

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

  private transformEventData(event: any): Event {
    // Transform sections into tickets array
    const tickets: Ticket[] = event.tickets?.sections?.flatMap((section: any) =>
      section.tickets.map((ticket: any) => ({
        id: ticket.listingId || `${event.id}-${ticket.rawPrice}-${section.section}`,
        eventId: event.id,
        price: ticket.rawPrice,
        section: section.section,
        row: ticket.row,
        quantity: parseInt(ticket.quantity) || 1,
        source: event.source,
        url: ticket.listingUrl || ticket.url,
        listingId: ticket.listingId,
        rawPrice: ticket.rawPrice,
        dealScore: ticket.dealScore,
        rawData: ticket
      }))
    ) || [];

    return {
      id: event.id,
      name: event.name || event.title,
      date: event.date,
      venue: event.venue,
      type: event.type || 'Concert',
      category: event.category || 'Concert',
      tickets
    };
  }

  private async searchStubHub(params: SearchParams): Promise<Event[]> {
    const events = await this.stubHubSearcher.searchConcerts(
      params.artist || params.keyword || '',
      params.venue || '',
      params.location || ''
    );
    return events.map(event => this.transformEventData(event));
  }

  private async searchVividSeats(params: SearchParams): Promise<Event[]> {
    const events = await this.vividSeatsSearcher.searchConcerts(
      params.artist || params.keyword || '',
      params.venue || '',
      params.location || ''
    );
    return events.map(event => this.transformEventData(event));
  }
}

export const searchService = new SearchService(); 