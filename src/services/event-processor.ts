import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { Browser, Page } from 'puppeteer-core';
import { getParser } from './llm-service';

interface RawEvent {
  name: string;
  date: string;
  venue: string;
  location: string;
  price?: string;
  source: 'stubhub' | 'vividseats';
  link?: string;
}

interface TicketData {
  section: string;
  row?: string;
  price: number;
  quantity: number;
  listing_id?: string;
}

export class EventProcessor {
  private supabase: SupabaseClient;
  private parser;
  private activeBrowsers: Set<Browser>;

  constructor() {
    this.supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );
    this.parser = getParser();
    this.activeBrowsers = new Set();
  }

  private async cleanup() {
    console.log(`Cleaning up ${this.activeBrowsers.size} browsers...`);
    const browsers = Array.from(this.activeBrowsers);
    for (const browser of browsers) {
      try {
        await browser.close();
        this.activeBrowsers.delete(browser);
        console.log('Browser closed successfully');
      } catch (error) {
        console.error('Error closing browser:', error);
      }
    }
  }

  private filterEvents(events: RawEvent[]): RawEvent[] {
    return events.filter(event => {
      if (!event?.name) return false;
      const name = event.name.toLowerCase();
      return !name.includes('parking') && 
             !name.includes('vip package') && 
             !name.includes('meet and greet');
    });
  }

  private deduplicateEvents(events: RawEvent[]): RawEvent[] {
    const uniqueEvents = new Map<string, RawEvent>();
    events.forEach(event => {
      const date = this.normalizeDate(event.date);
      if (!date) return;
      const key = `${event.name.toLowerCase()}-${date.toISOString()}`;
      if (!uniqueEvents.has(key)) {
        uniqueEvents.set(key, event);
      }
    });
    return Array.from(uniqueEvents.values());
  }

  private normalizeDate(dateStr: string): Date | null {
    try {
      const cleanDate = dateStr.replace(/^(MON|TUE|WED|THU|FRI|SAT|SUN)\s+/i, '');
      const parsed = new Date(cleanDate);
      return parsed.toString() !== 'Invalid Date' ? parsed : null;
    } catch (e) {
      console.error('Date parsing error:', e);
      return null;
    }
  }

  async processEvents(rawEvents: RawEvent[]) {
    try {
      const filteredEvents = this.filterEvents(rawEvents);
      const uniqueEvents = this.deduplicateEvents(filteredEvents);
      
      for (const event of uniqueEvents) {
        const date = this.normalizeDate(event.date);
        if (!date) continue;

        // Check for existing event
        const { data: existingEvent } = await this.supabase
          .from('events')
          .select('id, name')
          .eq('name', event.name)
          .eq('date', date.toISOString())
          .eq('venue', event.venue)
          .single();

        let eventId: string;

        if (existingEvent) {
          eventId = existingEvent.id;
          console.log('Found existing event:', existingEvent.name);
        } else {
          const { data: newEvent, error: eventError } = await this.supabase
            .from('events')
            .insert([{
              name: event.name,
              date,
              venue: event.venue,
              category: 'Concert'
            }])
            .select()
            .single();

          if (eventError || !newEvent) {
            console.error('Failed to create event:', eventError);
            continue;
          }

          eventId = newEvent.id;
          console.log('Created new event:', newEvent.name);
        }

        if (event.link) {
          const { error: linkError } = await this.supabase
            .from('event_links')
            .upsert({
              event_id: eventId,
              source: event.source,
              url: event.link
            }, {
              onConflict: 'event_id,source'
            });

          if (!linkError) {
            console.log(`Added ${event.source} link for event`);
            await this.scrapeTickets(eventId, event.source, event.link);
          }
        }
      }
    } catch (error) {
      console.error('Failed to process events:', error);
    } finally {
      await this.cleanup();
    }
  }

  async scrapeTickets(eventId: string, source: string, eventUrl: string) {
    const xcrawl = await import('x-crawl');
    const crawler = xcrawl.default({
      maxRetry: 3,
      intervalTime: { max: 8000, min: 3000 },
      stealth: true,
      headless: false,
      launchOptions: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--window-size=1920,1080',
          '--disable-blink-features=AutomationControlled'
        ]
      }
    });

    try {
      console.log(`Scraping tickets from ${eventUrl}`);
      
      await crawler.crawlPage({
        url: eventUrl,
        beforeRequest: async ({ page }: { page: Page }) => {
          await page.waitForTimeout(5000);

          const ticketData = await page.evaluate((src: string) => {
            const selector = src === 'stubhub' 
              ? '.TicketList-row'
              : '.ticket-list-item';

            return Array.from(document.querySelectorAll(selector)).map(el => ({
              section: el.querySelector('.section')?.textContent?.trim() || 'General',
              row: el.querySelector('.row')?.textContent?.trim(),
              price: parseFloat(el.querySelector('.price')?.textContent?.replace(/[^0-9.]/g, '') || '0'),
              quantity: parseInt(el.querySelector('.quantity')?.textContent?.trim() || '1'),
              listing_id: `${src}-${Date.now()}-${Math.random()}`
            }));
          }, source);

          if (ticketData.length > 0) {
            await this.supabase
              .from('tickets')
              .upsert(
                ticketData.map(ticket => ({
                  ...ticket,
                  event_id: eventId,
                  source,
                  date_posted: new Date().toISOString(),
                  sold: false
                }))
              );
            console.log(`Saved ${ticketData.length} tickets`);
          }
        }
      });
    } catch (error) {
      console.error('Error scraping tickets:', error);
    }
  }
}

export const eventProcessor = new EventProcessor(); 