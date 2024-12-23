import { load } from 'cheerio';

export class TicketParser {
  private $: cheerio.Root;
  private source: string;
  private url: string;

  constructor(html: string, source: string) {
    this.$ = load(html);
    this.source = source;
    this.url = this.$('link[rel="canonical"]').attr('href') || '';
  }

  async parseSearchResults() {
    try {
      const events = [];
      if (this.source === 'stubhub') {
        const listings = this.$('a[href*="/event/"]');
        listings.each((_, elem) => {
          const card = this.$(elem);
          events.push({
            url: card.attr('href'),
            name: card.find('h3').text().trim(),
            date: card.find('time').text().trim(),
            venue: card.find('span').eq(1).text().split('•')[0]?.trim(),
            location: card.find('span').eq(1).text().split('•')[1]?.trim()
          });
        });
      } else {
        const listings = this.$('[data-testid^="production-listing-"]');
        listings.each((_, elem) => {
          const card = this.$(elem);
          events.push({
            url: card.find('a').attr('href'),
            name: card.find('[class*="ProductName"]').text().trim(),
            date: card.find('[class*="DateAndTime"]').text().trim(),
            venue: card.find('[class*="VenueName"]').text().trim(),
            location: card.find('[class*="Location"]').text().trim()
          });
        });
      }
      return { events: events.filter(e => e.name && e.url) };
    } catch (error) {
      console.error('Parse error:', error);
      return { events: [] };
    }
  }
}