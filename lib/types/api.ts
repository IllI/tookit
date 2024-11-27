export interface SearchParams {
  keyword: string;
  location?: string;
  source?: 'all' | 'stubhub' | 'vividseats';
}

export interface TicketSource {
  isLive: boolean;
  lastUpdated?: string;
  error?: string;
}

export interface SearchResult {
  success: boolean;
  data?: any[];
  error?: string;
  metadata: {
    stubhub?: TicketSource;
    vividseats?: TicketSource;
    error?: string;
  };
}

export interface Section {
  section: string;
  tickets: Ticket[];
  category: string;
}

export interface Ticket {
  quantity: string;
  price: string;
  rawPrice: number;
  listingId: string;
  listingUrl: string;
}

export interface Event {
  id?: number;
  name: string;
  date: string;
  venue: string;
  location: string;
  category: string;
  tickets?: Section[];
} 