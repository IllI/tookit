import type { Event } from '@/lib/types/schemas';
import { normalizeDateTime, areDatesMatching, doDateTimesMatch } from '../utils/date-utils';

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
  has_ticketmaster?: boolean;
}

class GoogleEventsSearcher {
  private apiKey: string;
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
    this.apiKey = process.env.ZENROWS_API_KEY || '';
    if (!this.apiKey) {
      console.warn('ZenRows API key not found in environment variables');
    }
  }

  async searchConcerts(keyword: string, venue?: string, location?: string): Promise<SearchResult[]> {
    try {
      // First try searching for events with location context
      const eventsResults = await this.searchGoogleEvents(keyword, location);
      
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

    const url = `https://www.google.com/search?q=${encodeURIComponent(searchQuery)}&hl=en&gl=us`;
    console.log('Search URL:', url);

    try {
      const searchParams = new URLSearchParams({
        url: url,
        apikey: this.apiKey,
        premium_proxy: 'true',
        autoparse: 'true'
      });

      console.log('ZenRows request params:', Object.fromEntries(searchParams));

      const response = await fetch(`https://api.zenrows.com/v1/?${searchParams}`, {
        method: 'GET'
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ZenRows API error: ${response.status} ${response.statusText} - ${errorText}`);
      }

      const data = await response.json();
      console.log('ZenRows response:', JSON.stringify(data, null, 2));

      if (!data.organic_results?.length) {
        console.log('No organic search results found');
        return [];
      }

      // Process organic search results to extract event information
      const processedEvents = data.organic_results
        .map((result: any) => {
          try {
            // Extract event data from the search result
            const eventData = this.extractEventData(result);
            if (eventData) {
              console.log('Found event data:', eventData);
              return eventData;
            }
          } catch (error) {
            console.error('Error processing result:', error);
          }
          return null;
        })
        .filter(Boolean);

      console.log(`Found ${processedEvents.length} events`);
      return processedEvents;
    } catch (error) {
      console.error('ZenRows API error:', error);
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
}

export default GoogleEventsSearcher;