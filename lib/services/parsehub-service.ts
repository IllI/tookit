import { load } from 'cheerio';

class WebReaderService {
  private getSelectors(url: string): { waitForSelector: string; targetSelector: string } {
    if (url.includes('vividseats.com')) {
      if (url.includes('/search')) {
        return {
          waitForSelector: '[data-testid="productions-list"]',
          targetSelector: '[data-testid="productions-list"] a'
        };
      } else {
        return {
          waitForSelector: '[data-testid="listings-container"]',
          targetSelector: '[data-testid="listings-container"]'
        };
      }
    } else if (url.includes('stubhub.com')) {
      if (url.includes('/search')) {
        return {
          waitForSelector: '[data-testid="primaryGrid"]',
          targetSelector: '[data-testid="primaryGrid"] a'
        };
      } else {
        return {
          waitForSelector: '#listings-container',
          targetSelector: '#listings-container [data-is-sold="0"]'
        };
      }
    }
    return {
      waitForSelector: 'body',
      targetSelector: 'body'
    };
  }

  async fetchPage(url: string, options: { headers?: Record<string, string> } = {}): Promise<string> {
    try {
      console.log('Fetching page:', url);

      // Get the appropriate selectors for this URL
      const selectors = this.getSelectors(url);
      console.log('Using selectors:', selectors);

      // Parse URL to get hostname and path
      const proxyUrl = new URL(`https://r.jina.ai/${url}`);

      const response = await fetch(proxyUrl, {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
          'X-Return-Format': 'html',
          'X-Target-Selector': selectors.targetSelector,
          'X-Wait-For-Selector': selectors.waitForSelector,
          ...options.headers
        }
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`HTTP error! status: ${response.status}, details: ${errorText}`);
      }

      const text = await response.text();
      
      try {
        const jsonResponse = JSON.parse(text);
        if (jsonResponse.data?.html) {
          console.log(`Received HTML from ${url.includes('vividseats') ? 'vividseats' : 'stubhub'} (${jsonResponse.data.html.length} bytes)`);
          return jsonResponse.data.html;
        }
      } catch (e) {
        console.warn('Response was not JSON:', e instanceof Error ? e.message : String(e));
      }
      
      return text;
    } catch (error) {
      console.error('Error fetching page:', error);
      throw error;
    }
  }
}

export const webReaderService = new WebReaderService(); 