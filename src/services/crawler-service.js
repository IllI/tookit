import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { getParser } from './llm-service';

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
        headless: 'new',
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

  async crawlPage(options) {
    const url = typeof options === 'string' ? options : options?.url;
    
    if (!url || typeof url !== 'string') {
      throw new Error('Invalid URL provided to crawlPage');
    }

    const { browser } = await this.initialize();
    let context = null;
    let page = null;
    let attempt = 1;

    try {
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

      while (attempt <= this.maxAttempts) {
        try {
          console.log(`Attempt ${attempt}/${this.maxAttempts} to load: ${url}`);
          
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          
          // Add special handling for ticket pages
          const isEventPage = !url.includes('search');
          if (isEventPage) {
            try {
              await page.waitForTimeout(5000);
              await page.waitForFunction(
                () => {
                  const content = document.body.innerText;
                  return content.length > 1000 && 
                         (content.includes('Section') || content.includes('Row') || 
                          content.includes('Quantity') || content.includes('Price'));
                },
                { timeout: 15000, polling: 100 }
              );
              console.log('Event page content loaded');
            } catch (error) {
              console.log('Error waiting for ticket content:', error);
            }
          }

          // Wait for content to load
          await page.waitForFunction(
            () => document.body && document.body.innerText.length > 500,
            { timeout: 10000, polling: 100 }
          );

          const content = await page.evaluate(() => ({
            text: document.body.innerText,
            html: document.documentElement.outerHTML,
            title: document.title,
            url: window.location.href,
            contentLength: document.body.innerText.length
          }));

          console.log('Page state:', {
            url: content.url,
            title: content.title,
            contentLength: content.contentLength
          });

          if (content.contentLength > 500) {
            console.log('Page loaded successfully');
            
            const isSearchPage = content.url.includes('search');
            const source = url.includes('stubhub') ? 'stubhub' : 'vividseats';
            
            console.log(`Sending content to Claude for ${isSearchPage ? 'search' : 'ticket'} parsing...`);
            
            const parsedContent = await this.parser.parseContent(
              content.text,
              content.url,
              isSearchPage ? options.searchParams : undefined,
              !isSearchPage
            );

            // Process events if this was a search page
            if (isSearchPage && parsedContent?.events) {
              await this.processEventData(parsedContent, source);
            } 
            // Process tickets if this was an event page
            else if (!isSearchPage && options.eventId) {
              // Ensure we have a tickets array, even if empty
              const tickets = parsedContent?.tickets || [];
              console.log(`Found ${tickets.length} tickets to process`);
              await this.processTicketData(tickets, options.eventId, source);
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
        this.sendStatus(`Processing event: ${event.name}`);
        // Skip parking and auxiliary events
        if (event.name.toLowerCase().includes('parking')) {
          console.log('Skipping parking event:', event.name);
          continue;
        }

        const date = new Date(event.date);
        if (isNaN(date.getTime())) {
          console.error('Invalid date format:', event.date);
          continue;
        }

        // Check for existing event
        const { data: existingEvent } = await this.supabase
          .from('events')
          .select('id')
          .eq('name', event.name)
          .eq('date', date.toISOString())
          .eq('venue', event.venue)
          .single();

        let eventId;

        if (existingEvent) {
          console.log('Found existing event:', event.name);
          eventId = existingEvent.id;

          // Check for existing event link
          const { data: existingLink } = await this.supabase
            .from('event_links')
            .select('url')
            .eq('event_id', eventId)
            .eq('source', source)
            .single();

          if (existingLink) {
            if (existingLink.url === event.eventUrl) {
              console.log(`Event link for ${source} already exists and matches`);
            } else {
              console.log(`Updating ${source} link for event`);
              await this.supabase
                .from('event_links')
                .upsert({
                  event_id: eventId,
                  source,
                  url: event.eventUrl
                }, {
                  onConflict: 'event_id,source'
                });
            }
          } else {
            console.log(`Adding new ${source} link for existing event`);
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
          const { data: newEvent, error: eventError } = await this.supabase
            .from('events')
            .insert([{
              name: event.name,
              date,
              venue: event.venue,
              category: 'Concert'
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

  async processTicketData(tickets, eventId, source) {
    try {
      if (!eventId) {
        console.error('No eventId provided for ticket processing');
        return;
      }

      // Ensure tickets is an array
      let ticketArray = Array.isArray(tickets) ? tickets : [];
      if (!Array.isArray(tickets) && tickets?.tickets) {
        ticketArray = tickets.tickets;
      }

      // Filter out invalid tickets
      ticketArray = ticketArray.filter(ticket => 
        ticket && 
        (ticket.price || ticket.price === 0) && 
        ticket.section
      );

      if (ticketArray.length === 0) {
        console.log(`No valid tickets found for ${source} event ${eventId}`);
        return;
      }

      this.sendStatus(`Processing ${ticketArray.length} tickets for ${source}`);

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

      const { data, error } = await this.supabase
        .from('tickets')
        .upsert(ticketData, { 
          onConflict: 'event_id,source,listing_id',
          returning: true 
        });

      if (error) {
        throw error;
      }

      console.log(`Successfully saved ${data.length} tickets for ${source} event ${eventId}`);
      this.sendStatus(`Saved ${data.length} tickets for ${source}`);

    } catch (error) {
      console.error(`Failed to process tickets for ${source}:`, error);
      this.sendStatus(`Error processing tickets for ${source}`);
    }
  }
}

const crawlerService = new CrawlerService();
export { crawlerService }; 