import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { getParser } from './llm-service';

const StealthPluginInstance = StealthPlugin();
StealthPluginInstance.enabledEvasions.delete('user-agent-override');
puppeteer.use(StealthPluginInstance);

// Override the default browser fetch/launch behavior
const browserFetcher = puppeteer.createBrowserFetcher();

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
      try {
        const launchOptions = {
          product: 'chrome',
          executablePath: '/usr/bin/chromium-browser',
          ignoreDefaultArgs: ['--enable-automation'],
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--disable-infobars',
            '--window-size=1920,1080',
            '--disable-blink-features=AutomationControlled'
          ]
        };

        console.log('Attempting to launch browser with options:', JSON.stringify(launchOptions, null, 2));
        this.browser = await puppeteer.launch(launchOptions);
        const pages = await this.browser.pages();
        console.log(`Browser launched successfully with ${pages.length} pages`);
        
        const version = await this.browser.version();
        console.log('Browser version:', version);
      } catch (error) {
        console.error('Browser initialization error:', error);
        throw error;
      }
    }
    return { browser: this.browser };
  }

  // ... rest of the service implementation ...
}