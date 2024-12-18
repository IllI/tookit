export interface Event {
  id?: string;
  name: string;
  date: string;
  venue: string;
  city: string;
  state?: string;
  location: string;
  country: string;
  source?: string;
  source_url?: string;
  eventUrl?: string;
}