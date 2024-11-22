export type SearchParams = {
  keyword?: string;
  artist?: string;
  venue?: string;
  location?: string;
  date?: string;
  source?: 'stubhub' | 'vividseats' | 'all';
};

export type Event = {
  id: string;
  name: string;
  date: string;
  venue: string;
  type?: string;
  category?: string;
  links?: EventLink[];
  tickets?: Ticket[];
};

export type EventLink = {
  id: string;
  eventId: string;
  source: string;
  url: string;
};

export type Ticket = {
  id: string;
  eventId: string;
  price: number;
  section: string;
  row?: string;
  quantity: number;
  source: string;
  url: string;
  listingUrl?: string;
  listingId?: string;
  rawPrice: number;
  dealScore?: string;
  rawData?: any;
};

export type TicketSource = {
  lastUpdated: string;
  isLive: boolean;
  error?: string;
};

export type SearchResult = {
  success: boolean;
  data?: Event[];
  error?: string;
  metadata: {
    total?: number;
    sources?: {
      stubhub: TicketSource;
      vividseats: TicketSource;
    };
    error?: string;
  };
}; 