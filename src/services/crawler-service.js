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

  async findChromePath() {
    const { execSync } = require('child_process');
    const paths = [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/opt/google/chrome/chrome',
      '/opt/chrome/chrome'
    ];

    for (const path of paths) {
      try {
        execSync(`test -f ${path}`);
        const version = execSync(`${path} --version`).toString().trim();
        console.log(`Found Chrome at ${path}, version: ${version}`);
        return path;
      } catch (e) {
        console.log(`No Chrome at ${path}`);
      }
    }

    try {
      const path = execSync('which google-chrome-stable').toString().trim();
      const version = execSync(`${path} --version`).toString().trim();
      console.log(`Found Chrome using which: ${path}, version: ${version}`);
      return path;
    } catch (e) {
      console.log('Failed to find Chrome using which');
    }

    return null;
  }

  async initialize() {
    if (!this.browser) {
      console.log('Setting up browser...');
      
      try {
        const chromePath = await this.findChromePath();
        console.log('Chrome path search complete');
        
        if (!chromePath) {
          console.error('Could not find Chrome installation');
          try {
            const { execSync } = require('child_process');
            console.log('System Chrome information:');
            console.log(execSync('apt list --installed | grep chrome').toString());
            console.log(execSync('find /usr -name "*chrome*" -type f 2>/dev/null').toString());
          } catch (e) {
            console.log('Failed to get system Chrome information:', e.message);
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
            '--disable-software-rasterizer',
            '--disable-dev-tools'
          ]
        };

        console.log('Launching browser with options:', JSON.stringify(launchOptions, null, 2));
        this.browser = await core.launch(launchOptions);
        
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