import { HfInference } from '@huggingface/inference';
import type { Event } from '@/lib/types/api';

export class ParserService {
  private hf: HfInference;

  constructor() {
    this.hf = new HfInference(process.env.HUGGINGFACE_API_KEY);
  }

  async parseContent(html: string, url: string): Promise<Event> {
    try {
      console.log('Parsing content from:', url);

      // Using facebook/opt-iml-max-1.3b model for structured text extraction
      const response = await this.hf.textGeneration({
        model: 'facebook/opt-iml-max-1.3b',
        inputs: `Extract event information from this HTML content and return it in JSON format. Look for event name, date, venue, and price information.

URL: ${url}
HTML: ${html}

Return only a JSON object with this structure:
{
  "name": "event name",
  "date": "event date",
  "venue": "venue name",
  "price": "lowest price if available"
}`,
        parameters: {
          max_new_tokens: 200,
          temperature: 0.3,
          top_p: 0.95,
          return_full_text: false
        }
      });

      const parsedResponse = JSON.parse(response.generated_text);
      console.log('Parsed response:', parsedResponse);

      return {
        name: parsedResponse.name,
        date: new Date(parsedResponse.date).toISOString(),
        venue: parsedResponse.venue,
        price: parsedResponse.price,
        category: 'Concert'
      };
    } catch (error) {
      console.error('Error parsing content:', error);
      throw new Error(`Failed to parse content: ${error.message}`);
    }
  }
}

export const parserService = new ParserService();