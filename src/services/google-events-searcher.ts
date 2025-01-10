import { crawlerService } from './crawler-service';
import { getJson } from 'serpapi';

class GoogleEventsSearcher {
  private apiKey: string;

  constructor() {
    this.apiKey = 'ef96da14f879948ae93fb073175e12ad532423ece415ab8ae4f6c612e2aef105';
  }

  async searchConcerts(artist: string, venue?: string, location?: string) {
    try {
      const searchUrl = this.generateSearchUrl(artist, venue, location);
      console.log('Searching via Google Events:', searchUrl);

      // First try Google Events API
      const eventsResults = await this.searchGoogleEvents(artist, location);
      
      if (eventsResults.length > 0) {
        console.log(`Found ${eventsResults.length} events via Google Events API`);
        return eventsResults;
      }

      // Fallback to regular search
      console.log('No events found via Events API, trying regular search...');
      
      const result = await crawlerService.crawlPage({
        url: searchUrl,
        waitForSelector: 'body',
        searchParams: {
          keyword: artist,
          location: location
        }
      });

      return (result?.data?.events || []).map(event => ({
        ...event,
        source: this.determineSource(event)
      }));

    } catch (error) {
      console.error('Google Events search error:', error);
      return [];
    }
  }

  private generateSearchUrl(artist: string, venue?: string, location?: string) {
    const searchParams = new URLSearchParams();
    const searchTerms = [artist, venue, location].filter(Boolean);
    searchParams.append('q', searchTerms.join(' '));
    searchParams.append('ibp', 'htl;events');
    if (location) {
      searchParams.append('location', location);
    }
    return `https://www.google.com/search?${searchParams.toString()}`;
  }

  private async searchGoogleEvents(keyword: string, location?: string) {
    const params = {
      engine: "google_events",
      q: keyword,
      location: location,
      htichips: "date:upcoming",
      hl: "en",
      gl: "us",
      api_key: this.apiKey
    };

    const response = await getJson(params);
    
    if (!response.events_results?.length) {
      return [];
    }

    return response.events_results.map(event => ({
      name: event.title,
      date: event.date?.start_date || event.date?.when,
      venue: event.venue?.name,
      location: this.parseLocation(event.venue?.address),
      category: 'Concert',
      link: this.findPrimaryTicketLink(event.ticket_info)
    }));
  }

  private parseLocation(address?: string) {
    if (!address) return 'Unknown Location';
    const parts = address.split(',').map(part => part.trim());
    if (parts.length >= 2) {
      return `${parts[0]}, ${parts[1]}`;
    }
    return parts[0] || 'Unknown Location';
  }

  private findPrimaryTicketLink(ticketInfo?: any[]) {
    if (!ticketInfo?.length) return null;

    const PRIORITY_VENDORS = [
      'ticketmaster',
      'axs',
      'etix',
      'eventbrite',
      'dice',
      'bandsintown'
    ];

    // First try to find official/primary vendor
    const primaryTicket = ticketInfo.find(ticket => 
      ticket.type === 'primary' || ticket.is_official
    );
    if (primaryTicket?.link) return primaryTicket.link;

    // Then try to find by priority
    for (const vendor of PRIORITY_VENDORS) {
      const ticket = ticketInfo.find(t => 
        t.source?.toLowerCase().includes(vendor)
      );
      if (ticket?.link) return ticket.link;
    }

    // Return first available link if no priority vendor found
    return ticketInfo[0]?.link;
  }

  private determineSource(event: any) {
    if (!event.link) return 'unknown';
    try {
      const url = new URL(event.link);
      const domain = url.hostname.toLowerCase();
      
      if (domain.includes('ticketmaster')) return 'ticketmaster';
      if (domain.includes('axs')) return 'axs';
      if (domain.includes('etix')) return 'etix';
      if (domain.includes('eventbrite')) return 'eventbrite';
      if (domain.includes('dice.fm')) return 'dice';
      if (domain.includes('bandsintown')) return 'bandsintown';
      
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }
}

export default GoogleEventsSearcher;