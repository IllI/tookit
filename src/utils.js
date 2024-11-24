import puppeteer from 'puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { addExtra } from 'puppeteer-extra';

const isDev = process.env.NODE_ENV === 'development';
const isRender = process.env.RENDER === '1' || process.env.RENDER === 'true';
const isDebug = process.argv.includes('--debug');

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.67 Safari/537.36';

async function setupBrowser() {
  try {
    // Add stealth plugin to puppeteer
    const puppeteerExtra = addExtra(puppeteer);
    puppeteerExtra.use(StealthPlugin());

    const launchOptions = {
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--window-size=1920,1080',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--allow-running-insecure-content',
        '--disable-blink-features=AutomationControlled',
        '--disable-sync',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--user-agent=' + USER_AGENT
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: { width: 1920, height: 1080 }
    };

    console.log('Launching browser with options:', {
      isDev,
      isRender,
      isDebug,
      cacheDir: process.env.PUPPETEER_CACHE_DIR,
      platform: process.platform,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        RENDER: process.env.RENDER
      }
    });

    const browser = await puppeteerExtra.launch(launchOptions);
    console.log('Browser launched successfully in', isDebug ? 'visible' : 'headless', 'mode');
    
    // Log browser version for debugging
    const version = await browser.version();
    console.log('Browser version:', version);

    return browser;

  } catch (error) {
    console.error('Error setting up browser:', error);
    console.error('Launch options:', {
      isDev,
      isRender,
      isDebug,
      platform: process.platform,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        RENDER: process.env.RENDER,
        PUPPETEER_CACHE_DIR: process.env.PUPPETEER_CACHE_DIR
      }
    });
    throw error;
  }
}

async function setupPage(browser) {
  const page = await browser.newPage();
  
  // Set user agent before anything else
  await page.setUserAgent(USER_AGENT);
  
  // Set longer timeouts
  await page.setDefaultTimeout(60000);
  await page.setDefaultNavigationTimeout(60000);

  // Enhanced stealth settings
  await page.evaluateOnNewDocument(() => {
    // Overwrite navigator properties
    Object.defineProperties(navigator, {
      webdriver: { get: () => undefined },
      languages: { get: () => ['en-US', 'en'] },
      plugins: {
        get: () => [
          {
            0: {
              type: 'application/x-google-chrome-pdf',
              suffixes: 'pdf',
              description: 'Portable Document Format',
              enabledPlugin: true
            },
            description: 'Portable Document Format',
            filename: 'internal-pdf-viewer',
            length: 1,
            name: 'Chrome PDF Plugin'
          }
        ]
      },
      platform: { get: () => 'Linux x86_64' },
      vendor: { get: () => 'Google Inc.' }
    });

    // Add missing chrome properties
    window.chrome = {
      app: {
        isInstalled: false,
        InstallState: {
          DISABLED: 'disabled',
          INSTALLED: 'installed',
          NOT_INSTALLED: 'not_installed'
        },
        RunningState: {
          CANNOT_RUN: 'cannot_run',
          READY_TO_RUN: 'ready_to_run',
          RUNNING: 'running'
        }
      },
      runtime: {
        PlatformOs: {
          MAC: 'mac',
          WIN: 'win',
          ANDROID: 'android',
          CROS: 'cros',
          LINUX: 'linux',
          OPENBSD: 'openbsd'
        },
        PlatformArch: {
          ARM: 'arm',
          X86_32: 'x86-32',
          X86_64: 'x86-64'
        },
        RequestUpdateCheckStatus: {
          THROTTLED: 'throttled',
          NO_UPDATE: 'no_update',
          UPDATE_AVAILABLE: 'update_available'
        },
        OnInstalledReason: {
          INSTALL: 'install',
          UPDATE: 'update',
          CHROME_UPDATE: 'chrome_update',
          SHARED_MODULE_UPDATE: 'shared_module_update'
        },
        OnRestartRequiredReason: {
          APP_UPDATE: 'app_update',
          OS_UPDATE: 'os_update',
          PERIODIC: 'periodic'
        }
      }
    };
  });

  // Set convincing headers
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Google Chrome";v="101", " Not A;Brand";v="99", "Chromium";v="101"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Linux"'
  });

  // Set viewport
  await page.setViewport({ width: 1920, height: 1080 });

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