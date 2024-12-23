import { HfInference } from '@huggingface/inference';
import type { Event, ScrapedContent } from '@/lib/types/schemas';
import { cacheService } from './cache-service';
import * as cheerio from 'cheerio';

const SEARCH_PAGE_PROMPTS = {
  stubhub: `
Find event information from the StubHub search results HTML.
Look for elements with data-testid="primaryGrid" to find event listings.

Required fields to extract:
1. name: The exact artist/performer name from the listing
2. venue: The physical venue name where the event takes place (NOT "StubHub", "See Tickets", or any ticket seller name)
3. date: Event date in ISO format
4. location: City and state where the venue is located

Return this JSON structure with ONLY values found in the HTML:
{
  "events": [{
    "name": "",
    "venue": "",
    "date": "",
    "location": {
      "city": "",
      "state": ""
    },
    "source": "stubhub"
  }]
}

Important:
- Extract the EXACT venue name where the event is taking place
- Do not use "StubHub", "See Tickets", or any ticket seller as the venue
- Look for venue information near the event details
- Only use values found in the HTML
`,

  vividseats: `
Extract exactly these fields from the VividSeats search results HTML:
1. name: The artist/performer name only
2. venue: The physical venue name
3. date: Event date in ISO format
4. location: City and state

Return ONLY this JSON structure with actual values from the HTML:
{
  "events": [{
    "name": "artist/performer name",
    "venue": "physical venue name",
    "date": "ISO date",
    "location": {
      "city": "city name",
      "state": "state code"
    },
    "source": "vividseats"
  }]
}

DO NOT add any descriptive text or additional fields.
DO NOT use example values - extract only from the HTML.
`
};

export function getSearchPagePrompt(source: 'stubhub' | 'vividseats') {
  return SEARCH_PAGE_PROMPTS[source];
}

export class ParserService {
  private hf: HfInference;

  constructor() {
    if (!process.env.HF_TOKEN) {
      throw new Error('HF_TOKEN environment variable is required');
    }
    this.hf = new HfInference(process.env.HF_TOKEN);
  }

  private formatPrompt(html: string, url: string, searchParams: { keyword: string; location?: string }): string {
    const source = url.includes('vividseats') ? 'vividseats' : 'stubhub';
    
    return `Find the event data in the following html for "${searchParams.keyword}" in "${searchParams.location || 'any'}".
Return this JSON structure with ONLY values found in the HTML:
{
  "events": [
    {
      "name": "exact event name",
      "venue": "exact venue name",
      "date": "exact date",
      "location": {
        "city": "exact city",
        "state": "exact state"
      },
      "source": "${source}"
    }
  ]
}

Here is the HTML content:
${html}

Return ONLY the JSON object, formatted exactly as shown above.`;
  }

  private extractSection(html: string, selector: string): string {
    // Simple HTML section extraction - you might want to use a proper HTML parser
    const sectionMatch = new RegExp(`<[^>]*${selector}[^>]*>([\\s\\S]*?)<\\/`, 'i').exec(html);
    return sectionMatch ? sectionMatch[1] : '';
  }

  async parseContent(
    html: string, 
    url: string, 
    searchParams: { keyword: string; location?: string },
    eventLinks: Array<{ url: string; html: string }> = []
  ): Promise<{ events: Event[] }> {
    try {
      const cached = await cacheService.get(url, html);
      if (cached) return { events: [this.transformToEvent(cached, url)] };

      const source = url.includes('vividseats') ? 'vividseats' : 'stubhub';
      
      console.log('[Parser] Sending request to model...');
      
      const response = await this.hf.textGeneration({
        model: 'mistralai/Mixtral-8x7B-Instruct-v0.1',
        inputs: `Extract event information from this HTML content.
The event we're looking for is "${searchParams.keyword}" in "${searchParams.location || 'any'}".

Output a JSON object in this exact format:
{
  "events": [
    {
      "name": "event name",
      "venue": "venue name",
      "date": "event date",
      "location": {
        "city": "city name",
        "state": "state code"
      },
      "source": "${source}",
      "url": "event page url"
    }
  ]
}

HTML:
${html}

Important: Return only the JSON object, no other text.`,
        parameters: {
          max_new_tokens: 1000,
          temperature: 0.1,
          return_full_text: false,
          stop: ["}]}", "HTML:"]
        }
      });

      console.log('[Parser] Model response:', response.generated_text);

      // Look for JSON object in response
      const jsonMatch = response.generated_text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        console.error('[Parser] No JSON found in response:', response.generated_text);
        return { events: [] };
      }

      let jsonStr = jsonMatch[0]
        .replace(/\}\}+\]\}+$/, '}]}')  // Fix multiple closing braces
        .replace(/,\s*[\}\]]/g, '$1')   // Remove trailing commas
        .replace(/,\s*USA/, '')         // Remove USA from state
        .trim();

      console.log('[Parser] Cleaned JSON:', jsonStr);

      try {
        const parsedJson = JSON.parse(jsonStr);
        
        // Use the URLs from the model's response
        const events = await Promise.all(
          (parsedJson.events || [])
            .filter(event => event && event.name && event.venue)
            .map(async (event: any) => {
              const parsedContent: ScrapedContent = {
                name: event.name?.trim() || '',
                date: event.date?.trim() || new Date().toISOString(),
                venue: event.venue?.trim() || '',
                city: event.location?.city?.trim() || '',
                state: event.location?.state?.trim() || '',
                country: 'USA',
                url: event.url || '',  // Use the URL from the model's response
                price: {
                  amount: 0,
                  currency: 'USD'
                }
              };

              if (this.validateContent(parsedContent)) {
                await cacheService.set(url, html, parsedContent);
                // Use the event URL from the model's response
                return this.transformToEvent(parsedContent, event.url);
              }
              return null;
            })
        );

        return { events: events.filter((e): e is Event => e !== null) };

      } catch (parseError) {
        console.error('JSON parse error:', parseError);
        return { events: [] };
      }

    } catch (error) {
      console.error('Parser error:', error);
      throw error;
    }
  }

  private validateContent(content: Partial<ScrapedContent>): boolean {
    return !!(
      content.name?.length > 0 &&
      content.date &&
      content.venue?.length > 0 &&
      content.city?.length > 0 &&
      content.state?.length === 2
    );
  }

  private parseDate(dateStr: string): string {
    try {
      const cleanDate = dateStr
        .replace(/\s+/g, ' ')
        .replace(/PM|AM/i, match => ` ${match}`);
      
      const date = new Date(cleanDate);
      if (!isNaN(date.getTime())) {
        return date.toISOString();
      }

      const parts = cleanDate.match(/(\w+)\s+(\d+)\s+(\d{4})\s+(\d+):(\d+)\s*(PM|AM)/i);
      if (parts) {
        const [_, month, day, year, hours, minutes, ampm] = parts;
        let hour = parseInt(hours);
        if (ampm.toLowerCase() === 'pm' && hour < 12) hour += 12;
        if (ampm.toLowerCase() === 'am' && hour === 12) hour = 0;
        
        const date = new Date(
          parseInt(year),
          this.getMonthNumber(month),
          parseInt(day),
          hour,
          parseInt(minutes)
        );
        return date.toISOString();
      }

      throw new Error('Invalid date format');
    } catch (error) {
      console.warn('Date parsing failed:', error);
      return new Date().toISOString();
    }
  }

  private getMonthNumber(month: string): number {
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
    };
    return months[month.toLowerCase().substring(0, 3)] || 0;
  }

  private parseLocation(location: string = ''): [string, string] {
    const parts = location.split(',').map(p => p.trim());
    return [parts[0] || 'Unknown', parts[1]?.substring(0, 2) || 'XX'];
  }

  private transformToEvent(content: ScrapedContent, url: string): Event {
    return {
      name: content.name,
      date: this.validateDate(content.date),
      venue: content.venue,
      location: {
        city: content.city || 'Unknown',
        state: content.state,
        country: content.country || 'USA'
      },
      price: {
        amount: typeof content.price?.amount === 'number' ? content.price.amount : 0,
        currency: content.price?.currency || 'USD'
      },
      source: this.determineSource(url),
      category: 'Concert',
      url,
      created_at: new Date().toISOString()
    };
  }

  private validateDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        throw new Error('Invalid date');
      }
      return date.toISOString();
    } catch {
      return new Date().toISOString();
    }
  }

  private determineSource(url: string): Event['source'] {
    if (url.includes('stubhub.com')) return 'stubhub';
    if (url.includes('vividseats.com')) return 'vividseats';
    return 'stubhub'; // default fallback
  }

  async parseTickets(html: string, url: string): Promise<{ tickets: any[] }> {
    const prompt = `[SYSTEM]
You are a JSON generator that extracts ticket information from HTML. You only output valid JSON objects.

[USER]
Extract ticket listings from this ${url.includes('vividseats') ? 'VividSeats' : 'StubHub'} event page HTML.
Return ONLY a JSON object with these exact fields for each ticket:
- section (string)
- row (string)
- price (number)
- quantity (number)
- listing_id (string)

Format exactly like this, with actual values from the HTML:
{
  "tickets": [
    {
      "section": "GA",
      "row": "GA",
      "price": 50,
      "quantity": 2,
      "listing_id": "12345"
    }
  ]
}

HTML:
${html}

[ASSISTANT]
{`;

    try {
      const response = await this.hf.textGeneration({
        model: 'mistralai/Mixtral-8x7B-Instruct-v0.1',
        inputs: prompt,
        parameters: {
          max_new_tokens: 500,
          temperature: 0.1,
          stop: ["}"],
          return_full_text: false
        }
      });

      // Clean and parse the response
      const cleanedResponse = response.generated_text
        .replace(/<[^>]*>/g, '')  // Remove HTML tags
        .replace(/[^{}\[\]"',\d\w\s.:_-]/g, '')  // Keep only valid JSON chars
        .replace(/^[^{]*({.*})[^}]*$/, '$1')  // Extract main JSON object
        .trim();

      const jsonStr = '{' + cleanedResponse.replace(/\}\}+$/, '}');
      console.log('Cleaned ticket JSON:', jsonStr);

      try {
        const parsedJson = JSON.parse(jsonStr);
        if (!Array.isArray(parsedJson.tickets)) {
          console.warn('No valid tickets array found');
          return { tickets: [] };
        }
        return parsedJson;
      } catch (parseError) {
        console.error('Ticket JSON parse error:', parseError);
        return { tickets: [] };
      }

    } catch (error) {
      console.error('Error parsing tickets:', error);
      return { tickets: [] };
    }
  }
}

export const parserService = new ParserService();