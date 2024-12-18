import { EventEmitter } from 'events';
import puppeteer from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';
import { TicketParser } from '@/src/services/ticket-parser';

type SearchParams = {
  keyword: string;
  location?: string;
  source?: 'all' | 'stubhub' | 'vividseats';
};

export class BrowserService extends EventEmitter {
  private browser: puppeteer.Browser | null = null;
  private static instance: BrowserService;

  private constructor() {
    super();
  }

  public static getInstance(): BrowserService {
    if (!BrowserService.instance) {
      BrowserService.instance = new BrowserService();
    }
    return BrowserService.instance;
  }

  private async getBrowser(): Promise<puppeteer.Browser> {
    if (!this.browser) {
      const puppeteerExtra = addExtra(puppeteer);
      puppeteerExtra.use(StealthPlugin());

      this.browser = await puppeteerExtra.launch({
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
      });
    }
    return this.browser;
  }

  public async search(params: SearchParams) {
    try {
      const promises = [];
      const metadata: any = {};

      if (!params.source || params.source === 'all' || params.source === 'stubhub') {
        promises.push(this.searchStubHub(params));
        metadata.stubhub = { isLive: true };
      }

      if (!params.source || params.source === 'all' || params.source === 'vividseats') {
        promises.push(this.searchVividSeats(params));
        metadata.vividseats = { isLive: true };
      }

      const results = await Promise.all(promises);
      const allEvents = results.flat();

      return {
        success: true,
        data: allEvents,
        metadata
      };
    } catch (error) {
      console.error('Search error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Search failed',
        metadata: { error: 'Search operation failed' }
      };
    }
  }

  private async searchStubHub(params: SearchParams) {
    this.emit('status', 'Searching StubHub...');
    try {
      const searchUrl = `https://www.stubhub.com/secure/search?q=${encodeURIComponent(
        [params.keyword, params.location].filter(Boolean).join(' ')
      )}`;

      const result = await this.crawlPage({
        url: searchUrl,
        waitForSelector: '#app'
      });

      const events = result?.parsedContent?.events || [];
      
      if (events.length) {
        this.emit('status', `Found ${events.length} events on StubHub`);
      } else {
        this.emit('status', 'No events found on StubHub');
      }
      
      return events;
    } catch (error) {
      console.error('StubHub search error:', error);
      this.emit('status', 'No events found on StubHub');
      return [];
    }
  }

  private async searchVividSeats(params: SearchParams) {
    this.emit('status', 'Searching VividSeats...');
    try {
      const searchUrl = `https://www.vividseats.com/search?searchTerm=${encodeURIComponent(
        [params.keyword, params.location].filter(Boolean).join(' ')
      )}`;

      const result = await this.crawlPage({
        url: searchUrl,
        waitForSelector: '[data-testid^="production-listing-"]'
      });

      const events = result?.parsedContent?.events || [];
      
      if (events.length) {
        this.emit('status', `Found ${events.length} events on VividSeats`);
      } else {
        this.emit('status', 'No events found on VividSeats');
      }
      
      return events;
    } catch (error) {
      console.error('VividSeats search error:', error);
      this.emit('status', 'No events found on VividSeats');
      return [];
    }
  }

  private async crawlPage({ url, waitForSelector }: { url: string; waitForSelector?: string }) {
    let page = null;
    let context = null;

    try {
      const browser = await this.getBrowser();
      context = await browser.createIncognitoBrowserContext();
      page = await context.newPage();

      const userAgent = new UserAgent({ deviceCategory: 'desktop' });
      await page.setUserAgent(userAgent.toString());
      
      await page.setViewport({
        width: 1920 + Math.floor(Math.random() * 100),
        height: 1080 + Math.floor(Math.random() * 100)
      });

      page.setDefaultNavigationTimeout(60000);
      page.setDefaultTimeout(60000);

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

      await page.goto(url, { waitUntil: 'domcontentloaded' });

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

      if (content.contentLength <= 500) {
        throw new Error('Insufficient content loaded');
      }

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

    } catch (error) {
      console.error('Error loading page:', error);
      throw error;
    } finally {
      if (page) await page.close();
      if (context) await context.close();
    }
  }

  public async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}

export const browserService = BrowserService.getInstance();