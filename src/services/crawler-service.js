import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { getParser } from './llm-service';
import { config } from '@/src/config/env';
import { EventProcessor } from './event-processor';
import { createCrawl } from 'x-crawl';
import { createClient } from '@supabase/supabase-js';

// Add stealth plugin
puppeteer.use(StealthPlugin());

class CrawlerService {
  constructor() {
    this.browser = null;
    this.parser = getParser();
    this.retryDelays = [5000, 10000, 15000];
    this.maxAttempts = 3;
    
    // Update selectors to match actual page content
    this.siteConfigs = {
      stubhub: {
        selector: '[data-testid="event-list"]',
        minContentLength: 500,
        expectedTitle: /StubHub/i
      },
      vividseats: {
        // Update selector to match what we see on the page
        selector: '.search-results',  // or another selector that matches the content
        minContentLength: 500,
        expectedTitle: /Vivid Seats/i
      }
    };

    this.eventProcessor = new EventProcessor();
    this.supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );
  }

  getSiteConfig(url) {
    if (url.includes('stubhub')) return this.siteConfigs.stubhub;
    if (url.includes('vividseats')) return this.siteConfigs.vividseats;
    throw new Error('Unknown site');
  }

  async initialize() {
    if (!this.browser) {
      try {
        // Launch browser with stealth
        this.browser = await puppeteer.launch({
          headless: false,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
          ],
          ignoreDefaultArgs: ['--enable-automation']
        });

        console.log('Services initialized');
      } catch (error) {
        console.error('Failed to initialize services:', error);
        throw error;
      }
    }
    return { browser: this.browser };
  }

  // Add method to crawl sites sequentially
  async crawlSites(sites) {
    const results = [];
    
    // Handle one site at a time
    for (const site of sites) {
      console.log(`Processing ${site.url}...`);
      const result = await this.crawlPage(site);
      results.push(result);
      
      // Wait between sites
      await new Promise(r => setTimeout(r, 5000));
    }
    
    return results;
  }

  async crawlPage(options) {
    const { browser } = await this.initialize();
    console.log(`Starting crawl for: ${options.url}`);

    let context = null;
    let page = null;
    let currentAttempt = 1;

    try {
      context = await browser.createIncognitoBrowserContext();
      page = await context.newPage();

      // Set up page
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

      // Add browser fingerprinting evasion
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        window.chrome = {
          runtime: {},
          loadTimes: () => {},
          csi: () => {},
          app: { isInstalled: false }
        };
      });

      while (currentAttempt <= this.maxAttempts) {
        console.log(`Attempt ${currentAttempt}/${this.maxAttempts} for ${options.url}`);

        try {
          // Navigate or reload
          if (currentAttempt === 1) {
            await page.goto(options.url, { 
              waitUntil: ['networkidle0', 'domcontentloaded'],
              timeout: 30000 
            });
          } else {
            console.log('Reloading page...');
            await page.reload({ 
              waitUntil: ['networkidle0', 'domcontentloaded'],
              timeout: 30000 
            });
          }

          // Wait and scroll
          console.log('Waiting for initial load...');
          await page.waitForTimeout(5000);

          // Scroll to load dynamic content
          await page.evaluate(async () => {
            await new Promise((resolve) => {
              let totalHeight = 0;
              const distance = 100;
              const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= document.body.scrollHeight) {
                  clearInterval(timer);
                  resolve();
                }
              }, 100);
            });
          });

          // Check for valid content based on site
          const pageContent = await page.evaluate(() => {
            const isStubHub = window.location.href.includes('stubhub');
            const isVividSeats = window.location.href.includes('vividseats');

            // Debug logging
            console.log('Page evaluation:', {
              contentLength: document.body.innerText.length,
              hasMCR: document.body.innerText.includes('My Chemical Romance'),
              url: window.location.href
            });

            let hasValidContent = false;

            if (isStubHub) {
              // StubHub validation
              hasValidContent = document.body.innerText.length > 1000 && 
                              document.body.innerText.includes('My Chemical Romance') &&
                              !document.body.innerText.includes('recaptcha');
            } else if (isVividSeats) {
              // VividSeats validation
              hasValidContent = document.body.innerText.length > 500 && 
                              document.body.innerText.includes('My Chemical Romance');
            }

            return {
              text: document.body.innerText,
              html: document.documentElement.outerHTML,
              title: document.title,
              url: window.location.href,
              hasValidContent,
              contentLength: document.body.innerText.length
            };
          });

          console.log('Page state:', {
            url: pageContent.url,
            contentLength: pageContent.contentLength,
            title: pageContent.title,
            hasValidContent: pageContent.hasValidContent
          });

          if (pageContent.hasValidContent) {
            console.log('Valid content found, parsing...');
            const analysis = await this.parser.parseContent(pageContent.text, options.url);
            
            if (analysis.events?.length) {
              // Filter out parking and other auxiliary events
              const validEvents = analysis.events.filter(event => {
                const name = event.name.toLowerCase();
                return !name.includes('parking') && 
                       !name.includes('vip') && 
                       !name.includes('meet and greet');
              });

              if (validEvents.length > 0) {
                await this.processEvents(validEvents.map(event => ({
                  ...event,
                  source: options.url.includes('stubhub') ? 'stubhub' : 'vividseats',
                  link: pageContent.url
                })));
              }
            }
            
            return analysis;
          }

          if (currentAttempt === 2 && pageContent.contentLength > 1500) {
            console.log('Second attempt has substantial content, proceeding with parsing...');
            const analysis = await this.parser.parseContent(pageContent.text, options.url);
            console.log(`Found ${analysis.events?.length || 0} events`);
            return analysis;
          }

          console.log('Invalid content, retrying...');
          await new Promise(r => setTimeout(r, this.retryDelays[currentAttempt - 1]));
          currentAttempt++;

        } catch (error) {
          console.error(`Error in attempt ${currentAttempt}:`, error);
          await new Promise(r => setTimeout(r, this.retryDelays[currentAttempt - 1]));
          currentAttempt++;
        }
      }

      return { events: [] };

    } finally {
      if (context) await context.close();
    }
  }

  async processEvents(events) {
    try {
      for (const event of events) {
        const date = this.normalizeDate(event.date);
        if (!date) continue;

        // Check for existing event
        const { data: existingEvents } = await this.supabase
          .from('events')
          .select('id, name')
          .eq('name', event.name)
          .eq('date', date.toISOString())
          .eq('venue', event.venue)
          .single();

        let eventId;

        if (existingEvents) {
          eventId = existingEvents.id;
          console.log('Found existing event:', existingEvents.name);
        } else {
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
          console.log('Created new event:', newEvent.name);
        }

        // Add event link if it doesn't exist
        if (event.link) {
          const { error: linkError } = await this.supabase
            .from('event_links')
            .upsert({
              event_id: eventId,
              source: event.source,
              url: event.link
            }, {
              onConflict: 'event_id,source'
            });

          if (!linkError) {
            console.log(`Added ${event.source} link for event`);
            await this.visitEventPage(eventId, event.source, event.link);
          }
        }
      }
    } catch (error) {
      console.error('Failed to process events:', error);
    }
  }

  async cleanup() {
    if (this.browser) {
      try {
        await this.browser.close();
        this.browser = null;
        console.log('Browser closed successfully');
      } catch (error) {
        console.error('Error closing browser:', error);
      }
    }
  }

  async visitEventPage(eventId, source, eventUrl) {
    let browser;
    try {
        console.log(`Visiting event page: ${eventUrl}`);
        
        const xcrawl = await import('x-crawl');
        const crawler = xcrawl.default({
            maxRetry: 3,
            intervalTime: { max: 8000, min: 3000 },
            navigationTimeout: 30000,
            headless: false,
            launchOptions: {
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--window-size=1920,1080',
                    '--disable-blink-features=AutomationControlled'
                ]
            }
        });

        browser = await crawler.launch();
        const page = await browser.newPage();

        // Apply successful bot evasion techniques
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await page.setViewport({ width: 1920, height: 1080 });
        await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Connection': 'keep-alive'
        });

        const result = await crawler.crawlPage({
            url: eventUrl,
            callback: async ({ page }) => {
                await page.waitForTimeout(5000);

                const content = await page.evaluate(() => document.body.innerText);
                console.log('Got event page content, parsing tickets...');

                const ticketData = await this.parser.parseTickets(content);
                if (Array.isArray(ticketData) && ticketData.length > 0) {
                    const { error } = await this.supabase
                        .from('tickets')
                        .upsert(
                            ticketData.map(ticket => ({
                                event_id: eventId,
                                section: ticket.section || 'General',
                                row: ticket.row,
                                price: parseFloat(ticket.price) || 0,
                                quantity: parseInt(String(ticket.quantity)) || 1,
                                source: source,
                                listing_id: ticket.listing_id || `${source}-${Date.now()}`,
                                date_posted: new Date().toISOString(),
                                sold: false
                            }))
                        );

                    if (error) {
                        console.error('Error saving tickets:', error);
                    } else {
                        console.log(`Saved ${ticketData.length} tickets for event`);
                    }
                }
            }
        });

        return result.data;
    } catch (error) {
        console.error('Error visiting event page:', error);
    } finally {
        await this.cleanup(browser);
    }
  }

  normalizeDate(dateStr) {
    try {
      // Remove day of week if present
      const cleanDate = dateStr.replace(/^(MON|TUE|WED|THU|FRI|SAT|SUN)\s+/i, '');
      const parsed = new Date(cleanDate);
      return parsed.toString() !== 'Invalid Date' ? parsed : null;
    } catch (e) {
      console.error('Date parsing error:', e);
      return null;
    }
  }
}

const crawlerService = new CrawlerService();
export { crawlerService }; 