import { getJson } from 'serpapi';
import { EventEmitter } from 'events';
import { HfInference } from '@huggingface/inference';
import type { SearchParams, SearchResult } from '../types/api';
import type { Event, TicketData, EventData, SearchMetadata } from '@/lib/types/schemas';
import { createClient } from '@supabase/supabase-js';
import { config } from '@/src/config/env';
import { webReaderService } from './parsehub-service';
import * as cheerio from 'cheerio';

// Initialize HuggingFace client
const HF_TOKEN = process.env.HF_TOKEN;
if (!HF_TOKEN) {
  console.warn('No HuggingFace API token found in environment variables (HF_TOKEN). Some features may be limited.');
}
console.log('HF Token available:', !!HF_TOKEN);

const hf = new HfInference(HF_TOKEN || '');

const SERPAPI_KEY = 'ef96da14f879948ae93fb073175e12ad532423ece415ab8ae4f6c612e2aef105';

interface DbEvent {
  id: string;
  name: string;
  date: string;
  venue: string;
  event_links: Array<{
    source: string;
    url: string;
  }>;
}

interface DbTicket {
  id: string;
  event_id: string;
  section: string;
  row?: string;
  price: number;
  quantity: number;
  source: string;
  listing_id: string;
  event: {
    id: string;
    name: string;
    date: string;
    venue: string;
    city: string;
    state: string;
    country: string;
  };
}

export class SearchService extends EventEmitter {
  private supabase;

  constructor() {
    super();
    this.supabase = createClient(
      config.supabase.url,
      config.supabase.serviceKey || config.supabase.anonKey
    );
  }

  async searchAll(params: SearchParams): Promise<SearchResult> {
    try {
      // First try Google Events API
      this.emit('status', 'Searching Google Events API...');
      const googleEvents = await this.searchGoogleEvents(params);

      if (googleEvents.length > 0) {
        this.emit('status', `Found ${googleEvents.length} events via Google Events API`);
        
        // Process found events
        const processedEvents = await Promise.all(
          googleEvents.map(async (event) => {
            try {
              const eventResult = await this.processGoogleEvent(event);
              if (eventResult) {
                return eventResult;
              }
            } catch (error) {
              console.error('Error processing Google event:', error);
            }
            return null;
          })
        );

        const validEvents = processedEvents.filter((event): event is EventData => event !== null);
        
        if (validEvents.length > 0) {
          return {
            success: true,
            data: validEvents,
            metadata: {
              sources: Array.from(new Set(validEvents.map(event => event.source!)))
            }
          };
        }
      }

      // If no results from Google Events API, fall back to existing search logic
      return await this.searchVendors(params);
    } catch (error) {
      console.error('Search error:', error);
      // Fall back to existing search logic if Google Events API fails
      return await this.searchVendors(params);
    }
  }

  private async searchGoogleEvents(params: SearchParams) {
    try {
      const searchQuery = params.location ?
        `${params.keyword} ${params.location}` :
        params.keyword;

      const searchParams = {
        engine: "google_events",
        q: searchQuery,
        location: params.location,
        htichips: "date:upcoming",
        hl: "en",
        gl: "us",
        api_key: SERPAPI_KEY
      };

      const response = await getJson(searchParams);
      
      if (!response.events_results?.length) {
        return [];
      }

      return response.events_results.map(event => ({
        title: event.title,
        date: event.date?.start_date || event.date?.when,
        venue: event.venue?.name,
        address: event.venue?.address,
        ticket_info: event.ticket_info
      }));
    } catch (error) {
      console.error('Google Events API error:', error);
      return [];
    }
  }

  private async processGoogleEvent(event: any): Promise<EventData | null> {
    try {
      // Find primary ticket vendor
      const ticketInfo = event.ticket_info || [];
      const primaryVendor = this.findPrimaryVendor(ticketInfo);

      if (!primaryVendor) {
        return null;
      }

      // Parse location from address
      const [city, state] = (event.address || '').split(',').map(part => part.trim());

      return {
        name: event.title,
        date: event.date,
        venue: event.venue,
        location: {
          city: city || '',
          state: state || '',
          country: 'US'
        },
        source: primaryVendor.source,
        url: primaryVendor.link,
        tickets: []
      };
    } catch (error) {
      console.error('Error processing Google event:', error);
      return null;
    }
  }

  private findPrimaryVendor(ticketInfo: any[]) {
    const PRIORITY_VENDORS = [
      { name: 'ticketmaster', source: 'ticketmaster' },
      { name: 'axs', source: 'axs' },
      { name: 'etix', source: 'etix' },
      { name: 'eventbrite', source: 'eventbrite' },
      { name: 'dice.fm', source: 'dice' },
      { name: 'bandsintown', source: 'bandsintown' }
    ];

    // First try to find official/primary vendor
    const primaryTicket = ticketInfo.find(ticket => 
      ticket.type === 'primary' || ticket.is_official
    );

    if (primaryTicket?.link) {
      const vendorMatch = PRIORITY_VENDORS.find(vendor => 
        primaryTicket.source.toLowerCase().includes(vendor.name)
      );
      if (vendorMatch) {
        return {
          source: vendorMatch.source,
          link: primaryTicket.link
        };
      }
    }

    // Then try to find by priority
    for (const vendor of PRIORITY_VENDORS) {
      const ticket = ticketInfo.find(t => 
        t.source?.toLowerCase().includes(vendor.name)
      );
      if (ticket?.link) {
        return {
          source: vendor.source,
          link: ticket.link
        };
      }
    }

    return null;
  }

  // Renamed the original searchAll to searchVendors
  private async searchVendors(params: SearchParams): Promise<SearchResult> {
    // ... (rest of the original searchAll method code)
  }

  // ... (rest of the existing class code)
}

export const searchService = new SearchService();