import { config } from '@/src/config/env';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';

interface ParsedEvent {
  name: string;
  date: string;
  venue: string;
  location?: string;
  price?: string;
  eventUrl?: string;
}

interface ParsedTicket {
  section: string;
  row: string;
  price: number;
  quantity: number;
  listing_id?: string;
  ticket_url?: string;
}

interface ParsedEvents {
  events: ParsedEvent[];
}

interface ParsedTickets {
  tickets: ParsedTicket[];
}

const EVENT_PROMPT = `Extract event information from the HTML content. Return a JSON object with an array of events, each containing:
- name: The event name
- date: The event date and time
- venue: The venue name
- location: The city and state
- price: The ticket price range (if available)
- eventUrl: The URL to buy tickets (if available)

Return only valid JSON in this format:
{
  "events": [
    {
      "name": "string",
      "date": "string",
      "venue": "string",
      "location": "string",
      "price": "string",
      "eventUrl": "string"
    }
  ]
}`;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

const TICKET_PROMPT = `Extract ticket listings from the HTML content. For VividSeats pages:

If isPriceRange is true:
1. Look for the knowledge graph script tag with type "application/ld+json"
2. Find the "offers" object in the event data
3. Extract the lowest price from the offers
4. Return a single ticket with:
   - price: The lowest price found
   - quantity: 1
   - section: "Best Available"
   - row: ""
   - listing_id: ""

Otherwise:
Extract individual ticket listings with:
- section: The section of the ticket
- row: The row of the ticket (if available)
- price: The price of the ticket (numerical value)
- quantity: Number of tickets available
- listing_id: Unique identifier for the listing (if available)

Return the data in this format:
{
  "tickets": [
    {
      "section": string,
      "row": string,
      "price": number,
      "quantity": number,
      "listing_id": string
    }
  ]
}`;

class GeminiParser {
  private apiKey: string;

  constructor() {
    this.apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY || '';
    if (!this.apiKey) {
      console.warn('Gemini API key not found in environment variables');
    }
  }

  async parseEvents(html: string): Promise<ParsedEvents> {
    try {
      if (!this.apiKey) {
        throw new Error('Gemini API key not found in environment variables');
      }

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${this.apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `${EVENT_PROMPT}\n\nHTML Content:\n${html}`
            }]
          }]
        })
      });

      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const text = data.candidates[0].content.parts[0].text;
      
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          console.warn('No JSON found in Gemini response');
          return { events: [] };
        }
        return JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        console.error('Error parsing Gemini response as JSON:', parseError);
        return { events: [] };
      }
    } catch (error) {
      console.error('Gemini parsing error:', error);
      return { events: [] };
    }
  }

  async parseTickets(html: string, isPriceRange: boolean = false): Promise<ParsedTickets> {
    try {
      if (!this.apiKey) {
        throw new Error('Gemini API key not found in environment variables');
      }

      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${this.apiKey}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{
            parts: [{
              text: `${TICKET_PROMPT}\n\nHTML Content:\n${html}\n\nisPriceRange: ${isPriceRange}`
            }]
          }]
        })
      });

      if (!response.ok) {
        throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      const text = data.candidates[0].content.parts[0].text;
      
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          console.warn('No JSON found in Gemini response');
          return { tickets: [] };
        }
        return JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        console.error('Error parsing Gemini response as JSON:', parseError);
        console.log('Raw response:', text);
        return { tickets: [] };
      }
    } catch (error) {
      console.error('Gemini parsing error:', error);
      return { tickets: [] };
    }
  }
}

export function getParser(type: 'gemini'): GeminiParser {
  return new GeminiParser();
} 