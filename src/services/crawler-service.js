import { createClient } from '@supabase/supabase-js';
import { firecrawlService } from './firecrawl-service.ts';
import { getParser } from './llm-service';
const cheerio = require('cheerio');

class CrawlerService {
  constructor() {
    this.firecrawl = firecrawlService;
    this.parser = getParser();
    this.maxAttempts = 3;
    this.retryDelays = [2000, 3000, 4000];
    this.processedEvents = new Set();
    
    // Initialize Supabase client
    this.supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );
    this.searchService = null;
  }

  setSearchService(service) {
    this.searchService = service;
  }

  sendStatus(message) {
    if (this.searchService) {
      this.searchService.emit('status', message);
    }
    console.log(message);
  }

  async asyncCrawlSearch(searchUrl, options = {}) {
    console.log(`Starting search crawl for: ${searchUrl}`);
    console.log('Search options:', options);
    let attempt = 1;
    let response = null;

    while (attempt <= this.maxAttempts) {
      try {
        console.log(`Attempt ${attempt}/${this.maxAttempts} to scrape: ${searchUrl}`);
        response = await this.firecrawl.scrapeUrl(searchUrl, options);
        
        if (response?.html) {
          console.log('Search response:', {
            hasData: !!response,
            hasHtml: !!response?.html,
            hasMarkdown: !!response?.markdown,
            hasLinks: !!response?.links
          });
          break; // Success - exit retry loop
        }

        console.log(`Attempt ${attempt} failed - no HTML in response`);
        if (attempt === this.maxAttempts) {
          throw new Error('Failed to get HTML content after all attempts');
        }

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, this.retryDelays[attempt - 1]));
        attempt++;

      } catch (error) {
        console.error(`Error in attempt ${attempt}:`, error);
        if (attempt === this.maxAttempts) throw error;
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, this.retryDelays[attempt - 1]));
        attempt++;
      }
    }

    // Process the successful response
    if (response?.extract?.events) {
      return {
        source: searchUrl.includes('stubhub') ? 'stubhub' : 'vividseats',
        events: response.extract.events
      };
    }

    // Return empty events array if no events found
    return {
      source: searchUrl.includes('stubhub') ? 'stubhub' : 'vividseats',
      events: []
    };
  }

  async asyncCrawlEvent(eventUrl, eventInfo, options = {}) {
    console.log(`Starting event crawl for: ${eventUrl}`);
    let attempt = 1;
    let response = null;

    while (attempt <= this.maxAttempts) {
      try {
        console.log(`Attempt ${attempt}/${this.maxAttempts} to scrape event: ${eventUrl}`);
        response = await this.firecrawl.scrapeUrl(eventUrl, options);
        
        if (response?.html) {
          console.log('Event response:', {
            hasData: !!response,
            hasHtml: !!response?.html,
            hasMarkdown: !!response?.markdown,
            hasExtract: !!response?.extract
          });
          break; // Success - exit retry loop
        }

        console.log(`Attempt ${attempt} failed - no HTML in response`);
        if (attempt === this.maxAttempts) {
          throw new Error('Failed to get HTML content after all attempts');
        }

        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, this.retryDelays[attempt - 1]));
        attempt++;

      } catch (error) {
        console.error(`Error in attempt ${attempt}:`, error);
        if (attempt === this.maxAttempts) throw error;
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, this.retryDelays[attempt - 1]));
        attempt++;
      }
    }

    // Process the successful response
    if (response?.extract?.tickets) {
      await this.processTicketData(
        response.extract.tickets,
        eventInfo.id,
        eventUrl.includes('stubhub') ? 'stubhub' : 'vividseats'
      );
      return true;
    }

    // If no extract data, try parsing the HTML directly
    if (response?.html) {
      const partialResult = await this.parser.parseContent(
        response.html || response.markdown || '',
        eventUrl,
        {},
        true
      );

      const tickets = partialResult?.tickets || [];
      await this.processTicketData(
        tickets,
        eventInfo.id,
        eventUrl.includes('stubhub') ? 'stubhub' : 'vividseats'
      );
      return true;
    }

    return false;
  }

  async processEventData(parsedContent, source) {
    const events = [];
    
    if (source === 'stubhub') {
      // Parse StubHub search results
      const eventLinks = parsedContent.links?.filter(link => 
        link.includes('/event/') || link.includes('/tickets/')
      ) || [];

      console.log(`Found ${eventLinks.length} StubHub event links`);

      // For each event link found
      for (const link of eventLinks) {
        try {
          // Use markdown since it's cleaner than HTML
          const eventText = parsedContent.markdown;
          
          // Extract event details using patterns from ticket-parser.ts
          const dateMatch = eventText.match(/([A-Z][a-z]{2}\s+\d{1,2}\s+\d{4})/);
          const timeMatch = eventText.match(/(\d{1,2}:\d{2}\s*[AP]M)/i);
          const locationMatch = eventText.match(/([^,]+),\s*([A-Z]{2}),\s*([A-Z]+)/);
          
          if (dateMatch && locationMatch) {
            const eventData = {
              name: eventText.split('\n').find(line => 
                !line.includes('PM') && 
                !line.includes('AM') && 
                !line.includes('202') && 
                line.length > 0
              )?.trim(),
              date: dateMatch[1],
              time: timeMatch?.[1],
              // Get venue from the line that appears right before the location
              venue: eventText.split('\n')
                .find((line, i, arr) => 
                  arr[i + 1]?.includes(locationMatch[0]) && 
                  line.length > 0 && 
                  !line.includes(dateMatch[0])
                )?.trim(),
              city: locationMatch[1]?.trim(),
              state: locationMatch[2],
              country: locationMatch[3]
            };

            events.push({
              name: eventData.name,
              date: new Date(`${eventData.date} ${eventData.time}`).toISOString(),
              venue: eventData.venue || 'Unknown Venue',
              city: eventData.city || 'Unknown City',
              state: eventData.state,
              country: eventData.country === 'USA' ? 'USA' : 'CAN',
              eventUrl: link.split('?')[0] // Remove query params
            });
          }
        } catch (error) {
          console.error('Error parsing StubHub event:', error);
        }
      }
    } else if (source === 'vividseats') {
      // Use cheerio to parse HTML
      const $ = cheerio.load(parsedContent.html);
      
      // Get all event rows
      $('[data-testid^="production-listing-row-"]').each((_, row) => {
        try {
          const $row = $(row);

          // Skip parking events
          const title = $row.find('.styles_titleTruncate__XiZ53').text();
          if (!title || title.toLowerCase().includes('parking')) {
            return;
          }

          // Get date components
          const dateElement = $row.find('[data-testid="date-time-left-element"]');
          const month = dateElement.find('.MuiTypography-small-bold').first().text(); // "Mar 21"
          const year = dateElement.find('.MuiTypography-small-bold').last().text(); // "2025"
          const time = dateElement.find('.MuiTypography-caption').text(); // "7:00pm"

          // Get venue and location
          const subtitleElement = $row.find('[data-testid="subtitle"]');
          const [venue, location] = subtitleElement.text().split('•').map(s => s.trim()) || [];
          const [city, state] = location.split(',').map(s => s.trim()) || [];

          // Get event URL
          const eventUrl = $row.closest('a').attr('href');
          if (!eventUrl) return;

          events.push({
            name: title,
            date: new Date(`${month} ${year} ${time}`).toISOString(),
            venue: venue || 'Unknown Venue',
            city: city || 'Unknown City',
            state: state?.replace('IL', 'Illinois'),
            country: 'USA',
            eventUrl: `https://www.vividseats.com${eventUrl}`
          });

        } catch (error) {
          console.error('Error parsing VividSeats event:', error);
        }
      });
    }

    // Process each event
    for (const event of events) {
      try {
        // Check for existing event
        const { data: existingEvents } = await this.supabase
          .from('events')
          .select('id, name, date, venue')
          .eq('city', event.city)
          .eq('state', event.state);

        let eventId = null;

        // Find matching event
        const matchingEvent = existingEvents?.find(existing => {
          const existingDate = new Date(existing.date);
          const eventDate = new Date(event.date);
          const timeDiff = Math.abs(existingDate.getTime() - eventDate.getTime());
          const hoursDiff = timeDiff / (1000 * 60 * 60);
          
          return hoursDiff <= 24 && this.areNamesSimilar(existing.name, event.name);
        });

        if (matchingEvent) {
          eventId = matchingEvent.id;
          console.log('Found matching event:', {
            name: matchingEvent.name,
            venue: matchingEvent.venue
          });

          // Add source link if it doesn't exist
          const { data: existingLinks } = await this.supabase
            .from('event_links')
            .select('url')
            .eq('event_id', eventId)
            .eq('source', source);

          if (!existingLinks?.length && event.eventUrl) {
            await this.supabase
              .from('event_links')
              .insert({
                event_id: eventId,
                source,
                url: event.eventUrl
              });
          }
        } else {
          // Create new event
          const { data: newEvent, error: insertError } = await this.supabase
            .from('events')
            .insert({
              name: event.name,
              date: event.date,
              venue: event.venue,
              city: event.city,
              state: event.state,
              country: event.country
            })
            .select()
            .single();

          if (insertError) {
            console.error('Error inserting event:', insertError);
            continue;
          }

          if (newEvent && event.eventUrl) {
            eventId = newEvent.id;
            await this.supabase
              .from('event_links')
              .insert({
                event_id: eventId,
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

  // Helper function to compare event names
  areNamesSimilar(name1, name2) {
    const clean1 = name1.toLowerCase().replace(/[^a-z0-9]/g, '');
    const clean2 = name2.toLowerCase().replace(/[^a-z0-9]/g, '');
    
    // Check for exact match after cleaning
    if (clean1 === clean2) return true;
    
    // Check if one name contains the other
    if (clean1.includes(clean2) || clean2.includes(clean1)) return true;
    
    // Could add more sophisticated comparison if needed
    
    return false;
  }

  async processTicketData(tickets, eventId, source) {
    try {
      if (!eventId) {
        console.error('No eventId provided for ticket processing');
        return;
      }

      // Log incoming data
      console.log('Processing tickets:', {
        ticketsReceived: tickets?.length || 0,
        eventId,
        source
      });

      // Ensure tickets is an array
      let ticketArray = [];
      if (Array.isArray(tickets)) {
        ticketArray = tickets;
      } else if (tickets?.tickets && Array.isArray(tickets.tickets)) {
        ticketArray = tickets.tickets;
      } else if (tickets) {
        ticketArray = [tickets];
      }

      // Filter out invalid tickets and deduplicate based on section, row, and price
      const seenTickets = new Set();
      ticketArray = ticketArray.filter(ticket => {
        if (!ticket || typeof ticket.price === 'undefined' || !ticket.section) {
          return false;
        }
        
        const key = `${ticket.section}-${ticket.row || ''}-${ticket.price}`;
        if (seenTickets.has(key)) {
          return false;
        }
        seenTickets.add(key);
        return true;
      });

      const ticketCount = ticketArray.length;
      console.log(`Found ${ticketCount} unique valid tickets for ${source}`);
      this.sendStatus(`Processing ${ticketCount} tickets for ${source}`);

      if (ticketCount === 0) {
        console.log(`No valid tickets found for ${source} event ${eventId}`);
        return;
      }

      // Map tickets to database format
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

      // Process tickets in smaller batches to avoid conflicts
      const batchSize = 50;
      const results = [];

      for (let i = 0; i < ticketData.length; i += batchSize) {
        const batch = ticketData.slice(i, i + batchSize);
        const { data, error } = await this.supabase
          .from('tickets')
          .upsert(batch, { 
            onConflict: 'event_id,section,row,price',
            returning: true 
          });

        if (error) {
          console.error('Database error in batch:', error);
          continue;
        }

        if (data) {
          results.push(...data);
        }
      }

      // Log the actual data returned
      console.log('Database response:', {
        inserted: results.length,
        attempted: ticketData.length
      });

      console.log(`Successfully saved ${results.length} tickets for ${source} event ${eventId}`);
      this.sendStatus(`Saved ${results.length} tickets for ${source}`);

      return results.length;

    } catch (error) {
      console.error(`Failed to process tickets for ${source}:`, error);
      this.sendStatus(`Error processing tickets for ${source}`);
      return 0;
    }
  }

  async updateEventLink(eventId, source, eventUrl) {
    try {
      // Check for existing event link
      const { data: existingLink } = await this.supabase
        .from('event_links')
        .select('url')
        .eq('event_id', eventId)
        .eq('source', source)
        .single();

      if (!existingLink) {
        console.log(`Adding new ${source} link for existing event`);
        await this.supabase
          .from('event_links')
          .insert({
            event_id: eventId,
            source,
            url: eventUrl
          });
      } else if (existingLink.url !== eventUrl) {
        console.log(`Updating ${source} link for event`);
        await this.supabase
          .from('event_links')
          .update({ url: eventUrl })
          .eq('event_id', eventId)
          .eq('source', source);
      } else {
        console.log(`Event link for ${source} already exists and matches`);
      }
    } catch (error) {
      console.error('Error updating event link:', error);
    }
  }
}

const crawlerService = new CrawlerService();
export { crawlerService }; 