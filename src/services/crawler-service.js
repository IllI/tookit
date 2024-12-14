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

  setSearchService(service) {
    this.searchService = service;
  }

  async initialize() {
    if (!this.browser) {
      console.log('Setting up browser...');
      
      try {
        console.log('Launch options for browser:', {
          executablePath: '/usr/bin/chromium-browser',
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        
        this.browser = await core.launch({
          executablePath: '/usr/bin/chromium-browser',
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu'
          ]
        });
        
        const version = await this.browser.version();
        console.log('Browser launched successfully. Version:', version);
        
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