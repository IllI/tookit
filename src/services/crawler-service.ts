import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';
import { getParser } from './llm-service';
import { TicketParser } from './ticket-parser';
import type { SearchService } from './search-service';
import type { EventEmitter } from 'events';

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
  public searchService: EventEmitter | null = null;

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

  // ... rest of the implementation
}

// Create a singleton instance
const crawlerService = new CrawlerService();
export { crawlerService };