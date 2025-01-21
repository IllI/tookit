export interface Event {
  id?: string;
  name: string;
  date: string;
  venue: string;
  url?: string;
  source?: string;
  location?: {
    city: string;
    state: string;
    country: string;
  };
  tickets?: TicketData[];
}

export interface TicketData {
  section: string;
  row?: string;
  price: number | string;
  quantity: number | string;
  source: string;
  listing_id?: string;
  ticket_url?: string;
}

export interface EventData extends Event {
  tickets: TicketData[];
}

export interface TicketSource {
  events: EventData[];
  error?: string;
}

export interface SearchMetadata {
  sources: string[];
  error?: string;
  eventId?: string;
}

export interface EventSearchResult {
  name: string;
  date: string;
  venue: string;
  location?: {
    city: string;
    state: string;
    country: string;
  };
  source?: string;
  link?: string;
  description?: string;
  ticket_links: Array<{
    source: string;
    url: string;
    is_primary: boolean;
  }>;
  has_ticketmaster: boolean;
  url?: string;
}