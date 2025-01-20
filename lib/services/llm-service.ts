import { config } from '@/src/config/env';

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

const TICKET_PROMPT = `Extract ticket listings from the HTML content. For VividSeats pages, look for anchor tags (<a>) that contain ticket listing information.

Each ticket listing should have:
- section: The section name/number (look for text containing "Section" or similar)
- row: The row name/number (look for text containing "Row" or similar)
- price: The ticket price (numeric value only, no currency symbols)
- quantity: Number of tickets available
- listing_id: Generate a unique ID for each listing

For VividSeats pages:
1. Each ticket listing is typically wrapped in an anchor tag
2. Look for price information near or within the anchor tag
3. Section and row information may be in the link text or nearby elements
4. The listing URL is in the href attribute

Return only valid JSON in this format:
{
  "tickets": [
    {
      "section": "string",
      "row": "string",
      "price": number,
      "quantity": number,
      "listing_id": "string"
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

  async parseTickets(html: string): Promise<ParsedTickets> {
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
              text: `${TICKET_PROMPT}\n\nHTML Content:\n${html}`
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
        console.log('Gemini response:', text);
          console.log('HTML:', html);
        return JSON.parse(jsonMatch[0]);
      } catch (parseError) {
        console.error('Error parsing Gemini response as JSON:', parseError);
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