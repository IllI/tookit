import { HfInference } from '@huggingface/inference';
import type { Event, ScrapedContent } from '@/lib/types/schemas';
import { cacheService } from './cache-service';

export class ParserService {
  private hf: HfInference;

  constructor() {
    this.hf = new HfInference(process.env.HUGGINGFACE_API_KEY);
  }

  private formatPrompt(html: string, url: string): string {
    return `Extract event information from this HTML content and return it in JSON format.
Look for specific details about the event, including name, date, venue, and price information.

URL: ${url}
HTML: ${html}

Return ONLY a JSON object with this exact structure:
{
  "name": "full event name",
  "date": "date in ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)",
  "venue": "full venue name",
  "city": "city name",
  "state": "state abbreviation",
  "country": "country name",
  "price": {
    "amount": number,
    "currency": "USD"
  }
}`;
  }

  private validateDate(dateStr: string): string {
    try {
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        throw new Error('Invalid date');
      }
      return date.toISOString();
    } catch {
      // If date parsing fails, return current date
      return new Date().toISOString();
    }
  }

  private determineSource(url: string): Event['source'] {
    if (url.includes('stubhub.com')) return 'stubhub';
    if (url.includes('vividseats.com')) return 'vividseats';
    if (url.includes('ticketmaster.com')) return 'ticketmaster';
    if (url.includes('axs.com')) return 'axs';
    return 'stubhub'; // default fallback
  }

  async parseContent(html: string, url: string): Promise<Event> {
    try {
      // Check cache first
      const cached = await cacheService.get(url, html);
      if (cached) {
        console.log('Returning cached parse result for:', url);
        return this.transformToEvent(cached, url);
      }

      console.log('Parsing content from:', url);

      const response = await this.hf.textGeneration({
        model: 'facebook/opt-iml-max-1.3b',
        inputs: this.formatPrompt(html, url),
        parameters: {
          max_new_tokens: 250,
          temperature: 0.3,
          top_p: 0.95,
          return_full_text: false
        }
      });

      const parsedContent: ScrapedContent = JSON.parse(response.generated_text);
      console.log('Parsed response:', parsedContent);

      // Cache the result
      await cacheService.set(url, html, parsedContent);

      return this.transformToEvent(parsedContent, url);

    } catch (error) {
      console.error('Error parsing content:', error);
      throw new Error(`Failed to parse content: ${error.message}`);
    }
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
      source: this.determineSource(url),
      category: 'Concert',
      url,
      created_at: new Date().toISOString()
    };
  }
}

export const parserService = new ParserService();