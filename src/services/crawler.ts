import { createClient } from '@supabase/supabase-js';
import puppeteer from 'puppeteer';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import UserAgent from 'user-agents';
import { getParser } from './llm-service';
import { TicketParser } from './ticket-parser';

const browser = {
  instance: null as puppeteer.Browser | null,
  async get() {
    if (!this.instance) {
      const puppeteerExtra = addExtra(puppeteer);
      puppeteerExtra.use(StealthPlugin());

      this.instance = await puppeteerExtra.launch({
        headless: true,
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
      });
    }
    return this.instance;
  },
  async close() {
    if (this.instance) {
      await this.instance.close();
      this.instance = null;
    }
  }
};

export async function crawlPage({ url, waitForSelector }: { url: string; waitForSelector?: string }) {
  let page = null;
  let context = null;

  try {
    const browserInstance = await browser.get();
    context = await browserInstance.createIncognitoBrowserContext();
    page = await context.newPage();

    // Set user agent
    const userAgent = new UserAgent({ deviceCategory: 'desktop' });
    await page.setUserAgent(userAgent.toString());

    // Configure viewport
    await page.setViewport({
      width: 1920 + Math.floor(Math.random() * 100),
      height: 1080 + Math.floor(Math.random() * 100)
    });

    // Set timeouts
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    // Anti-bot measures
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [
          { name: 'Chrome PDF Plugin' },
          { name: 'Chrome PDF Viewer' },
          { name: 'Native Client' }
        ]
      });
    });

    // Navigate
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Wait for content
    if (waitForSelector) {
      await page.waitForSelector(waitForSelector, { timeout: 30000 })
        .catch(() => console.log(`Selector ${waitForSelector} not found`));
    }

    // Extract content
    const content = await page.evaluate(() => ({
      text: document.body.innerText,
      html: document.documentElement.outerHTML,
      title: document.title,
      url: window.location.href,
      contentLength: document.body.innerText.length
    }));

    if (content.contentLength <= 500) {
      throw new Error('Insufficient content loaded');
    }

    // Parse content
    const source = url.includes('stubhub') ? 'stubhub' : 'vividseats';
    const isSearchPage = url.includes('search');
    const parser = new TicketParser(content.html, source);
    const parsedContent = isSearchPage 
      ? parser.parseSearchResults()
      : parser.parseEventTickets();

    return {
      ...content,
      parsedContent
    };

  } catch (error) {
    console.error('Error loading page:', error);
    throw error;
  } finally {
    if (page) await page.close();
    if (context) await context.close();
  }
}