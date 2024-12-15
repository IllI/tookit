import { createClient } from '@supabase/supabase-js';
import core from 'puppeteer-core';
import { getParser } from './llm-service';
import { execSync } from 'child_process';

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

  setSearchService(service) {
    this.searchService = service;
  }

  verifyChromePath(path) {
    try {
      execSync(`test -f ${path}`);
      const version = execSync(`${path} --version 2>/dev/null`).toString();
      console.log(`Verified Chrome at ${path}: ${version}`);
      return true;
    } catch (e) {
      console.log(`Failed to verify Chrome at ${path}: ${e.message}`);
      return false;
    }
  }

  findChromePath() {
    // First check environment variable
    const envPath = process.env.CHROME_EXECUTABLE_PATH;
    if (envPath && this.verifyChromePath(envPath)) {
      return envPath;
    }

    // Then try standard locations
    const paths = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser'
    ];

    for (const path of paths) {
      if (this.verifyChromePath(path)) {
        return path;
      }
    }

    return null;
  }

  async initialize() {
    if (!this.browser) {
      console.log('Setting up browser...');
      console.log('Environment variables:', {
        CHROME_EXECUTABLE_PATH: process.env.CHROME_EXECUTABLE_PATH,
        PATH: process.env.PATH
      });
      
      try {
        const chromePath = this.findChromePath();
        if (!chromePath) {
          console.error('Chrome not found in any location');
          try {
            console.log('Available Chrome installations:');
            console.log(execSync('which google-chrome-stable google-chrome chromium chromium-browser 2>/dev/null || true').toString());
            console.log('\nFile listing of /usr/bin:');
            console.log(execSync('ls -la /usr/bin/google-chrome* /usr/bin/chromium* 2>/dev/null || true').toString());
          } catch (e) {
            console.error('Error checking Chrome installations:', e.message);
          }
          throw new Error('Chrome not found');
        }

        const launchOptions = {
          executablePath: chromePath,
          headless: 'new',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--single-process'
          ]
        };

        console.log('Launching browser with options:', JSON.stringify(launchOptions, null, 2));
        this.browser = await core.launch(launchOptions);
        
        const version = await this.browser.version();
        console.log('Browser launched successfully. Version:', version);
        
      } catch (error) {
        console.error('Browser initialization error:', error);
        throw error;
      }
    }
    return { browser: this.browser };
  }

  async crawlPage({ url, waitForSelector }) {
    const { browser } = await this.initialize();
    const page = await browser.newPage();
    
    try {
      await page.goto(url, { waitUntil: 'networkidle0' });
      if (waitForSelector) {
        await page.waitForSelector(waitForSelector);
      }
      
      const content = await page.content();
      const parsedContent = await this.parser.parseContent(content, url);
      
      return {
        success: true,
        data: parsedContent
      };
    } catch (error) {
      console.error('Error crawling page:', error);
      return {
        success: false,
        error: error.message
      };
    } finally {
      await page.close();
    }
  }

  async cleanup() {
    if (this.browser) {
      try {
        await this.browser.close();
        this.browser = null;
        console.log('Browser cleaned up successfully');
      } catch (error) {
        console.error('Error cleaning up browser:', error);
      }
    }
  }
}

export const crawlerService = new CrawlerService();