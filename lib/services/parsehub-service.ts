class WebReaderService {
  private baseUrl: string;
  private apiKey: string;

  constructor() {
    this.baseUrl = 'https://r.jina.ai';
    // This should be moved to environment variables
    this.apiKey = 'jina_05f4e4d4edbd415cb82c132e3b6c3be1IR3qvg8aiuG9ywtSiO0zGtQL3ocS';
  }

  async fetchPage(url: string, options: { headers?: Record<string, string> } = {}): Promise<string> {
    try {
      console.log('Fetching page:', url);
      
      // Determine the correct selectors based on URL and page type
      let waitForSelector;
      let targetSelector;
      if (url.includes('vividseats.com')) {
        if (url.includes('/search')) {
          waitForSelector = '[data-testid="productions-list"]';
          targetSelector = '[data-testid="productions-list"] a';
        } else {
          waitForSelector = '[data-testid="listings-container"]';
          targetSelector = '[data-testid="listings-container"] a';
        }
      } else if (url.includes('stubhub.com')) {
        // Remove /secure/ from StubHub URLs as it causes issues
        url = url.replace('/secure/', '/');
        if (url.includes('/search')) {
          waitForSelector = '[data-testid="primaryGrid"]';
          targetSelector = '[data-testid="primaryGrid"] a';
        } else {
          waitForSelector = '#listings-container';
          targetSelector = '#listings-container a';
        }
      }

      // Encode the URL
      const encodedUrl = encodeURIComponent(url);
      const readerUrl = `${this.baseUrl}/${encodedUrl}`;
      
      console.log('Reader URL:', readerUrl);
      console.log('Waiting for selector:', waitForSelector);
      console.log('Target selector:', targetSelector);

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${this.apiKey}`,
        'Accept': 'application/json',
        'X-Return-Format': 'html',
        'X-Retain-Images': 'none',
        ...options.headers
      };
      
      if (waitForSelector) {
        headers['X-Wait-For-Selector'] = waitForSelector;
      }
      if (targetSelector) {
        headers['X-Target-Selector'] = targetSelector;
      }

      const response = await fetch(readerUrl, {
        method: 'GET',
        headers
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const jsonResponse = await response.json();
      if (jsonResponse?.data?.html) {
        return jsonResponse.data.html;
      }
      throw new Error('No HTML content in response');
    } catch (error) {
      console.error('Error fetching page:', error);
      throw error;
    }
  }
}

export const webReaderService = new WebReaderService(); 