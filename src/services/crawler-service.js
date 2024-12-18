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

  async initialize() {
    if (!this.browser) {
      const isProduction = process.env.NODE_ENV === 'production';
      
      const launchOptions = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920,1080',
          '--disable-blink-features=AutomationControlled',
          '--no-first-run',
          '--no-zygote',
          '--single-process',
          '--disable-extensions',
          '--disable-background-networking',
          '--disable-default-apps',
          '--disable-sync',
          '--disable-translate',
          '--hide-scrollbars',
          '--metrics-recording-only',
          '--mute-audio',
          '--safebrowsing-disable-auto-update',
          '--headless=new',
          '--disable-software-rasterizer'
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        ignoreHTTPSErrors: true
      };

      // Only set executablePath in production
      if (isProduction) {
        launchOptions.executablePath = '/usr/bin/google-chrome-stable';
      }

      try {
        this.browser = await puppeteer.launch(launchOptions);
        console.log('Browser initialized with headless mode');
      } catch (error) {
        console.error('Browser initialization error:', error);
        throw error;
      }
    }
    return this.browser;
  }

  async crawlPage({ url, waitForSelector, eventId }) {
    if (url.includes('search')) {
      this.processedEvents.clear();
      console.log('Cleared processed events for new search');
    }

    let page = null;
    
    try {
      // Get browser instance directly, no destructuring needed
      const browser = await this.initialize();
      page = await browser.newPage(); // Create page directly from browser
      
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
          // Determine source first
          const source = url.includes('stubhub') ? 'stubhub' : 'vividseats';

          // Add quantity=0 parameter to StubHub event URLs
          const pageUrl = url.includes('stubhub.com') && !url.includes('search') 
            ? `${url}${url.includes('?') ? '&' : '?'}quantity=0` 
            : url;

          console.log(`Attempt ${attempt}/${this.maxAttempts} to load: ${pageUrl}`);
          
          await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          
          // Wait for content to load based on page type
          if (url.includes('vividseats.com')) {
            console.log('Waiting for VividSeats content...');
            if (url.includes('search') || url.includes('/search/')) {
              await page.waitForSelector('[data-testid="#app"]', { timeout: 5000 });
            } else {
              await page.waitForSelector('[data-testid="listings-container"]', { timeout: 5000 });
            }
          } else if (url.includes('stubhub.com')) {
            console.log('Waiting for StubHub content...');
            if (url.includes('search') || url.includes('/secure/search')) {
              await page.waitForSelector('#app', { timeout: 5000 });
              await page.waitForSelector('a[href*="/event/"]', { timeout: 5000 });
            } else {
              await page.waitForSelector('#listings-container', { timeout: 5000 });
            }
          }

          await page.waitForTimeout(1000);

          const content = await page.evaluate(() => ({
            text: document.body.innerText,
            html: document.documentElement.outerHTML,
            title: document.title,
            url: window.location.href
          }));

          // Better search page detection
          const isSearchPage = url.includes('search') || 
                             url.includes('/secure/search') || 
                             url.includes('/search/');
          
          console.log('Page type:', {
            url,
            isSearchPage,
            source,
            hasEventId: !!eventId
          });

          const parser = new TicketParser(content.html, source);
          const parsedContent = isSearchPage 
            ? parser.parseSearchResults()
            : parser.parseEventTickets();

          // Process events if this was a search page
          if (isSearchPage && parsedContent?.events) {
            await this.processEventData(parsedContent, source);
          } 
          // Process tickets if this was an event page
          else if (!isSearchPage && eventId) {
            const tickets = parsedContent?.tickets || [];
            console.log(`Found ${tickets.length} tickets to process`);
            await this.processTicketData(tickets, eventId, source);
          }

          return {
            ...content,
            parsedContent
          };

        } catch (error) {
          console.error(`Attempt ${attempt} failed:`, error.message);
          if (attempt === this.maxAttempts) throw error;
          attempt++;
          await new Promise(resolve => setTimeout(resolve, this.retryDelays[attempt - 1]));
        }
      }
    } catch (error) {
      console.error('Error loading page:', error);
      throw error;
    } finally {
      if (page) await page.close();
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

    // Process each event one at a time
    for (const event of parsedEvents.events) {
      try {
        // Track if we've seen this event before
        const eventKey = `${event.name}-${event.venue}-${event.date}`;
        const seenBefore = this.processedEvents.has(eventKey);
        this.processedEvents.add(eventKey);

        // Check for existing event with fuzzy name matching
        const { data: existingEvents } = await this.supabase
          .from('events')
          .select('id, name, date, venue, city')
          .eq('city', event.city)
          .eq('state', event.state);

        let eventId = null;

        // Find matching event considering similar names and close dates
        if (existingEvents?.length) {
          const matchingEvent = existingEvents.find(existing => {
            const existingDate = new Date(existing.date);
            const eventDate = new Date(event.date);
            const timeDiff = Math.abs(existingDate.getTime() - eventDate.getTime());
            const hoursDiff = timeDiff / (1000 * 60 * 60);
            
            // Consider events matching if:
            // 1. Names are similar
            // 2. Within 24 hours
            // 3. Same city (even if venue differs)
            const namesSimilar = this.areNamesSimilar(existing.name, event.name);
            return hoursDiff <= 24 && namesSimilar;
          });

          if (matchingEvent) {
            eventId = matchingEvent.id;
            console.log('Found matching event:', {
              name: matchingEvent.name,
              venue: matchingEvent.venue,
              matchedWith: {
                name: event.name,
                venue: event.venue
              }
            });
          }
        }

        // Only create new event if we haven't seen it before
        if (!eventId && !seenBefore) {
          // Create new event
          const { data: newEvent, error: eventError } = await this.supabase
            .from('events')
            .insert([{
              name: event.name,
              date: event.date,
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
        }

        // Always update event link, whether the event is new or existing
        if (eventId) {
          // Check for existing event links - allow multiple per source
          const { data: existingLinks } = await this.supabase
            .from('event_links')
            .select('url')
            .eq('event_id', eventId)
            .eq('source', source);

          // Check if this exact URL already exists
          const hasLink = existingLinks?.some(link => link.url === event.eventUrl);

          if (!hasLink) {
            console.log(`Adding new ${source} link for event`);
            await this.supabase
              .from('event_links')
              .insert({
                event_id: eventId,
                source,
                url: event.eventUrl
              });
          } else {
            console.log(`Event link for ${source} already exists`);
          }
        }

        // Visit event page to scrape tickets
        if (event.eventUrl && eventId) {
          this.sendStatus(`Fetching tickets for ${event.name}...`);
          
          try {
            await new Promise(resolve => setTimeout(resolve, 2000));
            
            await this.crawlPage({
              url: event.eventUrl,
              eventId,
              waitForSelector: source === 'stubhub' ? '#listings-container' : '[data-testid="listings-container"]'
            });

          } catch (pageError) {
            console.error('Error visiting event page:', {
              url: event.eventUrl,
              error: pageError.message
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

      // Save to database - update onConflict to match the unique constraint
      const { data, error } = await this.supabase
        .from('tickets')
        .upsert(ticketData, { 
          onConflict: 'event_id,section,row,price',
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