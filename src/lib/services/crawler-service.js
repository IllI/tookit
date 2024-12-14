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
    
    this.supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );
    this.searchService = null;
  }

  async initialize() {
    if (!this.browser) {
      console.log('Setting up browser...');
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
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        ignoreDefaultArgs: ['--enable-automation']
      };

      try {
        this.browser = await puppeteer.launch(launchOptions);
        const version = await this.browser.version();
        console.log('Browser initialized successfully. Version:', version);
      } catch (error) {
        console.error('Browser initialization error:', error);
        throw error;
      }
    }
    return { browser: this.browser };
  }

  // ... rest of the service implementation ...
}