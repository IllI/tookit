import type { Event } from '@/lib/types/schemas';
import { normalizeDateTime, areDatesMatching, doDateTimesMatch } from '../utils/date-utils';
import * as cheerio from 'cheerio';

interface ScrapingNinjaResponse {
  info: {
    version: string;
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string | string[]>;
    finalUrl: string;
  };
  body: string;
}

interface EventLocation {
  city: string;
  state: string;
  country: string;
}

interface EventLink {
  source: string;
  url: string;
  is_primary: boolean;
  price?: string;
}

interface SearchResult extends Event {
  source?: string;
  link?: string;
  description?: string;
  ticket_links: EventLink[];
  has_ticketmaster: boolean;
}

class GoogleEventsSearcher {
  private apiKey: string;
  private readonly API_URL = 'https://scrapeninja.p.rapidapi.com/scrape';
  private readonly GOOGLE_CSE_URL = 'https://www.googleapis.com/customsearch/v1';
  private currentSearchResults: SearchResult[] = [];
  private readonly PRIORITY_VENDORS = [
    'ticketmaster',
    'livenation',
    'axs',
    'etix',
    'eventbrite',
    'dice.fm',
    'bandsintown'
  ];

  constructor() {
    this.apiKey = process.env.SCRAPING_NINJA_API_KEY || '';
    if (!this.apiKey) {
      console.warn('ScrapingNinja API key not found in environment variables');
    }
  }

  async searchConcerts(keyword: string, venue?: string, location?: string): Promise<SearchResult[]> {
    try {
      // First try searching for events with location context via scraping
      let eventsResults = await this.searchGoogleEvents(keyword, location);
      
      // If scraping fails or returns no results, try the Google Custom Search API
      if (eventsResults.length === 0) {
        console.log('Trying Google Custom Search API...');
        eventsResults = await this.searchGoogleCustomSearch(keyword, location);
      }
      
      // Store current search results for multiple event detection
      this.currentSearchResults = eventsResults;
      
      if (eventsResults.length > 0) {
        console.log(`Found ${eventsResults.length} events via Google Search`);
        return eventsResults;
      }

      // If no event results, try a broader search
      console.log('No events found via Events search, trying broader search...');
      return await this.searchGoogleWeb(keyword, location);

    } catch (error) {
      console.error('Google Events search error:', error);
      return [];
    }
  }

  private async searchGoogleEvents(keyword: string, location?: string): Promise<SearchResult[]> {
    const searchQuery = location ? 
      `${keyword} tickets ${location}` : 
      `${keyword} tickets`;

    // Use a simpler search URL format
    const url = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}`;
    console.log('Search URL:', url);

    try {
      // Add a longer delay between requests
      await new Promise(resolve => setTimeout(resolve, 5000));

      const response = await fetch(this.API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-rapidapi-key': this.apiKey,
          'x-rapidapi-host': 'scrapeninja.p.rapidapi.com'
        },
        body: JSON.stringify({
          url: url,
          javascript: false,
          timeout: 30
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ScrapingNinja API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const rawData = await response.json();
      console.log('Raw ScrapingNinja response:', rawData);

      // Check if we got a valid response
      if (!rawData || typeof rawData !== 'object') {
        throw new Error('Invalid response format from ScrapingNinja');
      }

      const data = rawData as ScrapingNinjaResponse;
      
      // Log useful metadata
      console.log('ScrapingNinja response metadata:', {
        statusCode: data.info?.statusCode,
        finalUrl: data.info?.finalUrl
      });

      // Check if we got a successful response with HTML content
      if (!data.body || typeof data.body !== 'string') {
        console.error('Invalid or missing HTML content in response:', data);
        throw new Error('No HTML content in response');
      }

      // Check for bot detection page
      if (data.info?.statusCode === 429 || data.body.includes('detected unusual traffic') || data.body.includes('sorry/index')) {
        console.error('Google bot detection triggered');
        throw new Error('Google bot detection triggered - try again later');
      }

      // Use Cheerio to parse the HTML and extract event information
      const $ = cheerio.load(data.body);
      
      // Look for event cards/results in Google's search results
      const eventResults: SearchResult[] = [];
      
      // More specific Google event result selectors
      const eventSelectors = [
        'div.g div.yuRUbf > a',           // Main search results
        'div[jscontroller] > div > a',     // Event cards
        'div.MjjYud div.vdQmEd > a',      // Shopping results
        'div.g div.kvH3mc > div.yuRUbf a'  // Rich results
      ];

      eventSelectors.forEach(selector => {
        $(selector).each((_, element) => {
          try {
            const $el = $(element);
            
            // Get the full href URL
            const link = $el.attr('href');
            if (!link || !link.startsWith('http')) return;

            // Extract title from h3 or data-title
            const title = $el.find('h3').first().text().trim() || 
                         $el.attr('data-title') || 
                         $el.find('[role="heading"]').first().text().trim();
            if (!title) return;

            // Extract description from various possible elements
            const description = $el.find('div.VwiC3b, div.yXK7lf, div.MUxGbd, .s3v9rd').first().text().trim() ||
                              $el.parent().find('div.VwiC3b, div.yXK7lf, div.MUxGbd').first().text().trim();
            if (!description) return;

            console.log('Found potential event:', { title, link, description });

            // Process the result
            const eventData = this.extractEventData({ title, description, link });
            if (eventData) {
              eventResults.push(eventData);
            }
          } catch (error) {
            console.error('Error processing event element:', error);
          }
        });
      });

      console.log(`Found ${eventResults.length} events`);
      return eventResults;

    } catch (error) {
      console.error('ScrapingNinja API error:', error);
      return [];
    }
  }

  private extractEventData(result: any): SearchResult | null {
    if (!result.title || !result.description) return null;

    // Extract title - remove any trailing location/date info after the dash
    const title = result.title?.split(' - ')[0]?.trim() || '';
    const description = result.description;

    // Extract venue, city, and state from description
    const venueMatch = description.match(/at (?:the )?([^,]+) in ([^,]+),\s*([A-Z]{2})/i);
    let venue = '';
    let city = '';
    let state = '';

    if (venueMatch) {
      venue = venueMatch[1].trim();  // e.g. "Byline Bank Aragon Ballroom"
      city = venueMatch[2].trim();   // e.g. "Chicago"
      state = venueMatch[3].trim();  // e.g. "IL"
    }

    // Extract date and time
    let dateStr = '';
    const dateMatch = description.match(/(?:for|on)\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s+\d{4}/i) ||
                     description.match(/\d{1,2}\/\d{1,2}\/\d{4}/);
    
    if (dateMatch) {
      dateStr = dateMatch[0];
      
      // Look for time after the date
      const timeMatch = description.match(/(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:AM|PM))/i);
      if (timeMatch) {
        dateStr += ` ${timeMatch[1]}`;
      }
    }

    // Create ticket link from the result URL
    const ticketLinks: EventLink[] = [];
    let hasTicketmaster = false;

    if (result.link) {
      const domain = new URL(result.link).hostname.toLowerCase();
      const vendor = this.normalizeVendorName(domain);
      
      // Check if this is a Ticketmaster or Live Nation link
      if (vendor === 'ticketmaster' || vendor === 'livenation') {
        hasTicketmaster = true;
      }

      if (this.PRIORITY_VENDORS.includes(vendor)) {
        ticketLinks.push({
          source: vendor,
          url: result.link,
          is_primary: true
        });
      }
    }

    // Only return if we have the essential data
    if ((!dateStr && !venue) || ticketLinks.length === 0) return null;

    const location: EventLocation = {
      city: city || 'Unknown',
      state: state || 'Unknown',
      country: 'US'
    };

    const eventData: SearchResult = {
      name: title,
      date: dateStr ? normalizeDateTime(dateStr) : '',
      venue,
      location,
      description,
      ticket_links: ticketLinks,
      source: this.determinePrimarySource(ticketLinks),
      has_ticketmaster: hasTicketmaster,
      link: result.link || ''
    };

    // Log the extracted data for debugging
    console.log('Extracted event data:', {
      title,
      dateStr,
      venue,
      city,
      state,
      ticketLinks,
      hasTicketmaster,
      link: result.link
    });

    return eventData;
  }

  private async searchGoogleWeb(keyword: string, location?: string): Promise<SearchResult[]> {
    // Use the same search method as searchGoogleEvents but with different query
    return this.searchGoogleEvents(keyword, location);
  }

  private normalizeVendorName(domain: string): string {
    // First check for priority vendors
    for (const vendor of this.PRIORITY_VENDORS) {
      if (domain.includes(vendor)) return vendor;
    }
    
    // Otherwise extract and normalize the domain name
    const parts = domain.toLowerCase()
      .replace('www.', '')  // Remove www.
      .split('.')[0];       // Take first part before TLD
    
    return parts;
  }

  private determinePrimarySource(ticketLinks: EventLink[]): string {
    const primaryLink = ticketLinks.find(link => link.is_primary);
    return primaryLink?.source || 'unknown';
  }

  private async searchGoogleCustomSearch(keyword: string, location?: string): Promise<SearchResult[]> {
    const searchQuery = location ? 
      `${keyword} tickets ${location}` : 
      `${keyword} tickets`;

    try {
      const response = await fetch(`${this.GOOGLE_CSE_URL}?key=${process.env.GOOGLE_SEARCH_API_KEY}&cx=${process.env.GOOGLE_SEARCH_ENGINE_ID}&q=${encodeURIComponent(searchQuery)}`);

      if (!response.ok) {
        throw new Error(`Google Custom Search API error: ${response.status}`);
      }

      const data = await response.json();
      const eventResults: SearchResult[] = [];

      if (data.items && Array.isArray(data.items)) {
        for (const item of data.items) {
          try {
            // Process each search result
            const eventData = this.extractEventData({
              title: item.title,
              description: item.snippet,
              link: item.link
            });

            if (eventData) {
              eventResults.push(eventData);
            }
          } catch (error) {
            console.error('Error processing Custom Search result:', error);
          }
        }
      }

      return eventResults;
    } catch (error) {
      console.error('Google Custom Search API error:', error);
      return [];
    }
  }
}

export default GoogleEventsSearcher;