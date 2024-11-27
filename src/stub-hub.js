import { createClient } from '@supabase/supabase-js';
import { config } from '@/src/config/env';
import { setupBrowser, setupPage } from './utils.js';
import { parse } from 'date-fns';

const supabaseClient = createClient(
  config.supabase.url,
  config.supabase.serviceKey
);

class StubHubSearcher {
  constructor() {
    this.baseUrl = 'https://www.stubhub.com/secure/search';
  }

  generateSearchUrl(artist, venue, location) {
    const searchParams = new URLSearchParams();
    const searchTerms = [artist, venue, location].filter(Boolean);
    searchParams.append('q', searchTerms.join(' '));
    return `${this.baseUrl}?${searchParams.toString()}`;
  }

  async setupBrowser() {
    return await setupBrowser();
  }

  async setupPage(browser) {
    return await setupPage(browser);
  }

  async extractEventDetails(page) {
    console.log('Starting event extraction in Node');
    
    const results = await page.evaluate(() => {
      const results = { logs: [], events: [] };
      
      const eventContainer = document.querySelector('[data-testid="primaryGrid"]');
      results.logs.push(`Found container: ${!!eventContainer}`);
      
      if (!eventContainer) {
        results.logs.push('No event container found');
        return results;
      }

      // Get all event items (excluding the sort header)
      const listItems = Array.from(eventContainer.querySelectorAll('li.sc-1mafo1b-9'));
      results.logs.push(`Processing ${listItems.length} event items`);

      listItems.forEach((item, index) => {
        try {
          const link = item.querySelector('a');
          
          // Date parsing
          const dateElement = item.querySelector('time');
          const dateText = dateElement?.querySelector('.sc-ja5jff-4')?.textContent; // "Aug 29 2025"
          const timeElement = dateElement?.querySelector('.sc-ja5jff-9:last-child')?.textContent; // "6:00 PM"
          const dateStr = dateText && timeElement ? `${dateText} ${timeElement}` : null;

          // Title
          const titleElement = item.querySelector('.sc-t60ws5-0');
          const title = titleElement?.textContent?.trim();

          // Venue
          const venueElement = item.querySelector('.sc-1pilhev-2 .sc-t60ws5-0');
          const venue = venueElement?.textContent?.trim();

          // Location
          const locationElement = item.querySelector('.sc-1pilhev-8 .sc-t60ws5-0');
          const location = locationElement?.textContent?.trim();

          if (title && dateStr && venue && location && link?.href) {
            results.events.push({
              name: title,
              date: dateStr,
              venue,
              location,
              category: 'Concert',
              link: link.href,
              source: 'stubhub'
            });
            
            results.logs.push(`Successfully parsed event: ${title} on ${dateStr}`);
            results.logs.push(`Venue: ${venue}, Location: ${location}`);
          } else {
            results.logs.push(`Missing required data for event ${index + 1}`);
            results.logs.push(`Title: ${title}`);
            results.logs.push(`Date: ${dateStr}`);
            results.logs.push(`Venue: ${venue}`);
            results.logs.push(`Location: ${location}`);
            results.logs.push(`Has link: ${!!link?.href}`);
          }
        } catch (err) {
          results.logs.push(`Error processing item ${index + 1}: ${err.message}`);
        }
      });

      return results;
    });

    console.log('Extraction logs:');
    results.logs.forEach(log => console.log(log));
    return results.events;
  }

  async getTicketPrices(eventUrl, existingPage = null) {
    let browser = null;
    let page = existingPage;
    
    try {
      if (!existingPage) {
        browser = await this.setupBrowser();
        page = await this.setupPage(browser);
      }

      // Add bot detection evasion
      await page.evaluateOnNewDocument(() => {
        // Override navigator properties
        Object.defineProperties(navigator, {
          webdriver: { get: () => undefined },
          languages: { get: () => ['en-US', 'en'] },
          plugins: {
            get: () => [
              {
                name: 'Chrome PDF Plugin',
                filename: 'internal-pdf-viewer',
                description: 'Portable Document Format',
                length: 1
              }
            ]
          },
          vendor: { get: () => 'Google Inc.' },
          platform: { get: () => 'Win32' }
        });

        // Add chrome properties
        window.chrome = {
          app: {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' }
          },
          runtime: {
            PlatformOs: { MAC: 'mac', WIN: 'win', ANDROID: 'android', CROS: 'cros', LINUX: 'linux', OPENBSD: 'openbsd' },
            PlatformArch: { ARM: 'arm', X86_32: 'x86-32', X86_64: 'x86-64' }
          }
        };

        // Add WebGL
        const getParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
          if (parameter === 37445) return 'Intel Inc.';
          if (parameter === 37446) return 'Intel Iris OpenGL Engine';
          return getParameter.apply(this, [parameter]);
        };
      });

      // Set realistic headers
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-platform': '"Windows"',
        'Upgrade-Insecure-Requests': '1'
      });

      // Random delay before navigation
      await page.waitForTimeout(2000 + Math.random() * 2000);

      console.log('Navigating to event page:', eventUrl);
      
      // Navigate with stealth mode
      await Promise.race([
        page.goto(eventUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 20000
        }),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Initial navigation timeout')), 20000)
        )
      ]);

      // Add random mouse movements and scrolling
      await page.evaluate(() => {
        const randomScroll = () => {
          window.scrollBy(0, Math.floor(Math.random() * 100));
        };
        
        for (let i = 0; i < 5; i++) {
          setTimeout(randomScroll, Math.random() * 1000);
        }
      });

      // Wait for listings with multiple attempts
      let listingsFound = false;
      for (let attempt = 1; attempt <= 3 && !listingsFound; attempt++) {
        try {
          await page.waitForSelector('#listings-container', { timeout: 8000 });
          listingsFound = true;
          console.log('Listings container found');
        } catch (err) {
          console.log(`Attempt ${attempt}: Listings not found, reloading...`);
          await page.reload({ 
            waitUntil: 'domcontentloaded',
            timeout: 15000 
          });
          await page.waitForTimeout(2000); // Wait after reload
        }
      }

      if (!listingsFound) {
        throw new Error('Failed to load listings after multiple attempts');
      }

      // Wait a bit for dynamic content to load
      await page.waitForTimeout(2000);

      // Updated ticket extraction code
      const tickets = await page.evaluate(() => {
        const sections = [];
        // Get all listings with a data-listing-id and data-price
        const listings = Array.from(document.querySelectorAll('#listings-container [data-listing-id][data-price]'));
        
        console.log(`Found ${listings.length} raw listings`);
        
        const sectionMap = new Map();
        
        listings.forEach(listing => {
          try {
            // Get listing data from data attributes
            const listingId = listing.getAttribute('data-listing-id');
            const price = listing.getAttribute('data-price');
            
            // Get section and row info
            const sectionText = listing.textContent;
            const sectionMatch = sectionText.match(/Section\s+([^\s]+)/);
            const rowMatch = sectionText.match(/Row\s+([^\s]+)/);
            
            const section = sectionMatch ? 
              rowMatch ? 
                `${sectionMatch[1]} Row ${rowMatch[1]}` : 
                sectionMatch[1] 
              : 'General Admission';

            // Get quantity from text content (e.g., "2 tickets together")
            const quantityMatch = sectionText.match(/(\d+)\s+tickets?/);
            const quantity = quantityMatch ? quantityMatch[1] : '1';

            console.log(`Processing listing: Section=${section}, Price=${price}, Quantity=${quantity}, ID=${listingId}`);
            
            if (section && price) {
              if (!sectionMap.has(section)) {
                sectionMap.set(section, {
                  section,
                  tickets: [],
                  category: 'Concert'
                });
              }
              
              const rawPrice = parseFloat(price.replace(/[^0-9.]/g, ''));
              if (!isNaN(rawPrice)) {
                sectionMap.get(section).tickets.push({
                  quantity,
                  price,
                  rawPrice,
                  listingId,
                  listingUrl: window.location.href
                });
              }
            }
          } catch (err) {
            console.log(`Error processing listing: ${err.message}`);
          }
        });

        // Convert map to array and filter out sections with no tickets
        sectionMap.forEach((sectionData, sectionName) => {
          if (sectionData.tickets.length > 0) {
            sections.push(sectionData);
          }
        });

        return {
          totalSections: sections.length,
          sections: sections
        };
      });

      // Add debug logging
      console.log(`Found ${tickets.totalSections} sections with tickets`);
      if (tickets.sections?.length > 0) {
        tickets.sections.forEach(section => {
          console.log(`Section ${section.section}: ${section.tickets.length} tickets found`);
          if (section.tickets.length > 0) {
            console.log('Sample ticket:', JSON.stringify(section.tickets[0], null, 2));
          }
        });
      } else {
        console.log('No sections with tickets found');
      }

      return tickets;

    } catch (error) {
      console.error('Error fetching ticket prices:', error);
      return { totalSections: 0, sections: [] };
    } finally {
      if (browser && !existingPage) {
        await browser.close();
      }
    }
  }

  async searchConcerts(artist, venue, location) {
    const browser = await setupBrowser();
    let page;
    
    try {
      page = await setupPage(browser);
      const searchUrl = this.generateSearchUrl(artist, venue, location);
      console.log('Navigating to:', searchUrl);

      // Initial navigation and event search
      await page.goto(searchUrl, { waitUntil: 'networkidle0', timeout: 15000 });

      try {
        await page.waitForSelector('[data-testid="primaryGrid"]', { timeout: 10000 });
      } catch (timeoutError) {
        console.log('Initial load timed out, attempting reload...');
        await page.reload({ waitUntil: 'networkidle0' });
        await page.waitForSelector('[data-testid="primaryGrid"]', { timeout: 20000 });
      }

      const events = await this.extractEventDetails(page);
      console.log(`Found ${events.length} events`);

      // For each event, get ticket information
      const eventsWithTickets = [];
      
      for (const event of events) {
        try {
          console.log(`Navigating to event page for: ${event.name}`);
          
          // Navigate to event page
          await page.goto(event.link, {
            waitUntil: 'domcontentloaded',
            timeout: 15000
          });

          // Wait for listings container with retry
          let listingsFound = false;
          for (let attempt = 1; attempt <= 3 && !listingsFound; attempt++) {
            try {
              await page.waitForSelector('#listings-container', { timeout: 5000 });
              listingsFound = true;
            } catch (err) {
              console.log(`Attempt ${attempt}: Listings not found, reloading...`);
              await page.reload({ waitUntil: 'domcontentloaded' });
            }
          }

          if (!listingsFound) {
            console.error('Failed to load listings after 3 attempts');
            eventsWithTickets.push(event); // Keep event even without tickets
            continue;
          }

          // Get ticket information
          const ticketInfo = await this.getTicketPrices(event.link, page);
          
          if (ticketInfo.sections?.length > 0) {
            eventsWithTickets.push({
              ...event,
              tickets: ticketInfo.sections.map(section => ({
                section: section.section,
                tickets: section.tickets,
                category: section.category || 'Concert'
              }))
            });
            console.log(`Successfully collected ${ticketInfo.sections.length} sections of tickets for ${event.name}`);
          } else {
            console.log('No tickets found for event, storing event without tickets');
            eventsWithTickets.push(event);
          }
        } catch (ticketError) {
          console.error(`Failed to get tickets for ${event.name}:`, ticketError);
          eventsWithTickets.push(event); // Keep event even if ticket collection fails
        }
      }

      return eventsWithTickets;

    } catch (error) {
      console.error('StubHub search error:', error);
      return [];
    } finally {
      if (page) await page.close();
      if (browser) await browser.close();
    }
  }
}

export default StubHubSearcher;