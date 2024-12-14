import { crawlerService } from './services/crawler-service';

class StubHubSearcher {
  generateSearchUrl(artist, venue, location) {
    const searchParams = new URLSearchParams();
    const searchTerms = [artist, venue, location].filter(Boolean);
    searchParams.append('q', searchTerms.join(' '));
    return `https://www.stubhub.com/secure/search?${searchParams.toString()}`;
  }

  async searchConcerts(artist, venue, location) {
    try {
      const searchUrl = this.generateSearchUrl(artist, venue, location);
      console.log('Navigating to:', searchUrl);

      const result = await crawlerService.crawlPage({
        url: searchUrl,
        waitForSelector: 'body'
      });

      const events = result?.data?.events || [];
      console.log(`Found ${events.length} events on StubHub`);

      return events.map(event => ({
        ...event,
        source: 'stubhub'
      }));
    } catch (error) {
      console.error('StubHub search error:', error);
      return [];
    }
  }
}

export default StubHubSearcher;