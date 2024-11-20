import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { executablePath } from 'puppeteer';

puppeteer.use(StealthPlugin());

export async function setupBrowser() {
  return await puppeteer.launch({
    headless: false,
    executablePath: executablePath(),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1920,1080',
      '--disable-features=site-per-process',
      '--disable-web-security'
    ],
    defaultViewport: { width: 1920, height: 1080 }
  });
}

export async function setupPage(browser) {
  const page = await browser.newPage();
  
  await page.setExtraHTTPHeaders({
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive'
  });

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  return page;
}

export function formatPrice(price) {
  return typeof price === 'number' ? price.toFixed(2) : price;
}

module.exports = {
  setupBrowser,
  setupPage,
  formatPrice
};