import { createClient } from '@supabase/supabase-js';
import core from 'puppeteer-core';
import { getParser } from './llm-service';

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
        const browserFetcher = new core.BrowserFetcher();
        console.log('Using browserFetcher to locate chrome...');
        
        const launchOptions = {
          defaultViewport: { width: 1920, height: 1080 },
          executablePath: '/usr/bin/chromium-browser',
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--disable-gpu',
            '--window-size=1920,1080'
          ]
        };

        console.log('Launch options:', JSON.stringify(launchOptions, null, 2));
        this.browser = await core.launch(launchOptions);
        
        const version = await this.browser.version();
        console.log('Browser launched successfully. Version:', version);
        
        const pages = await this.browser.pages();
        console.log(`Browser has ${pages.length} pages open`);
        
      } catch (error) {
        console.error('Browser initialization error with full details:', {
          error: error.message,
          stack: error.stack,
          code: error.code,
          cmd: error.cmd,
          killed: error.killed,
          signal: error.signal,
          stdout: error.stdout,
          stderr: error.stderr
        });
        throw error;
      }
    }
    return { browser: this.browser };
  }

  // ... rest of the service implementation ...
}