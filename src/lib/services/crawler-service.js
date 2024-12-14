import { createClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import puppeteerCore from 'puppeteer-core';
import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { getParser } from './llm-service';

// Configure puppeteer-extra with puppeteer-core
puppeteerExtra.use(puppeteerCore);
puppeteerExtra.use(StealthPlugin());

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

  findChromePath() {
    try {
      // Try different possible paths
      const paths = [
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
        '/usr/bin/chrome',
        '/usr/bin/google-chrome'
      ];

      for (const path of paths) {
        try {
          execSync(`test -f ${path}`);
          console.log(`Found browser at: ${path}`);
          return path;
        } catch (e) {
          console.log(`Browser not found at: ${path}`);
        }
      }

      // If none found, try which command
      const chromiumPath = execSync('which chromium-browser').toString().trim();
      if (chromiumPath) {
        console.log(`Found browser using which: ${chromiumPath}`);
        return chromiumPath;
      }
    } catch (error) {
      console.error('Error finding Chrome path:', error);
    }
    return null;
  }

  async initialize() {
    if (!this.browser) {
      console.log('Setting up browser...');
      try {
        const chromePath = this.findChromePath();
        if (!chromePath) {
          throw new Error('Could not find Chrome installation');
        }

        console.log('Using Chrome path:', chromePath);
        
        const launchOptions = {
          headless: 'new',
          executablePath: chromePath,
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

        console.log('Launching browser with options:', JSON.stringify(launchOptions, null, 2));
        
        // Try puppeteer-core first
        try {
          this.browser = await puppeteerCore.launch(launchOptions);
          console.log('Launched with puppeteer-core');
        } catch (coreError) {
          console.error('puppeteer-core launch failed:', coreError);
          console.log('Trying puppeteer-extra...');
          this.browser = await puppeteerExtra.launch(launchOptions);
          console.log('Launched with puppeteer-extra');
        }

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