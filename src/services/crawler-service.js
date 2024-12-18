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
    this.searchService = null;
    
    this.supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );
  }

  sendStatus(message) {
    if (this.searchService) {
      this.searchService.emit('status', message);
    }
    console.log(message);
  }

  // ... rest of the class implementation as in previous update ...
}

const crawlerService = new CrawlerService();
export { crawlerService };