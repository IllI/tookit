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
  private SYSTEM_PROMPT = `Extract event information from webpage content. 
    For each event, find and include the URL that links directly to the event's ticket page.
    Return only valid JSON matching this structure: 
    {
      "events": [
        {
          "name": string,
          "date": string,
          "venue": string,
          "location": string,
          "price": string (optional),
          "eventUrl": string (the full URL to the event's ticket page)
        }
      ]
    }`;

  private claude: Anthropic;

  constructor() {
    this.claude = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY
    });
  }

  async parseContent(content: string, url: string, searchParams?: { keyword: string, location: string }): Promise<ParsedEvents> {
    try {
      console.log('Sending content to Claude...');
      const completion = await this.claude.messages.create({
        model: 'claude-3-sonnet-20240229',
        max_tokens: 4096,
        system: this.SYSTEM_PROMPT,
        messages: [{
          role: "user",
          content: `Parse these events and return ONLY valid JSON.
                   Search for events matching: "${searchParams?.keyword || ''}" in "${searchParams?.location || ''}"
                   Look for links containing these terms.
                   URL: ${url}
                   Content: ${content}
                   
                   Important: For each event, find and include the URL that links directly to the event's ticket page.
                   The eventUrl should be a complete URL starting with http:// or https://`
        }]
      });

      console.log('Claude response:', completion.content[0].text);
      const parsedResponse = JSON.parse(completion.content[0].text);
      return { events: parsedResponse.events || [] };
    } catch (error) {
      console.error('Claude parsing error:', error);
      return { events: [] };
    }
  }
}

export function getParser(type = 'claude'): ClaudeParser {
  return new ClaudeParser();
} 