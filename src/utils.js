import puppeteer from 'puppeteer';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { addExtra } from 'puppeteer-extra';
import { execSync } from 'child_process';

const isDev = process.env.NODE_ENV === 'development';
const isRender = process.env.RENDER === '1' || process.env.RENDER === 'true';
const isDebug = process.argv.includes('--debug');

async function setupBrowser() {
  try {
    // Add stealth plugin to puppeteer
    const puppeteerExtra = addExtra(puppeteer);
    puppeteerExtra.use(StealthPlugin());

    // Check for Chrome on Linux
    if (process.platform === 'linux') {
      try {
        console.log('Checking for Chrome binary:');
        const whichOutput = execSync('which google-chrome').toString();
        console.log('which output:', whichOutput);
        
        const versionOutput = execSync('google-chrome --version').toString();
        console.log('version output:', versionOutput);
      } catch (error) {
        console.error('Error checking Chrome:', error);
      }
    }

    const launchOptions = {
      headless: "new",
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-web-security',
        '--disable-sync',
        '--window-size=1920,1080',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--hide-scrollbars'
      ],
      ignoreDefaultArgs: ['--enable-automation'],
      defaultViewport: { width: 1920, height: 1080 }
    };

    // Set Chrome path in production or on Render
    if (!isDev || isRender) {
      launchOptions.executablePath = '/usr/bin/google-chrome';
      console.log('Using Chrome at:', launchOptions.executablePath);
    }

    console.log('Launching browser with options:', {
      isDev,
      isRender,
      isDebug,
      executablePath: launchOptions.executablePath || 'default',
      platform: process.platform,
      env: {
        NODE_ENV: process.env.NODE_ENV,
        RENDER: process.env.RENDER,
        CHROME_PATH: process.env.CHROME_PATH
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
        CHROME_PATH: process.env.CHROME_PATH
      }
    });
    throw error;
  }
}

async function setupPage(browser) {
  const page = await browser.newPage();
  
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

    // Modify permissions API
    const originalQuery = window.navigator.permissions?.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );

    // Add WebGL properties
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
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"'
  });

  // Set viewport and user agent
  await page.setViewport({ width: 1920, height: 1080 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Add additional page configurations
  await page.setDefaultNavigationTimeout(60000);
  await page.setDefaultTimeout(30000);

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