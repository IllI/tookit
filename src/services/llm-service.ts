import Anthropic from '@anthropic-ai/sdk';

interface EventData {
  name: string;
  date: string;
  venue: string;
  location: string;
  price?: string;
  eventUrl?: string;
}

interface ParsedEvents {
  events: EventData[];
}

class ClaudeParser {
  private SYSTEM_PROMPT = `You are a DOM parser specialized in extracting event information and URLs from ticket website search results.
    For each event found in the content:
    1. Locate the container element that holds the event information
    2. Within that container, find the <a> tag that links to the event's ticket page
    3. Extract the href attribute value from that <a> tag
    4. Verify the URL matches the expected pattern for the source site:
       - StubHub: should contain '/event/' or '/tickets/'. 
         Example: 'https://www.stubhub.com/my-chemical-romance-chicago-tickets-8-29-2025/event/156178199/'
       - VividSeats: should contain '/tickets/' or similar ticket page pattern.
         Example: 'https://www.vividseats.com/my-chemical-romance-tickets-chicago-soldier-field-8-29-2025--concerts-rock/production/5354970'
    
    Return only valid JSON matching this structure: 
    {
      "events": [
        {
          "name": string,
          "date": string,
          "venue": string,
          "location": string,
          "price": string (optional),
          "eventUrl": string (must be the exact href value from the event's <a> tag, including domain)
        }
      ]
    }

    Important: 
    1. Do not generate or guess URLs. Only include eventUrl if you find an actual <a> tag linking to the event's ticket page
    2. For relative URLs (starting with '/'), prepend the appropriate domain:
       - StubHub: 'https://www.stubhub.com'
       - VividSeats: 'https://www.vividseats.com'
    3. Remove any unnecessary query parameters from URLs (like qid, iid, etc.)
    4. Verify that extracted URLs contain the full domain and path`;

  private TICKET_PROMPT = `Extract ticket listing information from the event page content.
    Return only valid JSON matching this structure:
    {
      "tickets": [
        {
          "section": string,
          "row": string (optional),
          "price": number (no currency symbols, just the number),
          "quantity": number,
          "listing_id": string (optional)
        }
      ]
    }

    Important:
    1. Remove any currency symbols from prices
    2. Convert all prices to numbers
    3. Ensure quantities are numbers
    4. Include section names exactly as shown
    5. Include row information if available`;

  private claude: Anthropic;

  constructor() {
    this.claude = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  async parseContent(
    content: string, 
    url: string, 
    searchParams?: { keyword: string, location: string },
    isEventPage?: boolean
  ): Promise<ParsedEvents> {
    const prompt = isEventPage ? this.TICKET_PROMPT : this.SYSTEM_PROMPT;

    try {
      console.log(`Sending content to Claude for ${isEventPage ? 'ticket' : 'event'} parsing...`);
      const completion = await this.claude.messages.create({
        model: 'claude-3-sonnet-20240229',
        max_tokens: 4096,
        system: prompt + "\nIMPORTANT: Return ONLY the raw JSON object. No explanatory text, no markdown formatting, no notes.",
        messages: [{
          role: "user",
          content: `Parse this ${isEventPage ? 'ticket page' : 'search page'} and return ONLY a raw JSON object.
                   ${!isEventPage ? `Looking for events matching: "${searchParams?.keyword || ''}" in "${searchParams?.location || ''}"` : ''}
                   Source URL: ${url}
                   Content: ${content}
                   
                   IMPORTANT: Return ONLY the JSON object. No explanations, no notes, no markdown.`
        }]
      });

      const responseText = completion.content[0].text;
      
      // Try to find JSON object in response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON object found in response');
      }

      const cleanJson = jsonMatch[0].trim();
      console.log('Cleaned Claude response:', cleanJson);
      
      const parsedResponse = JSON.parse(cleanJson);
      return isEventPage ? { events: [], ...parsedResponse } : { events: parsedResponse.events || [] };
    } catch (error) {
      console.error('Claude parsing error:', error);
      return { events: [] };
    }
  }
}

export function getParser(type = 'claude'): ClaudeParser {
  return new ClaudeParser();
} 