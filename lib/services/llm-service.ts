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

const TICKET_PROMPT = `Extract ticket listings from the HTML content. For VividSeats pages:

1. Look for ticket listings in the container with data-testid="listings-container"
2. Each listing should contain:
   - Section name (often prefixed with "Section" or near a section label)
   - Row information (if available, often prefixed with "Row" or near a row label)
   - Price (numeric value only, no currency symbols)
   - Quantity of tickets available
   - A unique listing ID (can be extracted from data attributes or generated)
   - The direct ticket URL from the listing's anchor tag href attribute

Return only valid JSON in this format:
{
  "tickets": [
    {
      "section": "string",
      "row": "string",
      "price": number,
      "quantity": number,
      "listing_id": "string",
      "ticket_url": "string"
    }
  ]
}

Important:
1. Remove any currency symbols from prices
2. Convert all prices to numbers
3. Ensure quantities are numbers
4. Include section names exactly as shown
5. Include row information if available
6. Look for data-testid attributes to identify ticket elements
7. Extract the full href URL from each ticket listing's anchor tag
8. For relative URLs (starting with '/'), prepend 'https://www.vividseats.com'`;

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