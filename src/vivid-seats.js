import { crawlerService } from './services/crawler-service';

class VividSeatsSearcher {
  generateSearchUrl(artist, venue, location) {
    const searchTerms = [artist, venue, location].filter(Boolean);
    const searchQuery = encodeURIComponent(searchTerms.join(' '));
    return `https://www.vividseats.com/search?searchTerm=${searchQuery}`;
  }

  async searchConcerts(artist, venue, location) {
    try {
      const searchUrl = this.generateSearchUrl(artist, venue, location);
      console.log('Searching VividSeats:', searchUrl);

      const result = await crawlerService.crawlPage({
        url: searchUrl,
        waitForSelector: 'body'  // Wait for any content to load
      });

      const events = result?.data?.events || [];
      console.log(`Found ${events.length} events on VividSeats`);

      return events.map(event => ({
        ...event,
        source: 'vividseats'
      }));
    } catch (error) {
      console.error('VividSeats search error:', error);
      return [];
    }
  }
}

export default VividSeatsSearcher;