import puppeteer from 'puppeteer-core';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import chromium from '@sparticuz/chromium';

const isDev = process.env.NODE_ENV === 'development';
const isVercel = process.env.VERCEL === '1';

puppeteer.use(StealthPlugin());

async function setupBrowser() {
  if (isDev && !isVercel) {
    // Development setup (visible browser for debugging)
    return await puppeteer.launch({
      headless: false,
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
  } else {
    // Production (Vercel) setup or when explicitly needed
    return await puppeteer.launch({
      args: [
        ...chromium.args,
        '--hide-scrollbars',
        '--disable-web-security',
        '--disable-features=site-per-process',
        '--disable-blink-features=AutomationControlled'
      ],
      defaultViewport: chromium.defaultViewport,
      executablePath: await chromium.executablePath(),
      headless: "new", // Use new headless mode
      ignoreHTTPSErrors: true,
    });
  }
}

async function setupPage(browser) {
  const page = await browser.newPage();
  
  await page.setExtraHTTPHeaders({
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive'
  });

  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Additional stealth settings for both environments
  await page.evaluateOnNewDocument(() => {
    // Overwrite the 'webdriver' property to make it undefined
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined
    });
  });

  return page;
}

function formatPrice(price) {
  if (typeof price === 'string') {
    return parseFloat(price.replace(/[^0-9.]/g, ''));
  }
  return price;
}

export {
  setupBrowser,
  setupPage,
  formatPrice
};