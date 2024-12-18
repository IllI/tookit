import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';
import { getParser } from './llm-service';
import { TicketParser } from './ticket-parser';
import type { EventEmitter } from 'events';
import type { ICrawlerService } from './types';

// Create the browser with stealth
const puppeteerExtra = addExtra(puppeteer);
puppeteerExtra.use(StealthPlugin());

class CrawlerService implements ICrawlerService {
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

  // ... rest of implementation same as before ...
}

// Create and export the singleton instance
export const crawlerService = new CrawlerService();