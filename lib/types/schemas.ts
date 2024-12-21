export interface Event {
  id?: string;
  name: string;
  date: string; // ISO 8601 format
  venue: string;
  location?: {
    city: string;
    state?: string;
    country: string;
  };
  source: 'stubhub' | 'vividseats' | 'ticketmaster' | 'axs';
  category: 'Concert' | 'Sports' | 'Theater' | 'Other';
  url?: string;
  created_at?: string;
  updated_at?: string;
}

export interface Price {
  amount: number;
  currency: string;
  formattedAmount: string;
}

export interface TicketListing {
  id?: string;
  event_id: string;
  section: string;
  row?: string;
  price: Price;
  quantity: number;
  source: Event['source'];
  url?: string;
  date_posted: string; // ISO 8601 format
  raw_data?: Record<string, any>;
}

export interface EventWithTickets extends Event {
  tickets: TicketListing[];
}

export interface ScrapedContent {
  name: string;
  date: string;
  venue: string;
  city?: string;
  state?: string;
  country?: string;
  price?: {
    amount: number;
    currency: string;
  };
  url?: string;
}