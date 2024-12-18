import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';
import { BaseService } from './base-service';
import { getParser } from './llm-service';
import { TicketParser } from './ticket-parser';

// Create the browser with stealth
const puppeteerExtra = addExtra(puppeteer);
puppeteerExtra.use(StealthPlugin());

class CrawlerService extends BaseService {
  private browser: puppeteer.Browser | null = null;
  private parser: ReturnType<typeof getParser>;
  private maxAttempts: number = 3;
  private retryDelays: number[] = [2000, 5000, 8000];
  private processedEvents: Set<string> = new Set();
  private supabase;
  private static _instance: CrawlerService;

  constructor() {
    super();
    if (CrawlerService._instance) {
      return CrawlerService._instance;
    }

    this.parser = getParser();
    this.supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    CrawlerService._instance = this;
  }

  static getInstance(): CrawlerService {
    if (!CrawlerService._instance) {
      CrawlerService._instance = new CrawlerService();
    }
    return CrawlerService._instance;
  }

  async initialize(): Promise<puppeteer.Browser> {
    if (!this.browser) {
      const launchOptions: puppeteer.LaunchOptions = {
        headless: true,
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

  async crawlPage({ url, waitForSelector, eventId }: { url: string; waitForSelector?: string; eventId?: string }) {
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
      
      const userAgent = new UserAgent({ deviceCategory: 'desktop' });
      await page.setUserAgent(userAgent.toString());
      
      await page.setViewport({ 
        width: 1920 + Math.floor(Math.random() * 100),
        height: 1080 + Math.floor(Math.random() * 100)
      });

      await page.setDefaultNavigationTimeout(60000);
      await page.setDefaultTimeout(60000);

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'plugins', {
          get: () => [
            { name: 'Chrome PDF Plugin' },
            { name: 'Chrome PDF Viewer' },
            { name: 'Native Client' }
          ]
        });
      });

      let attempt = 1;
      while (attempt <= this.maxAttempts) {
        try {
          console.log(`Attempt ${attempt}/${this.maxAttempts} to load: ${url}`);

          await page.goto(url, { 
            waitUntil: 'domcontentloaded',
            timeout: 60000
          });

          if (waitForSelector) {
            await page.waitForSelector(waitForSelector, { timeout: 30000 })
              .catch(() => console.log(`Selector ${waitForSelector} not found`));
          }

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

            return {
              ...content,
              parsedContent
            };
          }

          console.log('Invalid content, retrying...');
          await page.waitForTimeout(this.retryDelays[attempt - 1]);
          attempt++;

        } catch (error) {
          console.error(`Attempt ${attempt} failed:`, error);
          if (attempt === this.maxAttempts) throw error;
          attempt++;
          await page.waitForTimeout(this.retryDelays[attempt - 1]);
        }
      }

      throw new Error('Failed to load page after all attempts');
    } catch (error) {
      console.error('Error loading page:', error);
      throw error;
    } finally {
      if (page) await page.close();
      if (context) await context.close();
    }
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const crawlerService = CrawlerService.getInstance();