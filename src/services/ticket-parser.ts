import { load } from 'cheerio';
import { parseLocation } from './utils';

export class TicketParser {
  private $: cheerio.Root;
  private source: string;
  private url: string;

  constructor(html: string, source: string) {
    this.$ = load(html);
    this.source = source;
    this.url = this.$('link[rel="canonical"]').attr('href') || '';
  }

  parseSearchResults() {
    if (this.source === 'stubhub') {
      return this.parseStubHubSearch();
    } else if (this.source === 'vividseats') {
      return this.parseVividSeatsSearch();
    }
    return { events: [] };
  }

  parseVividSeatsSearch() {
    const events: any[] = [];
    const listings = this.$('[data-testid^="production-listing-"]');
    console.log(`Found ${listings.length} VividSeats event items`);

    listings.each((i, elem) => {
      const cardContent = this.$(elem);
      const url = cardContent.find('a').first().attr('href') || '';
      const name = cardContent.find('[class*="ProductName"]').text().trim();
      const dateText = cardContent
        .find('[class*="DateAndTime"]')
        .text()
        .replace(/\s+/g, '');
      const date = this.standardizeDate(dateText, 'vividseats');
      const venue = cardContent.find('[class*="VenueName"]').text().trim();
      const { city, state } = parseLocation(
        cardContent.find('[class*="Location"]').text().trim()
      );
      const location = `${city}, ${state}`;

      const eventData = {
        url,
        name,
        date,
        venue,
        city,
        state,
        location,
      };
      console.log('VividSeats extracted data:', eventData);
      events.push(eventData);
    });

    return { events };
  }

  parseStubHubSearch() {
    const events: any[] = [];
    const listings = this.$('a[href*="/event/"]');
    console.log(`Found ${listings.length} StubHub event items`);

    listings.each((i, elem) => {
      const cardContent = this.$(elem);
      const url = cardContent.attr('href') || '';
      const name = cardContent.find('h3').text().trim();
      const dateText = cardContent
        .find('time')
        .text()
        .replace(/\s+/g, ' ')
        .trim();
      const date = this.standardizeDate(dateText, 'stubhub');
      const venueInfo = cardContent.find('span').eq(1).text().split('•');
      const venue = venueInfo[0].trim();
      const { city, state } = parseLocation(venueInfo[1]?.trim() || '');
      const location = `${city}, ${state}`;

      const eventData = {
        url,
        name,
        date,
        venue,
        city,
        state,
        location,
      };
      console.log('StubHub extracted data:', eventData);
      events.push(eventData);
    });

    return { events };
  }

  parseEventTickets() {
    if (this.source === 'stubhub') {
      return this.parseStubHubTickets();
    } else if (this.source === 'vividseats') {
      return this.parseVividSeatsTickets();
    }
    return { tickets: [] };
  }

  parseStubHubTickets() {
    const tickets: any[] = [];
    const listings = this.$('.TicketList-row');

    listings.each((i, elem) => {
      const listing = this.$(elem);
      tickets.push({
        section: listing.find('.section').text().trim(),
        row: listing.find('.row').text().trim(),
        price: parseFloat(
          listing.find('.price').text().replace(/[^0-9.]/g, '')
        ),
        quantity: parseInt(listing.find('.quantity').text().trim() || '1'),
        listing_id: `stubhub-${Date.now()}-${Math.random()}`
      });
    });

    return { tickets };
  }

  parseVividSeatsTickets() {
    const tickets: any[] = [];
    const listings = this.$('.ticket-list-item');

    listings.each((i, elem) => {
      const listing = this.$(elem);
      tickets.push({
        section: listing.find('.section').text().trim() || 'General',
        row: listing.find('.row').text().trim(),
        price: parseFloat(
          listing.find('.price').text().replace(/[^0-9.]/g, '')
        ),
        quantity: parseInt(listing.find('.quantity').text().trim() || '1'),
        listing_id: `vividseats-${Date.now()}-${Math.random()}`
      });
    });

    return { tickets };
  }

  private standardizeDate(dateStr: string, source: string): string {
    console.log(`Standardizing ${source} date: ${dateStr}`);
    try {
      if (source === 'vividseats') {
        // Example: "FriJun620257:30pm"
        const match = dateStr.match(
          /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?([A-Za-z]{3})(\d{1,2})(\d{4})(\d{1,2}):(\d{2})(am|pm)/i
        );
        if (!match) return '';

        const [, month, day, year, hours, minutes, ampm] = match;
        const cleanedDate = `${month} ${day}${year}${hours}:${minutes} ${ampm}`;
        const standardDate = this.createDate({
          month: month.toLowerCase(),
          day,
          year: parseInt(year),
          hours,
          minutes,
          ampm: ampm.toLowerCase()
        });

        return standardDate;
      } else if (source === 'stubhub') {
        // Example: "Fri Jun 6 2025 7:30PM"
        const match = dateStr.match(
          /(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*([A-Za-z]{3})\s*(\d{1,2})\s*(\d{4})\s*(\d{1,2}):(\d{2})(AM|PM)/i
        );
        if (!match) return '';

        const [, month, day, year, hours, minutes, ampm] = match;
        const standardDate = this.createDate({
          month: month.toLowerCase(),
          day,
          year: parseInt(year),
          hours,
          minutes,
          ampm: ampm.toLowerCase()
        });

        return standardDate;
      }
    } catch (error) {
      console.error(`Error standardizing date ${dateStr}:`, error);
    }
    return '';
  }

  private createDate({
    month,
    day,
    year,
    hours,
    minutes,
    ampm
  }: {
    month: string;
    day: string;
    year: number;
    hours: string;
    minutes: string;
    ampm: string;
  }) {
    console.log('Cleaned date string:', `${month} ${day}${year}${hours}:${minutes} ${ampm}`);
    const monthMap: { [key: string]: number } = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
    };

    let hr = parseInt(hours);
    if (ampm === 'pm' && hr < 12) hr += 12;
    if (ampm === 'am' && hr === 12) hr = 0;

    const date = new Date(year, monthMap[month], parseInt(day), hr, parseInt(minutes));

    console.log('Created date:', {
      input: { month, day, year, hours, minutes, ampm },
      output: date.toISOString()
    });

    return date.toISOString();
  }
}