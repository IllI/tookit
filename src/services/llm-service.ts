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
       - VividSeats: should contain '/tickets/' or similar ticket page pattern
    
    Return only valid JSON matching this structure: 
    {
      "events": [
        {
          "name": string,
          "date": string,
          "venue": string,
          "location": string,
          "price": string (optional),
          "eventUrl": string (must be the exact href value from the event's <a> tag)
        }
      ]
    }

    Important: Do not generate or guess URLs. Only include eventUrl if you find an actual <a> tag linking to the event's ticket page.`;

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
                   Looking for events matching: "${searchParams?.keyword || ''}" in "${searchParams?.location || ''}"
                   Source URL: ${url}
                   
                   Find the event container elements in this HTML content and extract the exact href values from their ticket page links.
                   Content: ${content}
                   
                   Remember:
                   1. Only include events that match the search criteria
                   2. Extract URLs exactly as they appear in href attributes
                   3. Do not generate or modify URLs
                   4. If you can't find a valid ticket page link, omit the eventUrl field
                   5. For StubHub: should contain '/event/' or '/tickets/'. For example: 'https://www.stubhub.com/my-chemical-romance-chicago-tickets-8-29-2025/event/156178199/?qid=4a0b3c8ceee8aa8a132222ff90ad22f6&iid=c0409a16-2b41-4124-a57b-33fe37b699be&index=stubhub_exact&ut=27162dca024b3a38a8f4598058923b241cd793ad'
                   6. For VividSeats: should contain '/tickets/' or similar ticket page pattern. For example: <a href="/my-chemical-romance-tickets-chicago-soldier-field-8-29-2025--concerts-rock/production/5354970" class="styles_linkContainer__4li3j" id="5354970" data-testid="production-listing-row-5354970"><div class="styles_row__Ma1rH"><div class="styles_rowContent__mKC9N"><div class="styles_leftColumn__uxaP4" data-testid="date-time-left-element"><span class="MuiTypography-root MuiTypography-overline mui-kh4685">Fri</span><span class="MuiTypography-root MuiTypography-small-bold MuiTypography-noWrap mui-1fmntk1">Aug 29</span><span class="MuiTypography-root MuiTypography-small-bold MuiTypography-noWrap mui-1fmntk1">2025</span><span class="MuiTypography-root MuiTypography-caption mui-1pgnteb">6:00pm</span></div><div></div><div class="styles_titleColumn__T_Kfd"><span class="MuiTypography-root MuiTypography-small-medium styles_titleTruncate__XiZ53 mui-pc7loe">My Chemical Romance</span><div class="MuiBox-root mui-k008qs" data-testid="subtitle"><span class="MuiTypography-root MuiTypography-small-regular styles_textTruncate__wsM3Q mui-1insuh9">Soldier Field</span><span class="MuiTypography-root MuiTypography-small-regular mui-1insuh9">&nbsp;•&nbsp;</span><span class="MuiTypography-root MuiTypography-small-regular styles_textTruncate__wsM3Q mui-1wl3fj7">Chicago, IL</span></div></div></div><button class="MuiButtonBase-root MuiButton-root MuiButton-outlined MuiButton-outlinedPrimary MuiButton-sizeSmall MuiButton-outlinedSizeSmall MuiButton-colorPrimary MuiButton-root MuiButton-outlined MuiButton-outlinedPrimary MuiButton-sizeSmall MuiButton-outlinedSizeSmall MuiButton-colorPrimary styles_findTicketsButton__LrJK_ mui-qgcajg" tabindex="0" type="button" data-testid="production-listing-row-button"><span class="MuiTypography-root MuiTypography-small-regular mui-1b4fqit">Find Tickets</span></button></div></a>
                   7. Ensure links contain the domain and full path of the url are not just relative links
                   8. Ensure that any trailing unnecessary query parameters in the url are removed
                   `
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