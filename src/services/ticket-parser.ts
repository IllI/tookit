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
  listing_id: string;
  source: 'stubhub' | 'vividseats';
  date_posted: string;
  sold: boolean;
}

interface ParsedResponse {
  events?: EventData[];
  tickets?: TicketData[];
}

export class TicketParser {
  private dom: JSDOM;
  private source: 'stubhub' | 'vividseats';

  constructor(htmlContent: string, source: 'stubhub' | 'vividseats') {
    this.dom = new JSDOM(htmlContent, {
      runScripts: 'outside-only',
      resources: 'usable',
      features: {
        FetchExternalResources: false,
        ProcessExternalResources: false,
        SkipExternalResources: true
      }
    });
    this.source = source;
  }

  private getQuantityFromText(text: string): number {
    const match = text.match(/(\d+)(?:\s*-\s*(\d+))?\s*tickets?/i);
    if (match) {
      return parseInt(match[2] || match[1]);
    }
    return 1;
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
      .replace(/(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:day)?/gi, '') // Remove day of week
      .trim();

    console.log('Cleaned date string:', cleaned);

    try {
      let match;
      
      if (source === 'vividseats') {
        // Handle VividSeats format: "Dec 2510:00pm" or "Dec 25 10:00 pm"
        match = cleaned.match(/([A-Za-z]{3})\s*(\d{1,2})\s*(\d{1,2}):(\d{2})\s*(am|pm)/i);
        if (match) {
          const [, month, day, hours, minutes, ampm] = match;
          // Use current year as default
          const currentYear = new Date().getFullYear();
          
          // If the date is in the past for the current year, use next year
          const eventDate = new Date(`${month} ${day} ${currentYear}`);
          const now = new Date();
          const year = eventDate < now ? currentYear + 1 : currentYear;

          return this.createDateFromParts(month, day, year, hours, minutes, ampm);
        }
      } else {
        // Handle StubHub format
        match = cleaned.match(/([A-Za-z]{3})\s+(\d{1,2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i) ||  // Dec 25 10:00 PM
               cleaned.match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{1,2}):(\d{2})\s*(AM|PM)/i);      // 25 Dec 10:00 PM
        
        if (match) {
          let month, day, hours, minutes, ampm;
          
          if (match[1].match(/[A-Za-z]/)) {
            // First format: "Dec 25 10:00 PM"
            [, month, day, hours, minutes, ampm] = match;
          } else {
            // Second format: "25 Dec 10:00 PM"
            [, day, month, hours, minutes, ampm] = match;
          }

          const currentYear = new Date().getFullYear();
          const eventDate = new Date(`${month} ${day} ${currentYear}`);
          const now = new Date();
          const year = eventDate < now ? currentYear + 1 : currentYear;

          return this.createDateFromParts(month, day, year, hours, minutes, ampm);
        }
      }

      console.error(`Failed to parse ${source} date:`, cleaned);
      throw new Error(`Invalid date format: ${dateStr}`);

    } catch (error) {
      console.error('Error standardizing date:', error);
      throw error;
    }
  }

  // Helper method to create date from parts
  private createDateFromParts(month: string, day: string, year: number, hours: string, minutes: string, ampm: string): string {
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
      year,
      monthIndex,
      parseInt(day),
      hour,
      parseInt(minutes)
    );

    if (isNaN(date.getTime())) {
      throw new Error('Invalid date components');
    }

    console.log('Standardized date:', {
      input: `${month} ${day} ${year} ${hours}:${minutes} ${ampm}`,
      components: { month, day, year, hours, minutes, ampm },
      output: date.toISOString()
    });

    return date.toISOString();
  }

  parseSearchResults(): ParsedResponse {
    // Use source-specific parser
    return this.source === 'stubhub' 
      ? this.parseStubHubSearch()
      : this.parseVividSeatsSearch();
  }

  private parseStubHubSearch(): ParsedResponse {
    const document = this.dom.window.document;
    const events: EventData[] = [];

    // Check if we're on a search page by looking for the search results grid
    const isSearchPage = !!document.querySelector('ul[data-testid="primaryGrid"]');
    
    // If not a search page, return empty events array
    if (!isSearchPage) {
      console.log('Not a search page, skipping event creation');
      return { events };
    }

    // Find event listings by looking for links to event pages
    const eventLinks = Array.from(document.querySelectorAll('a[href*="/event/"]'))
      .filter(a => a.getAttribute('href')?.includes('tickets'));

    console.log(`Found ${eventLinks.length} StubHub event links`);

    eventLinks.forEach(link => {
      try {
        const href = link.getAttribute('href') || '';
        const cleanUrl = href.split('?')[0];

        // Get the parent list item container
        const container = link.closest('li');
        if (!container) return;

        // Get all spans with text content
        const allSpans = Array.from(container.querySelectorAll('span'))
          .map(span => span.textContent?.trim())
          .filter(text => text && 
            !text.includes('See tickets') &&
            !text.includes('Favorite') &&
            !text.includes('Sort by') &&
            !text.includes('Join the list') &&
            !text.includes('No tickets available'));

        // Get event name from first meaningful span
        const name = allSpans[0];

        // Find location (City, ST format) first
        const location = allSpans.find(text => 
          text.match(/[A-Za-z\s]+,\s*[A-Z]{2}(?:,\s*USA)?$/));

        if (!location) {
          console.error('No location found');
          return;
        }

        // Parse city and state from location
        const [city, state] = location.split(',').map(s => s.trim());
        const stateCode = state?.replace(/, USA$/, '');

        // Find venue - it should be between the event name and location in the spans
        const nameIndex = allSpans.findIndex(text => text === name);
        const locationIndex = allSpans.findIndex(text => text === location);

        let venue: string | undefined;
        if (nameIndex !== -1 && locationIndex !== -1 && nameIndex < locationIndex) {
          // Get the span that appears between name and location
          const possibleVenues = allSpans.slice(nameIndex + 1, locationIndex);
          venue = possibleVenues.find(text => 
            text !== name && 
            text !== location && 
            !text.match(/[A-Za-z\s]+,\s*[A-Z]{2}(?:,\s*USA)?$/) // Not a location format
          );
        }

        console.log('Venue parsing:', {
          allSpans,
          name,
          nameIndex,
          locationIndex,
          possibleVenues: allSpans.slice(nameIndex + 1, locationIndex),
          selectedVenue: venue
        });

        // Get date from time element
        const timeEl = container.querySelector('time');
        const dateParts = Array.from(timeEl?.querySelectorAll('div') || [])
          .map(div => div.textContent?.trim())
          .filter(Boolean);

        const dateStr = dateParts[0] || '';
        const timePart = dateParts.find(part => part.match(/\d{1,2}:\d{2}/)) || '';
        const dateText = `${dateStr} ${timePart}`.trim();

        // Validate and add event
        if (name && venue && city && stateCode && dateText) {
          events.push({
            name,
            date: this.standardizeDate(dateText, 'stubhub'),
            venue,
            city,
            state: stateCode,
            country: 'USA',
            location: `${city}, ${stateCode}`,
            source: 'stubhub',
            source_url: cleanUrl.startsWith('http') ? cleanUrl : `https://www.stubhub.com${cleanUrl}`,
            eventUrl: `${cleanUrl}${cleanUrl.includes('?') ? '&' : '?'}quantity=0`
          });
        }

      } catch (error) {
        console.error('Error parsing StubHub event:', error);
      }
    });

    return { events };
  }

  private parseVividSeatsSearch(): ParsedResponse {
    const document = this.dom.window.document;
    const events: EventData[] = [];

    // Find event listings using data-testid attribute
    const eventListings = document.querySelectorAll('div[data-testid^="production-listing-"]');
    console.log(`Found ${eventListings.length} VividSeats event items`);

    eventListings.forEach(listing => {
      try {
        // Get link from the direct child <a> element
        const link = listing.querySelector('a');
        const href = link?.getAttribute('href') || '';
        const fullUrl = href.startsWith('http') ? href : `https://www.vividseats.com${href}`;
        
        // Get date from date-time element
        const dateElement = listing.querySelector('[data-testid="date-time-left-element"]');
        const dateText = dateElement?.textContent?.replace(/🔥.*?left/g, '').trim() || '';

        // Get subtitle section that contains venue and location
        const subtitleDiv = listing.querySelector('[data-testid="subtitle"]');
        const spans = Array.from(subtitleDiv?.querySelectorAll('span') || []);
        
        // First span in subtitle is venue
        const venue = spans[0]?.textContent?.replace(/•/g, '').trim() || '';
        
        // Last span in subtitle is location
        const locationText = spans[spans.length - 1]?.textContent?.replace(/•/g, '').trim() || '';

        // Parse city and state from location
        const [city, state] = locationText.split(',').map(s => s.trim());
        const stateCode = state?.replace(/, USA$/, '');

        // Get name from URL pattern
        const urlMatch = href.match(/\/([^/]+)-tickets/);
        const name = urlMatch ? 
          urlMatch[1].replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()) : '';

        console.log('VividSeats extracted data:', {
          url: href,
          name,
          date: dateText,
          venue,
          city,
          state: stateCode,
          location: locationText
        });

        if (name && dateText && venue && city && stateCode && href) {
          events.push({
            name,
            date: this.standardizeDate(dateText, 'vividseats'),
            venue,
            city,
            state: stateCode,
            country: 'USA',
            location: `${city}, ${stateCode}`,
            source: 'vividseats',
            source_url: fullUrl,
            eventUrl: fullUrl
          });
        }
      } catch (error) {
        console.error('Error parsing VividSeats event:', error);
      }
    });

    return { events };
  }

  parseEventTickets(): ParsedResponse {
    const tickets = this.parseTickets();
    return { tickets };
  }

  private parseTickets(): TicketData[] {
    return this.source === 'stubhub' 
      ? this.parseStubHubTickets()
      : this.parseVividSeatsTickets();
  }

  private parseStubHubTickets(): TicketData[] {
    const document = this.dom.window.document;
    const tickets: TicketData[] = [];
  
    // Find all ticket listings - they're usually in a table or list
    const listings = Array.from(document.querySelectorAll('[data-listing-id], [data-testid*="listing"]'));
    console.log(`Found ${listings.length} StubHub listings`);
  
    listings.forEach((listing) => {
      try {
        // Skip if ticket is sold
        const soldText = listing.textContent?.toLowerCase() || '';
        if (soldText.includes('sold')) {
          return;
        }

        const listingId = listing.getAttribute('data-listing-id') || 
                         listing.getAttribute('data-testid')?.split('-').pop() ||
                         `stubhub-${Date.now()}-${Math.random()}`;
  
        // Try multiple ways to get price
        const priceText = listing.getAttribute('data-price') || 
                         listing.querySelector('[data-testid*="price"]')?.textContent ||
                         listing.textContent?.match(/\$\d+(?:\.\d{2})?/)?.[0] || '0';
      
        const price = parseFloat(priceText.replace(/[^0-9.]/g, ''));
  
        // Parse section and row more carefully
        const sectionText = listing.textContent || '';
        
        let section = 'GA';  // Default to GA
        let row: string | undefined;

        // Check for VIP tickets first
        if (sectionText.toLowerCase().includes('vip')) {
          section = 'VIP';
        } else {
          // Try to find specific section numbers/names
          const sectionMatch = sectionText.match(/Section\s+([A-Z0-9]+)/i);
          if (sectionMatch) {
            section = sectionMatch[1].trim();
          }
        }

        // Look for row information
        const rowMatch = sectionText.match(/Row\s+([A-Z0-9]+)/i);
        if (rowMatch) {
          row = rowMatch[1].trim();
        }

        // Get quantity - try multiple patterns
        const quantityText = sectionText.match(/(\d+)(?:\s*-\s*(\d+))?\s*tickets?/i) || 
                            sectionText.match(/Qty:\s*(\d+)/i) ||
                            ['', '1'];
        const quantity = parseInt(quantityText[2] || quantityText[1] || '1');

        console.log('Parsed StubHub ticket:', {
          section,
          row,
          price,
          quantity,
          listingId,
          fullText: sectionText.slice(0, 100)
        });
  
        if (price > 0) {
          tickets.push({
            section,
            row,
            price,
            quantity,
            listing_id: listingId,
            source: 'stubhub',
            date_posted: new Date().toISOString(),
            sold: false
          });
        }
      } catch (error) {
        console.error('Error parsing StubHub ticket:', error);
      }
    });
  
    return tickets;
  }
  
  private parseVividSeatsTickets(): TicketData[] {
    const document = this.dom.window.document;
    const tickets: TicketData[] = [];

    const ticketRows = document.querySelectorAll('[data-testid="listings-container"]');
    console.log(`Found ${ticketRows.length} VividSeats ticket rows`);

    ticketRows.forEach(row => {
      try {
        const listing_id = row.getAttribute('data-testid') || '';
        const ticketText = row.textContent || '';

        // Default to GA unless we find specific section info
        let section = 'GA';
        let row_number: string | undefined;

        // Check for VIP first
        if (ticketText.toLowerCase().includes('vip')) {
          section = 'VIP';
        } else {
          // Look for specific section numbers/names
          const sectionMatch = ticketText.match(/Section\s+([A-Z0-9]+)/i);
          if (sectionMatch) {
            section = sectionMatch[1].trim();
          }
        }

        // Look for row information
        const rowMatch = ticketText.match(/Row\s+([A-Z0-9]+)/i);
        if (rowMatch) {
          row_number = rowMatch[1].trim();
        }

        // Get price
        const priceEl = row.querySelector('[data-testid="listing-price"]');
        const priceText = priceEl?.textContent?.trim() || '0';
        const price = parseFloat(priceText.replace(/[^0-9.]/g, ''));

        // Get quantity
        const quantityEl = row.querySelector('[data-testid="ticket-quantity"]');
        const quantityText = quantityEl?.textContent || '1';
        const quantity = this.getQuantityFromText(quantityText);

        console.log('Parsed VividSeats ticket:', {
          section,
          row: row_number,
          price,
          quantity,
          listing_id,
          fullText: ticketText.slice(0, 100)
        });

        if (price > 0) {
          tickets.push({
            section,
            row: row_number,
            price,
            quantity,
            listing_id,
            source: 'vividseats',
            date_posted: new Date().toISOString(),
            sold: false
          });
        }
      } catch (error) {
        console.error('Error parsing VividSeats ticket:', error);
      }
    });

    return tickets;
  }


} 