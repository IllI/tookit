import puppeteer from 'puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { addExtra } from 'puppeteer-extra';

const isDev = process.env.NODE_ENV === 'development';
const isRender = process.env.RENDER === '1' || process.env.RENDER === 'true';
const isDebug = process.argv.includes('--debug');

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function setupBrowser() {
  try {
    const options = {
      headless: !isDev,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
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

    console.log('Browser launch options:', {
      executablePath: options.executablePath,
      env: process.env.PUPPETEER_EXECUTABLE_PATH
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
  
  // Set user agent before anything else
  await page.setUserAgent(USER_AGENT);
  
  // Set longer timeouts
  await page.setDefaultTimeout(90000);
  await page.setDefaultNavigationTimeout(90000);

  // Set geolocation permissions
  const context = page.browserContext();
  await context.overridePermissions('https://www.stubhub.com', ['geolocation']);

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
      platform: { get: () => 'Win32' },
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

    // Add WebGL support
    const getParameter = WebGLRenderingContext.prototype.getParameter;
    WebGLRenderingContext.prototype.getParameter = function(parameter) {
      // Spoof renderer info
      if (parameter === 37445) {
        return 'Intel Inc.';
      }
      if (parameter === 37446) {
        return 'Intel Iris OpenGL Engine';
      }
      return getParameter.apply(this, [parameter]);
    };
  });

  // Set convincing headers
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1'
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