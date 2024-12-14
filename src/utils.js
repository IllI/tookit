import { crawlerService } from './services/crawler-service';
import puppeteer from 'puppeteer';

const isDev = process.env.NODE_ENV === 'development';
const isRender = process.env.RENDER === '1' || process.env.RENDER === 'true';
const isDebug = process.argv.includes('--debug');

// Use Linux user agent for Render.com environment
const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36';

async function setupBrowser() {
  try {
    const options = {
      headless: !isDev,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-site-isolation-trials',
        '--disable-breakpad',
        '--disable-sync',
        '--no-first-run',
        '--no-experiments',
        '--no-default-browser-check',
        '--disable-infobars',
        '--disable-translate',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--user-agent=' + USER_AGENT,
        '--enable-javascript',
        '--disable-notifications',
        '--lang=en-US,en'
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: { width: 1920, height: 1080 }
    };

    console.log('Launching browser with options:', {
      headless: options.headless,
      args: options.args
    });

    const browser = await puppeteer.launch(options);
    return browser;
  } catch (error) {
    console.error('Browser setup failed:', error);
    throw error;
  }
}

async function setupPage(browser) {
  const page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);

  // Set longer timeouts
  await page.setDefaultTimeout(60000);
  await page.setDefaultNavigationTimeout(60000);

  // Enhanced stealth settings
  await page.evaluateOnNewDocument(() => {
    Object.defineProperties(navigator, {
      webdriver: { get: () => undefined },
      plugins: {
        get: () => [
          {
            0: {
              type: "application/x-google-chrome-pdf",
              suffixes: "pdf",
              description: "Portable Document Format",
              enabledPlugin: Plugin
            },
            description: "Portable Document Format",
            filename: "internal-pdf-viewer",
            length: 1,
            name: "Chrome PDF Plugin"
          }
        ]
      },
      platform: { get: () => 'Linux x86_64' },
      vendor: { get: () => 'Google Inc.' }
    });
  });

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1'
  });

  return page;
}

export { setupBrowser, setupPage, formatPrice };