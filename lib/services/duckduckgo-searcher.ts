import { webReaderService } from './parsehub-service';
import { getParser } from './llm-service';
import { normalizeDateTime } from '../utils/date-utils';
import * as cheerio from 'cheerio';
import type { EventSearchResult } from '../types/schemas';

export class DuckDuckGoSearcher {
  private parser;

  constructor() {
    this.parser = getParser('gemini');
  }

  async searchConcerts(keyword: string, location: string, city?: string): Promise<EventSearchResult[]> {
    try {
      // Build search query
      const searchTerms = [
        keyword,
        'tickets',
        location || city || ''
      ].filter(Boolean);

      const searchQuery = searchTerms.join(' ');
      const encodedQuery = encodeURIComponent(searchQuery);
      
      // Search on DuckDuckGo
      const searchUrl = `https://duckduckgo.com/html/?q=${encodedQuery}`;
      console.log('Searching DuckDuckGo:', searchUrl);
      
      const html = await webReaderService.fetchPage(searchUrl);
      console.log(`Got ${html.length} bytes from DuckDuckGo`);

      // Parse search results
      const $ = cheerio.load(html);
      const results = $('.result');
      console.log(`Found ${results.length} search results`);

      const eventPromises = results.map(async (_, result) => {
        const $result = $(result);
        const title = $result.find('.result__title').text().trim();
        const snippet = $result.find('.result__snippet').text().trim();
        
        // Extract the actual URL from DuckDuckGo's redirect URL
        const ddgUrl = $result.find('.result__url').attr('href');
        if (!ddgUrl) return null;

        // Parse the actual URL from DuckDuckGo's redirect
        const urlMatch = ddgUrl.match(/uddg=([^&]+)/);
        if (!urlMatch) return null;
        
        const url = decodeURIComponent(urlMatch[1]);
        console.log('Extracted URL:', url);

        // Skip non-ticket vendor URLs
        const urlLower = url.toLowerCase();
        const isTicketSite = urlLower.includes('ticketmaster.com') || 
                            urlLower.includes('livenation.com') ||
                            urlLower.includes('stubhub.com') ||
                            urlLower.includes('vividseats.com');

        if (!isTicketSite) return null;

        // Extract initial event data from title and snippet
        const eventData = await this.parser.parseEvents(`${title}\n${snippet}`);
        if (!eventData?.events?.length) return null;

        const event = eventData.events[0];
        
        // Extract date and time information
        let eventDate = '';
        const dateTimeMatch = snippet.match(/(\w+)\s+(\d{1,2})\s*(?:•|,)?\s*(?:\w+)?\s*(?:•|,)?\s*(\d{1,2}):(\d{2})(AM|PM)/i);
        if (dateTimeMatch) {
          const [_, month, day, hours, minutes, meridiem] = dateTimeMatch;
          const year = '2025'; // Hardcoded for now since it's in the future
          let hour = parseInt(hours);
          if (meridiem.toLowerCase() === 'pm' && hour < 12) hour += 12;
          if (meridiem.toLowerCase() === 'am' && hour === 12) hour = 0;
          
          eventDate = `${year}-${this.getMonthNumber(month)}-${day.padStart(2, '0')}T${hour.toString().padStart(2, '0')}:${minutes}:00.000Z`;
          console.log('Extracted date/time:', eventDate);
        } else if (event.date) {
          // Try to extract time from the event date if available
          const timeMatch = event.date.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
          if (timeMatch) {
            const [_, hours, minutes, meridiem] = timeMatch;
            let hour = parseInt(hours);
            if (meridiem.toLowerCase() === 'pm' && hour < 12) hour += 12;
            if (meridiem.toLowerCase() === 'am' && hour === 12) hour = 0;
            
            // Combine with the date
            const dateMatch = event.date.match(/(\w+)\s+(\d{1,2})(?:\s*,\s*|\s+)(\d{4})/);
            if (dateMatch) {
              const [_, month, day, year] = dateMatch;
              eventDate = `${year}-${this.getMonthNumber(month)}-${day.padStart(2, '0')}T${hour.toString().padStart(2, '0')}:${minutes}:00.000Z`;
              console.log('Extracted date/time from event:', eventDate);
            }
          }
        }

        // If no time found, make one more attempt from the URL
        if (!eventDate && urlLower.includes('ticketmaster.com')) {
          const urlDateMatch = url.match(/(\d{2})-(\d{2})-(\d{4})/);
          if (urlDateMatch) {
            const [_, month, day, year] = urlDateMatch;
            // Default to 6:00 PM if no time found
            eventDate = `${year}-${month}-${day}T18:00:00.000Z`;
            console.log('Using default time from URL date:', eventDate);
          }
        }

        return {
          name: event.name || title,
          date: eventDate || event.date || '',
          venue: event.venue || '',
          location: event.location ? {
            city: event.location.split(',')[0]?.trim() || '',
            state: event.location.split(',')[1]?.trim() || '',
            country: 'US'
          } : undefined,
          source: this.getSourceFromUrl(url),
          link: url,
          description: snippet,
          ticket_links: [{
            source: this.getSourceFromUrl(url),
            url: url,
            is_primary: urlLower.includes('ticketmaster.com') || urlLower.includes('livenation.com')
          }],
          has_ticketmaster: urlLower.includes('ticketmaster.com') || urlLower.includes('livenation.com')
        };
      }).get();

      const events = (await Promise.all(eventPromises)).filter(Boolean);
      console.log(`Found ${events.length} valid events`);
      
      return events;
    } catch (error) {
      console.error('Error searching DuckDuckGo:', error);
      return [];
    }
  }

  private getSourceFromUrl(url: string): string {
    const urlLower = url.toLowerCase();
    if (urlLower.includes('ticketmaster.com')) return 'ticketmaster';
    if (urlLower.includes('livenation.com')) return 'livenation';
    if (urlLower.includes('stubhub.com')) return 'stubhub';
    if (urlLower.includes('vividseats.com')) return 'vividseats';
    return 'unknown';
  }

  private getMonthNumber(month: string): string {
    const months: Record<string, string> = {
      'jan': '01', 'january': '01',
      'feb': '02', 'february': '02',
      'mar': '03', 'march': '03',
      'apr': '04', 'april': '04',
      'may': '05',
      'jun': '06', 'june': '06',
      'jul': '07', 'july': '07',
      'aug': '08', 'august': '08',
      'sep': '09', 'september': '09',
      'oct': '10', 'october': '10',
      'nov': '11', 'november': '11',
      'dec': '12', 'december': '12'
    };
    return months[month.toLowerCase()] || '01';
  }
} 