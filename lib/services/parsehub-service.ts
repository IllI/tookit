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

  private getErrorMessage(status: number, url: string): string {
    const source = url.includes('vividseats.com') ? 'VividSeats' : 'StubHub';
    
    switch (status) {
      case 524:
        return `${source} is experiencing high traffic. Please try again in a few moments.`;
      case 429:
        return `Too many requests to ${source}. Please wait a moment and try again.`;
      case 403:
        return `Access to ${source} is currently restricted. Please try again later.`;
      case 404:
        return `The event page on ${source} could not be found. It may have been removed or sold out.`;
      default:
        return `Unable to fetch tickets from ${source}. Please try again later.`;
    }
  }

  async fetchPage(url: string, options: { headers?: Record<string, string> } = {}): Promise<string> {
    try {
      console.log('Fetching page:', url);

      // Get the appropriate selectors for this URL
      const selectors = this.getSelectors(url);
      console.log('Using selectors:', selectors);

      // Check if this is a VividSeats event page (not search)
      const isVividSeatsEvent = url.includes('vividseats.com') && 
                               url.includes('/tickets/') && 
                               !url.includes('/search?');

      // Use cors.sh for VividSeats event pages, Jina for everything else
      const proxyUrl = isVividSeatsEvent ? 
        `https://cors.sh/${url}` :
        `https://r.jina.ai/${url}`;

      // Only add proxy for Jina requests
      if (!isVividSeatsEvent) {
        options.headers ? options.headers['X-Proxy-Url'] = '47.251.122.81:8888' : options.headers = {'X-Proxy-Url': '47.251.122.81:8888'};
      } else {
        // Add cors.sh headers for VividSeats event pages
        options.headers = {
          'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
          'accept-language': 'en-US,en;q=0.9',
          'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"Windows"'
        };
      }

      const response = await fetch(proxyUrl, {
        method: 'GET',
        headers: isVividSeatsEvent ? options.headers : {
          'Accept': 'application/json',
          'X-Return-Format': 'html',
          'X-Target-Selector': selectors.targetSelector,
          'X-Wait-For-Selector': selectors.waitForSelector,
          ...options.headers
        }
      });

      if (!response.ok) {
        const userMessage = this.getErrorMessage(response.status, url);
        throw new Error(userMessage);
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