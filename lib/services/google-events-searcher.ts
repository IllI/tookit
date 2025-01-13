import { getJson } from 'serpapi';
import type { Event } from '@/lib/types/schemas';
import { normalizeDateTime, areDatesMatching, doDateTimesMatch } from '../utils/date-utils';

interface GoogleEventResult {
  title: string;
  date?: {
    start_date?: string;
    when?: string;
  };
  venue?: {
    name?: string;
    rating?: number;
    reviews?: number;
    link?: string;
  };
  address?: string[];
  description?: string;
  ticket_info?: Array<{
    source: string;
    link: string;
    link_type: 'tickets' | 'more info';
  }>;
  link?: string;
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
}

class GoogleEventsSearcher {
  private apiKey: string;
  private currentSearchResults: SearchResult[] = [];
  private readonly PRIORITY_VENDORS = [
    'ticketmaster',
    'axs',
    'etix',
    'eventbrite',
    'dice.fm',
    'bandsintown'
  ];

  constructor() {
    this.apiKey = 'ef96da14f879948ae93fb073175e12ad532423ece415ab8ae4f6c612e2aef105';
  }

  async searchConcerts(keyword: string, venue?: string, location?: string): Promise<SearchResult[]> {
    try {
      // First try Google Events API with location-aware search
      const eventsResults = await this.searchGoogleEvents(keyword, location);
      
      // Store current search results for multiple event detection
      this.currentSearchResults = eventsResults;
      
      // Also get regular Google search results for additional ticket links
      const searchResults = await this.searchGoogleWeb(keyword, location);
      
      if (eventsResults.length > 0) {
        console.log(`Found ${eventsResults.length} events via Google Events API`);
        
        // Enhance events with additional ticket links from Google search
        const enhancedResults = eventsResults.map(event => {
          const matchingSearchResults = searchResults.filter(sr => 
            this.isMatchingEvent(event, sr.name, sr.venue)
          );
          
          // Combine ticket links, removing duplicates
          const allTicketLinks = new Set([
            ...event.ticket_links.map(link => JSON.stringify(link)),
            ...matchingSearchResults.flatMap(sr => sr.ticket_links).map(link => JSON.stringify(link))
          ]);

          // Process any Ticketmaster links found
          const ticketLinks = Array.from(allTicketLinks).map(link => JSON.parse(link));
          const tmLink = ticketLinks.find(link => link.source === 'ticketmaster');
          if (tmLink) {
            // Note: processTicketmasterEvent will be called by the search service
            console.log('Found Ticketmaster link:', tmLink.url);
          }
          
          return {
            ...event,
            ticket_links: ticketLinks
          };
        });
        
        return enhancedResults;
      }

      // If no event results, use web search results
      console.log('No events found via Events API, using regular search results...');
      return searchResults;

    } catch (error) {
      console.error('Google Events search error:', error);
      return [];
    }
  }

  private async searchGoogleEvents(keyword: string, location?: string): Promise<SearchResult[]> {
    const params: any = {
      engine: "google_events",
      q: keyword + " " + location,
      hl: "en",
      gl: "us",
      api_key: this.apiKey,
      htichips: "date:upcoming"
    };

    // Add location context if provided
    if (location) {
      params.location = location;
      params.google_domain = "google.com";
    }

    console.log('Searching Google Events with params:', {
      ...params,
      api_key: '***' // Hide API key in logs
    });

    const response = await getJson(params);
    
    if (!response.events_results?.length) {
      return [];
    }

    // First, process all events
    const processedEvents = response.events_results
      .map((event: GoogleEventResult) => {
        // Parse location from address array
        const location = this.parseLocation(event.address);
        
        // Extract ticket links with priority and pricing
        const ticketLinks = this.extractTicketLinks(event.ticket_info);

        // Convert date string to database timestamp
        let dateTime = '';
        if (event.date?.when) {
          dateTime = normalizeDateTime(event.date.when);
        }

        console.log('Processing event:', {
          title: event.title,
          venue: event.venue?.name,
          address: event.address,
          location,
          ticketLinks,
          originalDate: event.date?.when,
          convertedDate: dateTime
        });

        return {
          name: event.title,
          date: dateTime,
          venue: event.venue?.name || '',
          location,
          description: event.description,
          ticket_links: ticketLinks,
          source: this.determinePrimarySource(ticketLinks)
        };
      });

    // Then, deduplicate events based on venue and date
    const uniqueEvents = new Map<string, SearchResult>();
    
    processedEvents.forEach((event: SearchResult) => {
      // Create a unique key based on venue and date
      const key = `${event.venue}_${event.date}`;
      
      if (!uniqueEvents.has(key)) {
        // This is a new unique event
        uniqueEvents.set(key, event);
      } else {
        // This is a duplicate event, merge ticket links
        const existingEvent = uniqueEvents.get(key)!;
        const existingLinks = new Set(existingEvent.ticket_links.map(link => link.url));
        
        // Add new ticket links that don't exist yet
        event.ticket_links.forEach((link: EventLink) => {
          if (!existingLinks.has(link.url)) {
            existingEvent.ticket_links.push(link);
          }
        });
      }
    });

    return Array.from(uniqueEvents.values());
  }

  private async searchGoogleWeb(keyword: string, location?: string): Promise<SearchResult[]> {
    const searchQuery = location ? 
      `${keyword} tickets in ${location}` : 
      `${keyword} tickets`;

    const params = {
      engine: "google",
      q: searchQuery,
      hl: "en",
      gl: "us",
      api_key: this.apiKey,
      location: location
    };

    const response = await getJson(params);
    const organicResults = response.organic_results || [];
    
    // Filter for ticket vendor results
    const ticketResults = organicResults.filter((result: any) => {
      const domain = new URL(result.link).hostname.toLowerCase();
      return this.PRIORITY_VENDORS.some(vendor => domain.includes(vendor));
    });

    if (!ticketResults.length) return [];

    // Group results by event and create SearchResult objects
    return this.groupTicketResults(ticketResults, keyword);
  }

  private generateUULE(location: string): string {
    // Encode location for Google's UULE parameter
    const encoded = Buffer.from(`w+CAIQICI${location}`).toString('base64');
    return `w+CAIQICI${encoded}`;
  }

  private parseLocation(address?: string[]): EventLocation {
    if (!address?.length) {
      return {
        city: 'Unknown',
        state: 'Unknown',
        country: 'US'
      };
    }

    // The last element in the address array typically contains the city and state
    const cityState = address[address.length - 1];
    if (!cityState) {
      return {
        city: 'Unknown',
        state: 'Unknown',
        country: 'US'
      };
    }

    const parts = cityState.split(',').map(part => part.trim());
    if (parts.length >= 2) {
      // Extract state from the second part (e.g., "IL" from "Chicago, IL")
      const statePart = parts[1].split(' ').filter(p => p);
      return {
        city: parts[0],
        state: statePart[0] || 'Unknown', // Take first word as state code
        country: 'US' // Default to US
      };
    }

    // If we can't parse city/state properly, use what we have
    return {
      city: parts[0] || 'Unknown',
      state: 'Unknown',
      country: 'US'
    };
  }

  private extractTicketLinks(ticketInfo?: GoogleEventResult['ticket_info']): EventLink[] {
    if (!ticketInfo?.length) {
      console.log('No ticket info provided');
      return [];
    }

    console.log('Raw ticket info from SerpAPI:', JSON.stringify(ticketInfo, null, 2));

    const links = ticketInfo
      .map(ticket => {
        try {
          const url = new URL(ticket.link);
          const domain = url.hostname.toLowerCase();
          const isPriorityVendor = this.PRIORITY_VENDORS.some(vendor => domain.includes(vendor));

          // For Ticketmaster links, try to get the event ID
          if (domain.includes('ticketmaster.com')) {
            console.log('Found Ticketmaster link:', ticket.link);
            // First check if it's an event link
            const eventMatch = ticket.link.match(/event\/([A-Z0-9]+)|\/([A-Z0-9]{16}$)/);
            if (eventMatch) {
              console.log('Found direct Ticketmaster event link:', ticket.link);
              return {
                source: 'ticketmaster',
                url: ticket.link,
                is_primary: true
              };
            }

            // If not an event link, search for event links in the source HTML
            if (ticket.source) {
              const eventLinks = ticket.source.match(/href="(https?:\/\/[^"]*ticketmaster[^"]*\/event\/[A-Z0-9]+[^"]*)"/g) || [];
              if (eventLinks.length > 0 && eventLinks[0]) {
                // Extract the first event link found
                const match = eventLinks[0].match(/href="([^"]*)"/);
                if (match && match[1]) {
                  const eventUrl = match[1];
                  console.log('Found Ticketmaster event link in source:', eventUrl);
                  return {
                    source: 'ticketmaster',
                    url: eventUrl,
                    is_primary: true
                  };
                }
              }
            }

            // Return the artist page link if no event link found
            return {
              source: 'ticketmaster',
              url: ticket.link,
              is_primary: true
            };
          }

          const eventLink: EventLink = {
            source: this.normalizeVendorName(domain),
            url: ticket.link,
            is_primary: isPriorityVendor
          };

          console.log('Created event link:', {
            original: {
              source: ticket.source,
              link: ticket.link,
              link_type: ticket.link_type
            },
            processed: eventLink
          });

          return eventLink;
        } catch (error) {
          console.error('Error processing ticket link:', error);
          return null;
        }
      })
      .filter((link): link is EventLink => link !== null);

    console.log('Extracted ticket links:', links);
    return links;
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

  private groupTicketResults(results: any[], keyword: string): SearchResult[] {
    // Group results by event based on title similarity and venue
    const groups = new Map<string, any[]>();
    
    results.forEach(result => {
      const title = result.title.toLowerCase();
      const foundGroup = Array.from(groups.keys()).find(key => 
        this.calculateTitleSimilarity(key, title) > 0.8
      );

      if (foundGroup) {
        groups.get(foundGroup)!.push(result);
      } else {
        groups.set(title, [result]);
      }
    });

    return Array.from(groups.entries()).map(([title, groupResults]) => {
      const ticketLinks = groupResults.map(result => ({
        source: this.normalizeVendorName(new URL(result.link).hostname),
        url: result.link,
        is_primary: this.PRIORITY_VENDORS.some(v => result.link.includes(v)),
        price: result.price
      }));

      return {
        name: keyword,
        date: '', // Will need to be extracted from result snippets
        venue: '', // Will need to be extracted from result snippets
        location: {
          city: 'Unknown',
          state: 'Unknown',
          country: 'US'
        },
        ticket_links: ticketLinks,
        source: this.determinePrimarySource(ticketLinks)
      };
    });
  }

  private calculateTitleSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();
    const longer = s1.length > s2.length ? s1 : s2;
    const shorter = s1.length > s2.length ? s2 : s1;
    
    if (longer.length === 0) return 1.0;
    
    return (longer.length - this.editDistance(longer, shorter)) / longer.length;
  }

  private editDistance(s1: string, s2: string): number {
    const costs: number[] = [];
    for (let i = 0; i <= s1.length; i++) {
      let lastValue = i;
      for (let j = 0; j <= s2.length; j++) {
        if (i === 0) {
          costs[j] = j;
        } else if (j > 0) {
          let newValue = costs[j - 1];
          if (s1.charAt(i - 1) !== s2.charAt(j - 1)) {
            newValue = Math.min(Math.min(newValue, lastValue), costs[j]) + 1;
          }
          costs[j - 1] = lastValue;
          lastValue = newValue;
        }
      }
      if (i > 0) costs[s2.length] = lastValue;
    }
    return costs[s2.length];
  }

  private isMatchingEvent(event1: SearchResult, name2: string, venue2?: string, date2?: string): boolean {
    // Compare event names
    const name1Norm = this.normalizeEventName(event1.name);
    const name2Norm = this.normalizeEventName(name2);
    const nameMatch = name1Norm.includes(name2Norm) || name2Norm.includes(name1Norm);
    
    if (!nameMatch || !date2 || !event1.date) {
      return nameMatch;
    }

    // Check if dates match
    if (!areDatesMatching(event1.date, date2)) {
      return false;
    }

    // If we have multiple events for this artist/venue on this day,
    // we need to match the time as well
    const multipleEvents = this.hasMultipleEventsOnDay(event1.name, event1.venue, new Date(event1.date));
    
    if (multipleEvents) {
      return doDateTimesMatch(event1.date, date2);
    }

    // Single event that day - dates match
    return true;
  }

  private hasMultipleEventsOnDay(artistName: string, venue: string, date: Date): boolean {
    const eventsOnDay = this.currentSearchResults.filter((event: SearchResult) => {
      if (!event.date) return false;
      return event.name === artistName &&
             event.venue === venue &&
             areDatesMatching(event.date, date);
    });

    return eventsOnDay.length > 1;
  }

  private normalizeEventName(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, '') // Remove special characters
      .replace(/\s+/g, ' ')        // Normalize spaces
      .trim();
  }

  private getTimezoneFromLocation(city: string, state: string): string {
    // Map of US states to their primary timezone
    const stateTimezones: Record<string, string> = {
      'AK': 'America/Anchorage',
      'AL': 'America/Chicago',
      'AR': 'America/Chicago',
      'AZ': 'America/Phoenix',
      'CA': 'America/Los_Angeles',
      'CO': 'America/Denver',
      'CT': 'America/New_York',
      'DC': 'America/New_York',
      'DE': 'America/New_York',
      'FL': 'America/New_York',
      'GA': 'America/New_York',
      'HI': 'Pacific/Honolulu',
      'IA': 'America/Chicago',
      'ID': 'America/Boise',
      'IL': 'America/Chicago',
      'IN': 'America/Indiana/Indianapolis',
      'KS': 'America/Chicago',
      'KY': 'America/New_York',
      'LA': 'America/Chicago',
      'MA': 'America/New_York',
      'MD': 'America/New_York',
      'ME': 'America/New_York',
      'MI': 'America/Detroit',
      'MN': 'America/Chicago',
      'MO': 'America/Chicago',
      'MS': 'America/Chicago',
      'MT': 'America/Denver',
      'NC': 'America/New_York',
      'ND': 'America/Chicago',
      'NE': 'America/Chicago',
      'NH': 'America/New_York',
      'NJ': 'America/New_York',
      'NM': 'America/Denver',
      'NV': 'America/Los_Angeles',
      'NY': 'America/New_York',
      'OH': 'America/New_York',
      'OK': 'America/Chicago',
      'OR': 'America/Los_Angeles',
      'PA': 'America/New_York',
      'RI': 'America/New_York',
      'SC': 'America/New_York',
      'SD': 'America/Chicago',
      'TN': 'America/Chicago',
      'TX': 'America/Chicago',
      'UT': 'America/Denver',
      'VA': 'America/New_York',
      'VT': 'America/New_York',
      'WA': 'America/Los_Angeles',
      'WI': 'America/Chicago',
      'WV': 'America/New_York',
      'WY': 'America/Denver'
    };

    // Special cases for cities that are in different timezones than their state's primary timezone
    const cityOverrides: Record<string, string> = {
      'Michigan City': 'America/Chicago', // IN
      'Tell City': 'America/Chicago',     // IN
      'Starke': 'America/Chicago',        // FL
      'Gulf': 'America/Chicago',          // FL
      'Bay': 'America/Chicago'            // FL
    };

    // Check for city override first
    if (cityOverrides[city]) {
      return cityOverrides[city];
    }

    // Fall back to state timezone, defaulting to Eastern if not found
    return stateTimezones[state] || 'America/New_York';
  }
}

export default GoogleEventsSearcher;