import { createClient } from '@supabase/supabase-js';
import core from 'puppeteer-core';
import { getParser } from './llm-service';

const DEFAULT_CHROME_PATH = '/usr/bin/google-chrome-stable';

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
      const { execSync } = require('child_process');
      execSync(`test -f ${path}`);
      const version = execSync(`${path} --version 2>/dev/null`).toString();
      console.log(`Verified Chrome at ${path}: ${version}`);
      return true;
    } catch (e) {
      console.log(`Failed to verify Chrome at ${path}: ${e.message}`);
      return false;
    }
  }

  async initialize() {
    if (!this.browser) {
      console.log('Setting up browser...');
      
      try {
        // First try the default path
        let chromePath = DEFAULT_CHROME_PATH;
        let chromeFound = this.verifyChromePath(chromePath);
        
        if (!chromeFound) {
          console.error('Chrome not found at default location');
          const { execSync } = require('child_process');
          
          try {
            console.log('Chrome package files:');
            console.log(execSync('ls -laR /opt/chrome').toString());
            console.log('\nChrome binaries:');
            console.log(execSync('find /usr/bin -name "*chrome*"').toString());
            console.log('\nSearch for Chrome:');
            console.log(execSync('find / -name "*chrome*" -type f 2>/dev/null').toString());
          } catch (e) {
            console.error('Error checking Chrome installation:', e.message);
          }
          
          throw new Error(`Chrome not found at ${chromePath}`);
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