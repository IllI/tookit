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

  async initialize() {
    if (!this.browser) {
      console.log('Setting up browser...');
      
      try {
        // Use path from environment variable
        const chromePath = process.env.CHROME_EXECUTABLE_PATH;
        console.log(`Using Chrome path from env: ${chromePath}`);
        
        if (!chromePath || !this.verifyChromePath(chromePath)) {
          console.error('Chrome not found at configured path');
          try {
            console.log('Available Chrome installations:');
            console.log(execSync('which chromium chromium-browser google-chrome-stable 2>/dev/null || true').toString());
            console.log('\nSystem PATH:');
            console.log(process.env.PATH);
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