import puppeteer from 'puppeteer-core';
import type { Browser, Page } from 'puppeteer-core';
import { BrowserFinder } from '../utils/browser-finder';
import { parserService } from './parser-service';
import type { Event } from '@/lib/types/schemas';

class CrawlerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: any
  ) {
    super(message);
    this.name = 'CrawlerError';
  }
}

class CrawlerService {
  private browser: Browser | null = null;
  private readonly maxAttempts = 3;
  private readonly retryDelays = [2000, 3000, 4000];
  private searchService: any = null;

  setSearchService(service: any) {
    this.searchService = service;
  }

  sendStatus(message: string) {
    if (this.searchService) {
      this.searchService.emit('status', message);
    }
    console.log(message);
  }

  private async setupPage(page: Page) {
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"'
    });

    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });
      window.navigator.chrome = {
        runtime: {}
      };
    });
  }

  async initialize(): Promise<{ browser: Browser }> {
    if (this.browser) {
      return { browser: this.browser };
    }

    try {
      const browserInfo = await BrowserFinder.findChrome();
      if (!browserInfo) {
        throw new CrawlerError(
          BrowserFinder.getBrowserNotFoundMessage(),
          'BROWSER_NOT_FOUND'
        );
      }

      const launchOptions = {
        headless: 'new' as const,
        executablePath: browserInfo.executablePath,
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
      console.log(`Browser initialized (${browserInfo.type})`);
      return { browser: this.browser };

    } catch (error) {
      if (error instanceof CrawlerError) throw error;
      throw new CrawlerError(
        'Failed to initialize browser',
        'BROWSER_INIT_FAILED',
        error
      );
    }
  }

  async crawlPage(url: string): Promise<Event> {
    if (!url || typeof url !== 'string') {
      throw new CrawlerError(
        'Invalid URL provided',
        'INVALID_URL'
      );
    }

    const { browser } = await this.initialize();
    let context = null;
    let page = null;
    let attempt = 1;

    try {
      context = await browser.createIncognitoBrowserContext();
      page = await context.newPage();
      await this.setupPage(page);

      while (attempt <= this.maxAttempts) {
        try {
          console.log(`Attempt ${attempt}/${this.maxAttempts} to load: ${url}`);
          
          const response = await page.goto(url, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
          });

          if (!response) {
            throw new CrawlerError(
              'Failed to get page response',
              'NO_RESPONSE'
            );
          }

          if (!response.ok()) {
            throw new CrawlerError(
              `HTTP ${response.status()} ${response.statusText()}`,
              'HTTP_ERROR'
            );
          }
          
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
                { timeout: 5000, polling: 100 }
              );
              console.log('Event page content loaded');
            } catch (error) {
              console.log('Warning: Ticket content not found');
            }
          }

          await page.waitForFunction(
            () => document.body && document.body.innerText.length > 500,
            { timeout: 5000, polling: 100 }
          );

          const html = await page.content();
          const parsedData = await parserService.parseContent(html, url);
          console.log('Parsed data:', parsedData);

          return parsedData;

        } catch (error) {
          console.error(`Error in attempt ${attempt}:`, error);
          if (attempt === this.maxAttempts) {
            throw new CrawlerError(
              'Failed to load page after all attempts',
              'MAX_ATTEMPTS_REACHED',
              error
            );
          }
          await page.waitForTimeout(this.retryDelays[attempt - 1]);
          attempt++;
        }
      }

      throw new CrawlerError(
        'Failed to load page after all attempts',
        'MAX_ATTEMPTS_REACHED'
      );

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
}

export const crawlerService = new CrawlerService();
export { CrawlerError };
