import fs from 'fs';
import path from 'path';

interface ChromeInfo {
  executablePath: string;
  type: 'chrome' | 'chromium' | 'edge';
  version?: string;
}

const WIN_CHROME_PATHS = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
];

const MAC_CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
];

const LINUX_CHROME_PATHS = [
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge'
];

export class BrowserFinder {
  static async findChrome(): Promise<ChromeInfo | null> {
    // Check environment variable first
    if (process.env.CHROME_PATH) {
      try {
        await fs.promises.access(process.env.CHROME_PATH);
        return {
          executablePath: process.env.CHROME_PATH,
          type: this.getBrowserType(process.env.CHROME_PATH)
        };
      } catch (error) {
        console.warn('CHROME_PATH environment variable set but browser not found:', error);
      }
    }

    // Get paths based on platform
    const paths = process.platform === 'win32' ? WIN_CHROME_PATHS
                : process.platform === 'darwin' ? MAC_CHROME_PATHS
                : LINUX_CHROME_PATHS;

    // Try each path
    for (const browserPath of paths) {
      try {
        await fs.promises.access(browserPath);
        return {
          executablePath: browserPath,
          type: this.getBrowserType(browserPath)
        };
      } catch {
        continue;
      }
    }

    return null;
  }

  private static getBrowserType(path: string): ChromeInfo['type'] {
    const lowercasePath = path.toLowerCase();
    if (lowercasePath.includes('edge')) return 'edge';
    if (lowercasePath.includes('chromium')) return 'chromium';
    return 'chrome';
  }

  static async getVersion(browserPath: string): Promise<string | undefined> {
    // This would use the browser's --version flag to get the version
    // Implementation depends on platform and browser type
    return undefined;
  }

  static getBrowserNotFoundMessage(): string {
    const platform = process.platform;
    let message = 'No compatible browser found. Please install Google Chrome, Chromium, or Microsoft Edge.';
    
    if (platform === 'win32') {
      message += '\nExpected locations:\n- ' + WIN_CHROME_PATHS.join('\n- ');
    } else if (platform === 'darwin') {
      message += '\nExpected locations:\n- ' + MAC_CHROME_PATHS.join('\n- ');
    } else {
      message += '\nExpected locations:\n- ' + LINUX_CHROME_PATHS.join('\n- ');
    }

    message += '\n\nOr set CHROME_PATH environment variable to your browser\'s executable path.';
    return message;
  }
}
