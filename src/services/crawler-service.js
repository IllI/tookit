import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { parserService } from './parser-service';

puppeteer.use(StealthPlugin());

class CrawlerService {
  constructor() {
    this.browser = null;
    this.maxAttempts = 3;
    this.retryDelays = [2000, 3000, 4000];
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

  async crawlPage(url) {
    if (!url || typeof url !== 'string') {
      throw new Error('Invalid URL provided to crawlPage');
    }

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
          console.log(`Attempt ${attempt}/${this.maxAttempts} to load: ${url}`);
          
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
          
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

          // Get page content
          const html = await page.content();

          // Use HuggingFace parser to extract information
          const parsedData = await parserService.parseContent(html, url);
          console.log('Parsed data:', parsedData);

          return parsedData;

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