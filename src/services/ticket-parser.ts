import { time } from 'console';
import { JSDOM } from 'jsdom';

interface EventData {
  name: string;
  date: string;
  venue: string;
  city: string;
  state: string;
  country: string;
  location: string;
  source: string;
  source_url: string;
  eventUrl: string;
}

interface TicketData {
  section: string;
  row?: string;
  price: number;
  quantity: number;
  listing_id?: string | null;
}

interface ParsedResponse {
  events?: EventData[];
  tickets?: TicketData[];
}

export class TicketParser {
  private dom: JSDOM;
  private source: 'stubhub' | 'vividseats';

  constructor(htmlContent: string, source: 'stubhub' | 'vividseats') {
    this.dom = new JSDOM(htmlContent);
    this.source = source;
  }

  private standardizeDate(dateStr: string, source: 'stubhub' | 'vividseats'): string {
    if (!dateStr) return '';
    
    console.log(`Standardizing ${source} date:`, dateStr);

    // If already ISO format, return as is
    if (dateStr.match(/^\d{4}-\d{2}-\d{2}T/)) {
      return dateStr;
    }

    // Clean up the input string
    let cleaned = dateStr
      .replace(/🔥.*?left/g, '')     // Remove emoji and "tickets left" text
      .replace(/\s+/g, ' ')          // Normalize spaces
      .replace(/(\d)(am|pm)/i, '$1 $2') // Add space before am/pm
      .trim();

    console.log('Cleaned date string:', cleaned);

    // Extract components based on source-specific patterns
    let match;
    if (source === 'stubhub') {
      // StubHub format: "21 Mar 2025 Fri 8:00 PM"
      match = cleaned.match(/(\d{1,2})\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{4})(?:\s*(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))?\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
    } else {
      // VividSeats format: "FriMar 2120257:00pm"
      match = cleaned.match(/(?:(Mon|Tue|Wed|Thu|Fri|Sat|Sun))?(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*(\d{1,2})\s*(\d{4})\s*(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
    }

    if (!match) {
      console.error(`Failed to parse ${source} date:`, cleaned);
      return dateStr;
    }

    try {
      let day, month, year, hours, minutes, ampm;
      
      if (source === 'stubhub') {
        [, day, month, year, hours, minutes, ampm] = match;
      } else {
        [, month, day, year, hours, minutes, ampm] = match;
      }

      // Convert month name to number
      const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
      const monthIndex = monthNames.indexOf(month.toLowerCase());
      if (monthIndex === -1) {
        throw new Error(`Invalid month: ${month}`);
      }

      // Convert to 24-hour time
      let hour = parseInt(hours);
      if (ampm.toLowerCase() === 'pm' && hour < 12) hour += 12;
      if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0;

      // Create date object
      const date = new Date(
        parseInt(year),
        monthIndex,
        parseInt(day),
        hour,
        parseInt(minutes)
      );

      if (isNaN(date.getTime())) {
        throw new Error('Invalid date components');
      }

      console.log('Standardized date:', {
        input: dateStr,
        cleaned,
        components: { day, month, year, hours, minutes, ampm },
        output: date.toISOString()
      });

      return date.toISOString();

    } catch (error) {
      console.error('Error standardizing date:', error);
      return dateStr;
    }
  }

  parseSearchResults(): ParsedResponse {
    // Only use direct DOM parsing for StubHub
    return this.parseStubHubSearch();
  }

  private parseStubHubSearch(): ParsedResponse {
    const document = this.dom.window.document;
    const events: EventData[] = [];

    // Find event containers - look for li elements that have both time and event link
    const eventContainers = Array.from(document.querySelectorAll('li'))
      .filter(li => {
        const hasTime = !!li.querySelector('time');
        const hasEventLink = !!li.querySelector('a[href*="/event/"]');
        return hasTime && hasEventLink;
      });

    eventContainers.forEach((container) => {
      try {
        // Get time element
        const timeEl = container.querySelector('time');
        const dateText = timeEl?.textContent?.trim() || '';
        
        // Get event link and URL
        const link = container.querySelector('a[href*="/event/"]');
        const href = link?.getAttribute('href')?.split('?')[0];

        // Get name - it's in a span with text content
        const nameSpan = container.querySelector('span[class*="t60ws5"]');
        const name = nameSpan?.textContent?.trim();

        // Get venue - it's in the second span with similar class
        const spans = container.querySelectorAll('span[class*="t60ws5"]');
        const venue = spans[1]?.textContent?.trim();

        // Get location - it's in the last span with that class, containing ", IL" or similar state code
        const locationSpan = Array.from(spans).find(span => 
          span.textContent?.match(/[A-Za-z\s]+,\s*[A-Z]{2}(?:,\s*USA)?$/)
        );
        const locationText = locationSpan?.textContent?.trim() || '';
        
        // Parse city and state from location
        const [city, state] = locationText.split(',').map(s => s.trim());
        const stateCode = state?.replace(/, USA$/, '');

        // Parse date components with improved regex to capture each part
        const dateMatch = dateText.match(/(\w{3})\s+(\d{1,2})\s+(\d{4})\s*(\w{3})\s*(\d{1,2}):(\d{2})\s*(AM|PM)/i);
        if (dateMatch) {
          const [, month, day, year, , hours, minutes, ampm] = dateMatch;
          
          // Convert month abbreviation to number
          const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
          const monthNum = monthNames.findIndex(m => m.toLowerCase() === month.toLowerCase()) + 1;
          
          // Convert to 24-hour format
          let hour = parseInt(hours);
          if (ampm.toLowerCase() === 'pm' && hour < 12) hour += 12;
          if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0;

          // Create ISO timestamp
          const date = new Date(
            parseInt(year),
            monthNum - 1, // JS months are 0-based
            parseInt(day),
            hour,
            parseInt(minutes)
          );

          if (name && venue && city && stateCode && href) {
            events.push({
              name,
              date: date.toISOString(),
              venue,
              city,
              state: stateCode,
              country: 'USA',
              location: `${city}, ${stateCode}`,
              source: 'stubhub',
              source_url: href.startsWith('http') ? href : `https://www.stubhub.com${href}`,
              eventUrl: href.startsWith('http') ? href : `https://www.stubhub.com${href}`
            });
          }
        }

      } catch (error) {
        console.error('Error parsing event:', error);
      }
    });

    return { events };
  }

  private parseVividSeatsSearch(): ParsedResponse {
    const document = this.dom.window.document;
    const events: EventData[] = [];

    // Find event listings using data-testid attribute as it's more reliable
    const eventItems = document.querySelectorAll('[data-testid^="production-listing-"]');
    console.log(`Found ${eventItems.length} VividSeats event items`);

    eventItems.forEach(item => {
      try {
        // Get link - VividSeats uses specific URL pattern
        const link = item.querySelector('a');
        const href = link?.getAttribute('href') || '';
        
        // Validate URL format
        if (!href.includes('/production/') || !href.includes('-tickets-')) {
          console.log('Invalid VividSeats URL format:', href);
          return;
        }

        // Get date using data-testid
        const dateElement = item.querySelector('[data-testid="date-time-left-element"]');
        const dateText = dateElement?.textContent?.replace(/🔥.*?left/g, '').trim() || '';

        // Get title and venue from subtitle section
        const subtitleDiv = item.querySelector('[data-testid="subtitle"]');
        const spans = Array.from(subtitleDiv?.querySelectorAll('span') || []);
        
        // Get clean title from URL
        const urlMatch = href.match(/\/(.*?)-tickets-/);
        const titleFromUrl = urlMatch ? 
          urlMatch[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : '';

        // Get venue and location from spans
        const venue = spans[0]?.textContent?.replace(/•/g, '').trim() || '';
        const locationText = spans[spans.length - 1]?.textContent?.replace(/•/g, '').trim() || '';
        
        // Parse city and state from location
        const [city, state] = locationText.split(',').map(s => s.trim());
        const stateCode = state?.replace(/, USA$/, '');

        if (titleFromUrl && dateText && venue && city && stateCode && href) {
          events.push({
            name: titleFromUrl,
            date: this.standardizeDate(dateText, 'vividseats'),
            venue,
            city,
            state: stateCode,
            country: 'USA',
            location: `${city}, ${stateCode}`,
            source: 'vividseats',
            source_url: href,
            eventUrl: href
          });
        }
      } catch (error) {
        console.error('Error parsing VividSeats event:', error);
      }
    });

    return { events };
  }

  parseEventTickets(): ParsedResponse {
    return this.source === 'stubhub'
      ? this.parseStubHubTickets()
      : this.parseVividSeatsTickets();
  }

  private parseStubHubTickets(): ParsedResponse {
    const document = this.dom.window.document;
    const tickets: TicketData[] = [];

    // Find ticket listings container
    const ticketContainer = document.querySelector('[data-testid="ticket-list"]');
    console.log('ticketContainer', ticketContainer);
    if (!ticketContainer) return { tickets };

    const listings = ticketContainer.querySelectorAll('[data-testid^="listing-"]');
    listings.forEach(listing => {
    
      try {
        const listingId = listing.getAttribute('data-listing-id') || undefined;
        const section = listing.querySelector('[data-testid*="section"]')?.textContent?.trim() || 'General';
        const row = listing.querySelector('[data-testid*="row"]')?.textContent?.trim();
        
        const priceText = listing.querySelector('[data-testid*="price"]')?.textContent || '0';
        const price = this.cleanPrice(priceText);

        const quantityText = listing.querySelector('[data-testid*="quantity"]')?.textContent || '1';
        const quantity = this.cleanQuantity(quantityText);

        if (section && price > 0) {
          tickets.push({ 
            section, 
            row: row || undefined,
            price, 
            quantity, 
            listing_id: listingId || undefined
          });
        }
      } catch (error) {
        console.error('Error parsing StubHub ticket:', error);
      }
    });

    return { tickets };
  }

  private parseVividSeatsTickets(): ParsedResponse {
    const document = this.dom.window.document;
    const tickets: TicketData[] = [];

    const ticketRows = document.querySelectorAll('[data-testid="ticket-row"]');
    ticketRows.forEach(row => {
      try {
        const listingId = row.getAttribute('data-listing-id') || undefined;
        const section = row.querySelector('[data-testid*="section"]')?.textContent?.trim() || 'General';
        const rowNum = row.querySelector('[data-testid*="row"]')?.textContent?.trim();
        
        const priceText = row.querySelector('[data-testid*="price"]')?.textContent || '0';
        const price = this.cleanPrice(priceText);

        const quantityText = row.querySelector('[data-testid*="quantity"]')?.textContent || '1';
        const quantity = this.cleanQuantity(quantityText);

        if (section && price > 0) {
          tickets.push({ 
            section, 
            row: rowNum || undefined,
            price, 
            quantity, 
            listing_id: listingId || undefined
          });
        }
      } catch (error) {
        console.error('Error parsing VividSeats ticket:', error);
      }
    });

    return { tickets };
  }

  private cleanPrice(priceStr: string): number {
    return parseFloat(priceStr.replace(/[^0-9.]/g, '')) || 0;
  }

  private cleanQuantity(quantityStr: string): number {
    const matches = quantityStr.match(/(\d+)(?:\s*-\s*(\d+))?\s*tickets?/i);
    if (matches) {
      return parseInt(matches[2] || matches[1]);
    }
    return parseInt(quantityStr.replace(/[^0-9]/g, '')) || 1;
  }
} 