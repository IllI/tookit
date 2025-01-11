import { logger } from '../utils/logger';

export interface TicketmasterEvent {
  id: string;
  name: string;
  date: string;
  venue: {
    id: string;
    name: string;
    city: string;
    state: string;
    country: string;
  };
  url: string;
  dbId?: string; // Optional field to store the database UUID
}

export class TicketmasterService {
  private readonly baseUrl = 'https://app.ticketmaster.com/discovery/v2';
  private readonly apiKey: string;

  constructor() {
    const apiKey = process.env.TICKETMASTER_API_KEY;
    if (!apiKey) {
      throw new Error('TICKETMASTER_API_KEY environment variable is required');
    }
    this.apiKey = apiKey;
  }

  async searchEvents(keyword: string, location?: string): Promise<TicketmasterEvent[]> {
    try {
      // Base parameters
      const params = new URLSearchParams({
        apikey: this.apiKey,
        keyword,
        size: '20',
        sort: 'date,asc',
        countryCode: 'US', // Limit to US events
        locale: '*' // Return all available languages
      });

      // Add location-based search if provided
      if (location) {
        // Extract city and state if provided in format "City, ST"
        const [city, state] = location.split(',').map(s => s.trim());
        
        if (state) {
          params.append('stateCode', state);
          params.append('city', city);
        } else {
          // If only city provided, use radius search
          params.append('city', location);
          params.append('radius', '50'); // 50 mile radius
          params.append('unit', 'miles');
        }
      }

      logger.info('Searching Ticketmaster events:', { keyword, location, url: `${this.baseUrl}/events.json?${params.toString()}` });

      const response = await fetch(`${this.baseUrl}/events.json?${params.toString()}`);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => null);
        logger.error('Ticketmaster API error:', { 
          status: response.status, 
          statusText: response.statusText,
          error: errorData 
        });
        throw new Error(`Ticketmaster API error: ${response.statusText}`);
      }

      const data = await response.json();
      
      // If no events found, return empty array
      if (!data._embedded?.events) {
        logger.info('No events found for search:', { keyword, location });
        return [];
      }

      logger.info('Raw Ticketmaster response:', { 
        totalEvents: data._embedded.events.length,
        firstEvent: data._embedded.events[0]
      });

      // Map and validate event data
      return data._embedded.events.map((event: any) => {
        try {
          if (!event.id || !event.name) {
            logger.info('Invalid event data:', event);
            return null;
          }

          const venue = event._embedded?.venues?.[0];
          if (!venue) {
            logger.info('Event has no venue data:', event.id);
            return null;
          }

          const mappedEvent = {
            id: event.id,
            name: event.name,
            date: event.dates.start.dateTime || event.dates.start.localDate,
            venue: {
              id: venue.id || 'unknown',
              name: venue.name || 'Unknown Venue',
              city: venue.city?.name || 'Unknown City',
              state: venue.state?.stateCode || 'Unknown State',
              country: venue.country?.countryCode || 'Unknown Country'
            },
            url: event.url
          };

          logger.info('Mapped Ticketmaster event:', mappedEvent);
          return mappedEvent;
        } catch (error) {
          logger.error('Error processing event data:', { eventId: event.id, error });
          return null;
        }
      }).filter(Boolean) as TicketmasterEvent[]; // Remove null events

    } catch (error) {
      logger.error('Error searching Ticketmaster events:', error);
      throw error;
    }
  }

  async getEventDetails(eventId: string): Promise<TicketmasterEvent | null> {
    try {
      const params = new URLSearchParams({
        apikey: this.apiKey,
        locale: '*' // Return all available languages
      });

      logger.info('Getting Ticketmaster event details:', { eventId });

      const response = await fetch(`${this.baseUrl}/events/${eventId}?${params.toString()}`);
      
      if (!response.ok) {
        if (response.status === 404) {
          logger.info('Event not found:', { eventId });
          return null;
        }
        const errorData = await response.json().catch(() => null);
        logger.error('Ticketmaster API error:', { 
          status: response.status, 
          statusText: response.statusText,
          error: errorData 
        });
        throw new Error(`Ticketmaster API error: ${response.statusText}`);
      }

      const event = await response.json();

      // Validate required fields
      if (!event.id || !event.name) {
        logger.info('Invalid event details:', event);
        return null;
      }

      const venue = event._embedded?.venues?.[0];
      if (!venue) {
        logger.info('Event has no venue data:', event.id);
        return null;
      }

      return {
        id: event.id,
        name: event.name,
        date: event.dates.start.dateTime || event.dates.start.localDate,
        venue: {
          id: venue.id || 'unknown',
          name: venue.name || 'Unknown Venue',
          city: venue.city?.name || 'Unknown City',
          state: venue.state?.stateCode || 'Unknown State',
          country: venue.country?.countryCode || 'Unknown Country'
        },
        url: event.url
      };

    } catch (error) {
      logger.error('Error getting Ticketmaster event details:', { eventId, error });
      throw error;
    }
  }
} 