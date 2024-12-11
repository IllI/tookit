import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { getParser } from './llm-service';
import { TicketParser } from './ticket-parser';

puppeteer.use(StealthPlugin());

class CrawlerService {
  constructor() {
    this.browser = null;
    this.parser = getParser();
    this.maxAttempts = 3;
    this.retryDelays = [2000, 3000, 4000];
    
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

  async initialize() {
    if (!this.browser) {
      const launchOptions = {
        //headless: 'new',
        headless: false,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920,1080',
          '--disable-blink-features=AutomationControlled'
        ],
        ignoreDefaultArgs: ['--enable-automation']
      };

      this.browser = await puppeteer.launch(launchOptions);
      console.log('Browser initialized');
    }
    return { browser: this.browser };
  }

  async crawlPage({ url, waitForSelector, searchParams }) {
    let context = null;
    let page = null;
    
    try {
      const { browser } = await this.initialize();
      context = await browser.createIncognitoBrowserContext();
      page = await context.newPage();
      
      // Enhanced stealth setup
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
      
      // Additional headers and webdriver settings
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
      });

      // Override navigator.webdriver
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined
        });
        window.navigator.chrome = {
          runtime: {}
        };
      });

      let attempt = 1;
      while (attempt <= this.maxAttempts) {
        try {
          console.log(`Attempt ${attempt}/${this.maxAttempts} to load: ${url}`);
          
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          
          // Wait for content to load
          await page.waitForFunction(
            () => document.body && document.body.innerText.length > 500,
            { timeout: 5000, polling: 100 }
          );

          const content = await page.evaluate(() => ({
            text: document.body.innerText,
            html: document.documentElement.outerHTML,
            title: document.title,
            url: window.location.href
          }));

          console.log('Page state:', {
            url: content.url,
            title: content.title,
            contentLength: content.text.length
          });

          if (content.text.length > 500) {
            console.log('Page loaded successfully');
            
            const isSearchPage = content.url.includes('search');
            const source = url.includes('stubhub') ? 'stubhub' : 'vividseats';
            
            // Use the TicketParser directly instead of Claude
            const parser = new TicketParser(content.html, source);
            const parsedContent = isSearchPage 
              ? parser.parseSearchResults()
              : parser.parseEventTickets();

            // Process events if this was a search page
            if (isSearchPage && parsedContent?.events) {
              await this.processEventData(parsedContent, source);
            } 
            // Process tickets if this was an event page
            else if (!isSearchPage && searchParams?.eventId) {
              const tickets = parsedContent?.tickets || [];
              console.log(`Found ${tickets.length} tickets to process`);
              await this.processTicketData(tickets, searchParams.eventId, source);
            }

            return {
              ...content,
              parsedContent
            };
          }

          console.log('Invalid content, retrying...');
          await page.waitForTimeout(this.retryDelays[attempt - 1]);
          attempt++;

        } catch (error) {
          console.error(`Error in attempt ${attempt}:`, error);
          if (attempt === this.maxAttempts) throw error;
          await page.waitForTimeout(this.retryDelays[attempt - 1]);
          attempt++;
        }
      }

      throw new Error('Failed to load page after all attempts');

    } finally {
      if (context) await context.close();
    }
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      console.log('Browser closed');
    }
  }

  async processEventData(parsedEvents, source) {
    if (!parsedEvents?.events?.length) {
      this.sendStatus(`No events found for ${source}`);
      return;
    }

    for (const event of parsedEvents.events) {
      try {
        console.log('Processing event:', JSON.stringify(event));
        this.sendStatus(`Processing event: ${event}`);
        
        if (event.name.toLowerCase().includes('parking')) {
          console.log('Skipping parking event:', event.name);
          continue;
        }

        const date = new Date(event.date);
        if (isNaN(date.getTime())) {
          console.error('Invalid date format:', event.date);
          continue;
        }

        // Check for existing event with fuzzy name matching
        const { data: existingEvents } = await this.supabase
          .from('events')
          .select('id, name, date, venue')
          .eq('venue', event.venue)
          .eq('city', event.city)
          .eq('state', event.state);

        let eventId = null;

        // Find matching event considering similar names and close dates
        if (existingEvents?.length) {
          const matchingEvent = existingEvents.find(existing => {
            const existingDate = new Date(existing.date);
            const timeDiff = Math.abs(existingDate.getTime() - date.getTime());
            const hoursDiff = timeDiff / (1000 * 60 * 60);
            
            // Consider events within 24 hours and with similar names as the same event
            const namesSimilar = this.areNamesSimilar(existing.name, event.name);
            return hoursDiff <= 24 && namesSimilar;
          });

          if (matchingEvent) {
            eventId = matchingEvent.id;
            console.log('Found matching event:', matchingEvent.name);
          }
        }

        if (eventId) {
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
                url: event.eventUrl
              });
          } else if (existingLink.url !== event.eventUrl) {
            console.log(`Updating ${source} link for event`);
            await this.supabase
              .from('event_links')
              .update({ url: event.eventUrl })
              .eq('event_id', eventId)
              .eq('source', source);
          } else {
            console.log(`Event link for ${source} already exists and matches`);
          }
        } else {
          // Create new event
          const { data: newEvent, error: eventError } = await this.supabase
            .from('events')
            .insert([{
              name: event.name,
              date,
              venue: event.venue,
              city: event.city,
              state: event.state,
              country: event.country,
              location: event.location,
              source: event.source,
              source_url: event.source_url
            }])
            .select()
            .single();

          if (eventError || !newEvent) {
            console.error('Failed to create event:', eventError);
            continue;
          }

          eventId = newEvent.id;
          console.log('Created new event:', event.name);

          // Create event link
          await this.supabase
            .from('event_links')
            .insert({
              event_id: eventId,
              source,
              url: event.eventUrl
            });
          console.log(`Added ${source} link for new event`);
        }

        // Visit event page to scrape tickets
        if (event.eventUrl) {
          this.sendStatus(`Fetching tickets for ${event.name}...`);
          const eventPageContent = await this.crawlPage({
            url: event.eventUrl,
            eventId // Pass eventId for ticket processing
          });
          this.sendStatus(`Finished processing tickets for ${event.name}`);
        }

      } catch (error) {
        console.error('Error processing event:', error);
        this.sendStatus(`Error processing event: ${event.name}`);
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

      // Filter out invalid tickets
      ticketArray = ticketArray.filter(ticket => 
        ticket && 
        (typeof ticket.price !== 'undefined') && 
        ticket.section
      );

      const ticketCount = ticketArray.length;
      console.log(`Found ${ticketCount} valid tickets for ${source}`);
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

      // Save to database
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

      // Log the actual data returned
      console.log('Database response:', {
        inserted: data?.length || 0,
        attempted: ticketData.length
      });

      const savedCount = data?.length || ticketData.length; // Use ticketData length as fallback
      console.log(`Successfully saved ${savedCount} tickets for ${source} event ${eventId}`);
      this.sendStatus(`Saved ${savedCount} tickets for ${source}`);

      return savedCount;

    } catch (error) {
      console.error(`Failed to process tickets for ${source}:`, error);
      this.sendStatus(`Error processing tickets for ${source}`);
      return 0;
    }
  }
}

const crawlerService = new CrawlerService();
export { crawlerService }; 