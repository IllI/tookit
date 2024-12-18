import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';
import { getParser } from './llm-service';
import { TicketParser } from './ticket-parser';
import type { SearchService } from './search-service';

// Create the browser with stealth
const puppeteerExtra = addExtra(puppeteer);
puppeteerExtra.use(StealthPlugin());

export class CrawlerService {
  private browser: puppeteer.Browser | null = null;
  private parser: ReturnType<typeof getParser>;
  private maxAttempts: number = 3;
  private retryDelays: number[] = [2000, 5000, 8000];
  private processedEvents: Set<string> = new Set();
  private supabase;
  public searchService: SearchService | null = null;

  constructor() {
    this.parser = getParser();
    this.supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
  }

  sendStatus(message: string): void {
    if (this.searchService) {
      this.searchService.emit('status', message);
    }
    console.log(message);
  }

  async initialize(): Promise<puppeteer.Browser> {
    if (!this.browser) {
      const launchOptions: puppeteer.LaunchOptions & { args: string[] } = {
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
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined
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

  // ... rest of your implementation ...
}

export const crawlerService = new CrawlerService();