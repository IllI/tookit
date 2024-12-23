import { createClient } from '@supabase/supabase-js';
import puppeteerCore from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

const puppeteer = addExtra(puppeteerCore);
puppeteer.use(StealthPlugin());

class CrawlerService {
  constructor() {
    this.browser = null;
    this.maxAttempts = 3;
    this.retryDelays = [2000, 3000, 4000];
    this.processedEvents = new Set();
    
    // Initialize Supabase client
    this.supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
    );
    this.searchService = null;
  }

  setSearchService(service) {
    this.searchService = service;
  }

  sendStatus(message) {
    if (this.searchService) {
      this.searchService.emit('status', message);
    }
    console.log(message);
  }

  async initialize() {
    if (!this.browser) {
      const launchOptions = {
        headless: 'new',
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-accelerated-2d-canvas',
          '--disable-gpu',
          '--window-size=1920,1080',
          '--disable-blink-features=AutomationControlled'
        ],
        ignoreDefaultArgs: ['--enable-automation']
      };

      this.browser = await puppeteer.launch(launchOptions);
      console.log('Browser initialized');
    }
    return { browser: this.browser };
  }

  async crawlPage(options) {
    const url = typeof options === 'string' ? options : options?.url;
    
    if (!url || typeof url !== 'string') {
      throw new Error('Invalid URL provided to crawlPage');
    }

    // Ensure URL is properly encoded
    const encodedUrl = encodeURI(decodeURI(url));
    console.log('Encoded URL:', encodedUrl);

    const { browser } = await this.initialize();
    let context = null;
    let page = null;
    let attempt = 1;

    try {
      context = await browser.createIncognitoBrowserContext();
      page = await context.newPage();
      
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
      
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'sec-ch-ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"'
      });

      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', {
          get: () => undefined
        });
        window.navigator.chrome = {
          runtime: {}
        };
      });

      while (attempt <= this.maxAttempts) {
        try {
          console.log(`Attempt ${attempt}/${this.maxAttempts} to load: ${encodedUrl}`);
          
          await page.goto(encodedUrl, { 
            waitUntil: 'domcontentloaded', 
            timeout: 30000 
          });
          
          const isEventPage = !url.includes('search');
          if (isEventPage) {
            try {
              await page.waitForTimeout(5000);
              await page.waitForFunction(
                () => {
                  const content = document.body.innerText;
                  return content.length > 1000 && 
                         (content.includes('Section') || content.includes('Row') || 
                          content.includes('Quantity') || content.includes('Price'));
                },
                { timeout: 5000, polling: 100 }
              );
              console.log('Event page content loaded');
            } catch (error) {
              console.log('Error waiting for ticket content:', error);
            }
          }

          await page.waitForFunction(
            () => document.body && document.body.innerText.length > 500,
            { timeout: 5000, polling: 100 }
          );

          const content = await page.evaluate(() => ({
            text: document.body.innerText,
            html: document.documentElement.outerHTML,
            title: document.title,
            url: window.location.href,
            contentLength: document.body.innerText.length
          }));

          if (content.contentLength > 500) {
            console.log('Page loaded successfully');
            return content;
          }

          console.log('Invalid content, retrying...');
          await page.waitForTimeout(this.retryDelays[attempt - 1]);
          attempt++;

        } catch (error) {
          console.error(`Error in attempt ${attempt}:`, error);
          if (attempt === this.maxAttempts) throw error;
          await page.waitForTimeout(this.retryDelays[attempt - 1]);
          attempt++;
        }
      }

      throw new Error('Failed to load page after all attempts');

    } finally {
      if (context) await context.close();
    }
  }

  async cleanup() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      console.log('Browser closed');
    }
  }
}

const crawlerService = new CrawlerService();
export { crawlerService };