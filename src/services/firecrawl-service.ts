import { FirecrawlClient } from '@firecrawl/node';
import { createClient } from '@supabase/supabase-js';
import { getParser } from './llm-service';
import type { Database } from '@/types/supabase';
import { EventEmitter } from 'events';

interface CrawlOptions {
  url: string;
  waitForSelector?: string;
  searchParams?: {
    keyword?: string;
    location?: string;
  };
  eventId?: string;
}

class FirecrawlService extends EventEmitter {
  private client: FirecrawlClient;
  private parser;
  private supabase;
  
  constructor() {
    super();
    
    if (!process.env.FIRECRAWL_API_KEY) {
      throw new Error('FIRECRAWL_API_KEY environment variable is required');
    }
    
    this.client = new FirecrawlClient({
      apiKey: process.env.FIRECRAWL_API_KEY
    });
    
    this.parser = getParser();
    this.supabase = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_KEY!
    );
  }

  async crawlPage(options: CrawlOptions) {
    const { url, searchParams, eventId } = options;
    const source = url.includes('stubhub') ? 'stubhub' : 'vividseats';
    const isSearchPage = url.includes('search');

    try {
      console.log(`Crawling ${source} ${isSearchPage ? 'search' : 'event'} page:`, url);
      this.emit('status', `Fetching data from ${source}...`);

      // Configure Firecrawl request
      const response = await this.client.scrape({
        url,
        // Use residential proxy network for better success rate
        proxyType: 'residential',
        // Enable JavaScript rendering
        javascript: true,
        // Wait for key content to load
        waitUntil: 'networkidle0',
        // Add additional wait time for dynamic content
        additionalWait: 5000,
        // Extract specific selectors based on site
        selectors: this.getSelectors(source, isSearchPage),
        // Set user agent to latest Chrome
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        // Add cookie handling
        cookies: this.getDefaultCookies(source),
        // Browser settings
        viewport: {
          width: 1920,
          height: 1080
        }
      });

      if (!response.success) {
        throw new Error(`Firecrawl request failed: ${response.error}`);
      }

      // Parse content using existing LLM service
      const parsedContent = await this.parser.parseContent(
        response.content,
        url,
        searchParams,
        !isSearchPage
      );

      // Process results
      if (isSearchPage && parsedContent?.events) {
        await this.processEventData(parsedContent, source);
      } else if (eventId) {
        const tickets = parsedContent?.tickets || [];
        await this.processTicketData(tickets, eventId, source);
      }

      return {
        parsedContent,
        metadata: {
          url: response.finalUrl,
          statusCode: response.statusCode,
          timing: response.timing
        }
      };

    } catch (error) {
      console.error(`Crawl error for ${source}:`, error);
      throw error;
    }
  }

  private getSelectors(source: string, isSearchPage: boolean) {
    if (source === 'stubhub') {
      return isSearchPage ? {
        events: 'ul[data-testid="primaryGrid"] > li',
        eventName: '.sc-t60ws5-0',
        eventDate: 'time.sc-ja5jff-3',
        eventVenue: '.venue-name',
        eventLocation: '.location'
      } : {
        ticketListings: '.TicketList-row',
        section: '.section',
        row: '.row',
        price: '.price',
        quantity: '.quantity'
      };
    } else {
      return isSearchPage ? {
        events: '.ticket-list-item',
        eventName: '.event-name',
        eventDate: '.event-date',
        eventVenue: '.venue-name',
        eventLocation: '.location'
      } : {
        ticketListings: '.ticket-listing',
        section: '.section-name',
        row: '.row-name',
        price: '.price-amount',
        quantity: '.quantity-available'
      };
    }
  }

  private getDefaultCookies(source: string) {
    return [
      {
        name: 'cookieconsent',
        value: 'true',
        domain: source === 'stubhub' ? '.stubhub.com' : '.vividseats.com',
        path: '/'
      },
      {
        name: 'region',
        value: 'US',
        domain: source === 'stubhub' ? '.stubhub.com' : '.vividseats.com',
        path: '/'
      }
    ];
  }

  async processEventData(parsedContent: any, source: string) {
    if (!parsedContent?.events?.length) {
      console.log('No events to process');
      return;
    }

    for (const event of parsedContent.events) {
      try {
        console.log('Processing event:', event);
        
        const normalizedEvent = {
          name: event.name?.toLowerCase().trim(),
          date: new Date(event.date),
          venue: event.venue?.toLowerCase().trim(),
          location: event.location?.toLowerCase().trim()
        };

        const { data: existingEvents, error: searchError } = await this.supabase
          .from('events')
          .select('*')
          .filter('date', 'gte', new Date(normalizedEvent.date.setHours(0,0,0,0)).toISOString())
          .filter('date', 'lt', new Date(normalizedEvent.date.setHours(23,59,59,999)).toISOString());

        if (searchError) {
          console.error('Error searching for existing event:', searchError);
          continue;
        }

        const matchingEvent = existingEvents?.find(existing => {
          const nameMatch = this.stringSimilarity(
            existing.name.toLowerCase(),
            normalizedEvent.name
          ) > 0.8;

          const venueMatch = this.stringSimilarity(
            existing.venue.toLowerCase(),
            normalizedEvent.venue
          ) > 0.8;

          const sameDay = new Date(existing.date).toDateString() === 
                         normalizedEvent.date.toDateString();

          return nameMatch && venueMatch && sameDay;
        });

        if (matchingEvent) {
          console.log(`Found matching event: "${matchingEvent.name}" - updating source link`);
          
          const { data: existingLink } = await this.supabase
            .from('event_links')
            .select('*')
            .eq('event_id', matchingEvent.id)
            .eq('source', source)
            .single();

          if (!existingLink && event.eventUrl) {
            await this.supabase
              .from('event_links')
              .insert({
                event_id: matchingEvent.id,
                source,
                url: event.eventUrl
              });
          }
        } else {
          const { data: newEvent, error: insertError } = await this.supabase
            .from('events')
            .insert({
              name: event.name,
              date: new Date(event.date).toISOString(),
              venue: event.venue,
              ...this.parseLocation(event.location),
            })
            .select()
            .single();

          if (insertError) {
            console.error('Error inserting event:', insertError);
            continue;
          }

          if (newEvent && event.eventUrl) {
            await this.supabase
              .from('event_links')
              .insert({
                event_id: newEvent.id,
                source,
                url: event.eventUrl
              });
          }
        }
      } catch (error) {
        console.error('Error processing event:', error);
      }
    }
  }

  async processTicketData(tickets: any[], eventId: string, source: string) {
    try {
      if (!eventId) {
        console.error('No eventId provided for ticket processing');
        return;
      }

      console.log('Processing tickets:', {
        ticketsReceived: tickets?.length || 0,
        eventId,
        source
      });

      let ticketArray = [];
      if (Array.isArray(tickets)) {
        ticketArray = tickets;
      } else if (tickets?.tickets && Array.isArray(tickets.tickets)) {
        ticketArray = tickets.tickets;
      } else if (tickets) {
        ticketArray = [tickets];
      }

      ticketArray = ticketArray.filter(ticket => 
        ticket && 
        (typeof ticket.price !== 'undefined') && 
        ticket.section
      );

      const ticketCount = ticketArray.length;
      console.log(`Found ${ticketCount} valid tickets for ${source}`);
      this.emit('status', `Processing ${ticketCount} tickets for ${source}`);

      if (ticketCount === 0) {
        console.log(`No valid tickets found for ${source} event ${eventId}`);
        return;
      }

      const ticketData = ticketArray.map(ticket => ({
        event_id: eventId,
        section: ticket.section || 'General',
        row: ticket.row || null,
        price: typeof ticket.price === 'number' 
          ? ticket.price 
          : parseFloat(String(ticket.price || '0').replace(/[^0-9.]/g, '')) || 0,
        quantity: typeof ticket.quantity === 'number' 
          ? ticket.quantity 
          : parseInt(String(ticket.quantity || '1')) || 1,
        source: source,
        listing_id: ticket.listing_id || `${source}-${Date.now()}-${Math.random()}`,
        date_posted: new Date().toISOString(),
        sold: false
      }));

      const { data, error } = await this.supabase
        .from('tickets')
        .upsert(ticketData, { 
          onConflict: 'event_id,source,listing_id',
          returning: true 
        });

      if (error) {
        console.error('Database error:', error);
        throw error;
      }

      const savedCount = data?.length || ticketData.length;
      console.log(`Successfully saved ${savedCount} tickets for ${source} event ${eventId}`);
      this.emit('status', `Saved ${savedCount} tickets for ${source}`);

      return savedCount;

    } catch (error) {
      console.error(`Failed to process tickets for ${source}:`, error);
      this.emit('status', `Error processing tickets for ${source}`);
      return 0;
    }
  }

  private parseLocation(locationStr: string) {
    if (!locationStr) return { city: 'Unknown', country: 'USA' };

    const parts = locationStr.split(',').map(part => part.trim());
    
    if (parts.length === 2 && parts[1].length === 2) {
      const state = parts[1].toUpperCase();
      return {
        city: parts[0],
        state: state,
        country: ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'].includes(state) ? 'CAN' : 'USA'
      };
    }
    
    if (parts.length === 3) {
      return {
        city: parts[0],
        state: parts[1],
        country: parts[2].toLowerCase().includes('canada') ? 'CAN' : parts[2]
      };
    }
    
    return {
      city: parts[0] || 'Unknown',
      country: 'USA'
    };
  }

  private stringSimilarity(str1: string, str2: string): number {
    const len1 = str1.length;
    const len2 = str2.length;
    const matrix = Array(len2 + 1).fill(null).map(() => Array(len1 + 1).fill(null));

    for (let i = 0; i <= len1; i++) matrix[0][i] = i;
    for (let j = 0; j <= len2; j++) matrix[j][0] = j;

    for (let j = 1; j <= len2; j++) {
      for (let i = 1; i <= len1; i++) {
        const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,
          matrix[j - 1][i] + 1,
          matrix[j - 1][i - 1] + cost
        );
      }
    }

    const distance = matrix[len2][len1];
    const maxLength = Math.max(len1, len2);
    return 1 - distance / maxLength;
  }
}

export const firecrawlService = new FirecrawlService();