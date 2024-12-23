import { BaseService } from './base-service';
import { crawlerService } from './crawler-service';
import type { SearchParams, SearchResult } from '../lib/types';

class SearchService extends BaseService {
  private static _instance: SearchService;

  constructor() {
    super();
    if (SearchService._instance) {
      return SearchService._instance;
    }
    SearchService._instance = this;
  }

  static getInstance(): SearchService {
    if (!SearchService._instance) {
      SearchService._instance = new SearchService();
    }
    return SearchService._instance;
  }

  async searchAll(params: SearchParams): Promise<SearchResult> {
    try {
      // First, check for existing events
      this.emit('status', 'Checking for existing events...');
      const { data: existingEvents, error: queryError } = await this.supabase
        .from('events')
        .select(`
          id,
          name,
          date,
          venue,
          event_links (
            source,
            url
          )
        `)
        .ilike('name', `%${params.keyword}%`)
        .gte('date', new Date().toISOString());

      if (queryError) {
        console.error('Database query error:', queryError);
        throw queryError;
      }

      // Run new searches to get fresh data
      this.emit('status', 'Starting search...');
      const results = await scraperService.search(params);
      
      // Process each found event
      if (results.data?.length) {
        for (const event of results.data) {
          // Try to find matching event in existing events
          const existingEvent = existingEvents?.find(e => 
            e.name.toLowerCase() === event.name.toLowerCase() &&
            e.venue.toLowerCase() === event.venue.toLowerCase() &&
            new Date(e.date).toDateString() === new Date(event.date).toDateString()
          );

          if (existingEvent) {
            // Check if this source's link exists
            const hasSourceLink = existingEvent.event_links?.some(
              link => link.source === event.source
            );

            if (!hasSourceLink) {
              // Add new source link if it doesn't exist
              const { error: linkError } = await this.supabase
                .from('event_links')
                .insert({
                  event_id: existingEvent.id,
                  source: event.source,
                  url: event.url
                });

              if (linkError) {
                console.error('Error adding event link:', linkError);
              }
            }
          } else {
            // Create new event
            const { data: newEvent, error: insertError } = await this.supabase
              .from('events')
              .insert({
                name: event.name,
                date: event.date,
                venue: event.venue,
                city: event.location.city,
                state: event.location.state,
                country: event.location.country,
                created_at: new Date().toISOString()
              })
              .select()
              .single();

            if (insertError) {
              console.error('Error creating event:', insertError);
              continue;
            }

            if (newEvent) {
              // Add event link
              const { error: linkError } = await this.supabase
                .from('event_links')
                .insert({
                  event_id: newEvent.id,
                  source: event.source,
                  url: event.url
                });

              if (linkError) {
                console.error('Error adding event link:', linkError);
              }
            }
          }
        }
      }

      // Return updated data...
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

      const result = await crawlerService.crawlPage({
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

      const result = await crawlerService.crawlPage({
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

export const searchService = SearchService.getInstance();