import { crawlerService } from './services/crawler-service';

export async function setupBrowser() {
  try {
    const browser = await crawlerService.getBrowser();
    if (!browser) {
      throw new Error('Browser initialization failed');
    }
    return browser;
  } catch (error) {
    console.error('Failed to setup browser:', error);
    throw error;
  }
}

export async function setupPage(browser) {
  if (!browser) {
    throw new Error('Browser is required');
  }
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8'
    });
    return page;
  } catch (error) {
    console.error('Failed to setup page:', error);
    throw error;
  }
}

export function formatPrice(price) {
  if (typeof price === 'string') {
    return parseFloat(price.replace(/[^0-9.]/g, ''));
  }
  return price;
}