import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';
import { getParser } from './llm-service';
import { TicketParser } from './ticket-parser';

// Create the browser with stealth
const puppeteerExtra = addExtra(puppeteer);
puppeteerExtra.use(StealthPlugin());

class CrawlerService {
  constructor() {
    this.browser = null;
    this.parser = getParser();
    this.maxAttempts = 3;
    this.retryDelays = [2000, 5000, 8000];
    this.processedEvents = new Set();
    
    this.supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );
    this.searchService = null;
  }

  async initialize() {
    if (!this.browser) {
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
          '--disable-blink-features=AutomationControlledInMainFrame',
          '--disable-infobars',
          '--no-first-run',
          '--no-default-browser-check',
          '--ignore-certificate-errors',
          '--ignore-certificate-errors-spki-list',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-site-isolation-trials'
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null
      };

      try {
        this.browser = await puppeteerExtra.launch(launchOptions);
        console.log('Browser initialized with stealth');
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
    let context = null;
    
    try {
      const browser = await this.initialize();
      context = await browser.createIncognitoBrowserContext();
      page = await context.newPage();
      
      // Set a custom user agent
      const userAgent = new UserAgent({ deviceCategory: 'desktop' });
      await page.setUserAgent(userAgent.toString());
      
      // Set viewport with slight variations
      const width = 1920 + Math.floor(Math.random() * 100);
      const height = 1080 + Math.floor(Math.random() * 100);
      await page.setViewport({ width, height });

      // Set default navigation timeout
      page.setDefaultNavigationTimeout(60000);
      page.setDefaultTimeout(60000);
      
      // Enhanced stealth setup
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        
        // Mock permissions
        const originalQuery = window.navigator.permissions.query;
        window.navigator.permissions.query = (parameters) => (
          parameters.name === 'notifications' ?
            Promise.resolve({ state: Notification.permission }) :
            originalQuery(parameters)
        );

        // Add plugins
        Object.defineProperty(navigator, 'plugins', {
          get: () => [
            { name: 'Chrome PDF Plugin' },
            { name: 'Chrome PDF Viewer' },
            { name: 'Native Client' }
          ]
        });

        // Add Chrome object
        window.chrome = {
          runtime: {},
          webstore: {},
          app: {
            InstallState: {
              DISABLED: 'disabled',
              INSTALLED: 'installed',
              NOT_INSTALLED: 'not_installed'
            }
          }
        };
      });

      let attempt = 1;
      while (attempt <= this.maxAttempts) {
        try {
          console.log(`Attempt ${attempt}/${this.maxAttempts} to load: ${url}`);
          
          // Set cookies before navigation
          const domain = new URL(url).hostname;
          await page.setCookie({
            name: 'session_visited', 
            value: 'true',
            domain: domain
          });

          // Set headers dynamically
          await page.setExtraHTTPHeaders({
            'Accept-Language': 'en-US,en;q=0.9',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
            'sec-ch-ua-mobile': '?0',
            'sec-ch-ua-platform': '"Windows"',
            'Cache-Control': Math.random() > 0.5 ? 'max-age=0' : 'no-cache',
            'Upgrade-Insecure-Requests': '1'
          });

          // Random delay before navigation
          await page.waitForTimeout(1000 + Math.random() * 2000);

          // Navigate to the page with less strict conditions
          await page.goto(url, { 
            waitUntil: 'domcontentloaded',
            timeout: 60000
          });

          // Wait for specific content based on the site
          if (url.includes('vividseats.com')) {
            try {
              await page.waitForFunction(
                () => document.body.innerText.length > 1000,
                { timeout: 30000 }
              );
              
              if (url.includes('search')) {
                await page.waitForSelector('[data-testid^="production-listing-"]', {
                  timeout: 30000
                }).catch(() => console.log('VividSeats search selector not found'));
              }
            } catch (err) {
              console.log('VividSeats content wait error:', err);
            }
          } else if (url.includes('stubhub.com')) {
            try {
              await page.waitForFunction(
                () => document.body.innerText.length > 1000,
                { timeout: 30000 }
              );
              
              if (url.includes('search')) {
                await page.waitForSelector('a[href*="/event/"]', {
                  timeout: 30000
                }).catch(() => console.log('StubHub search selector not found'));
              }
            } catch (err) {
              console.log('StubHub content wait error:', err);
            }
          }

          // Extract content
          const content = await page.evaluate(() => ({
            text: document.body.innerText,
            html: document.documentElement.outerHTML,
            title: document.title,
            url: window.location.href,
            contentLength: document.body.innerText.length
          }));

          if (content.contentLength > 500) {
            console.log('Page loaded successfully');
            const source = url.includes('stubhub') ? 'stubhub' : 'vividseats';
            const isSearchPage = url.includes('search');
            
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
          }

          console.log('Invalid content, retrying...');
          await page.waitForTimeout(this.retryDelays[attempt - 1]);
          attempt++;

        } catch (error) {
          console.error(`Attempt ${attempt} failed:`, {
            url,
            error: error.message,
            stack: error.stack,
            pageUrl: page?.url()
          });
          
          if (attempt === this.maxAttempts) throw error;
          attempt++;
          await page.waitForTimeout(this.retryDelays[attempt - 1]);
        }
      }
    } catch (error) {
      console.error('Error loading page:', error);
      throw error;
    } finally {
      if (page) await page.close();
      if (context) await context.close();
    }
  }

  // ... rest of the class implementation remains the same ...
}

const crawlerService = new CrawlerService();
export { crawlerService };