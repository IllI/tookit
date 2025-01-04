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
  price: number;
  quantity: number;
  listing_id: string;
  source: string;
  event_id?: string;
  ticket_url?: string | null;
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
}