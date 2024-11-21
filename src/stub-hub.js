import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { executablePath } from 'puppeteer';
import { parse } from 'date-fns';

puppeteer.use(StealthPlugin());

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
    return await puppeteer.launch({
      headless: false,
      executablePath: executablePath(),
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1920,1080',
        '--disable-features=site-per-process',
        '--disable-web-security'
      ],
      defaultViewport: { width: 1920, height: 1080 }
    });
  }

  async setupPage(browser) {
    const page = await browser.newPage();
    
    await page.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive'
    });

    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    return page;
  }

  async getTicketPrices(eventUrl, existingPage = null) {
    let browser = null;
    let page = existingPage;
    
    try {
      if (!existingPage) {
        browser = await this.setupBrowser();
        page = await this.setupPage(browser);
        console.log('Navigating to event page:', eventUrl);

        // Initial navigation
        await page.goto(eventUrl, { 
          waitUntil: 'domcontentloaded',
          timeout: 30000 
        });
      }

      // Function to check for listings container
      const checkListingsContainer = async () => {
        console.log('Checking for listings container...');
        const content = await page.content();
        return content.includes('listings-container');
      };

      // First check
      let hasListings = await checkListingsContainer();

      // If not found, try reloading
      if (!hasListings) {
        console.log('Listings container not found, reloading page...');
        try {
          await Promise.race([
            page.reload({ waitUntil: 'domcontentloaded' }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Reload timeout')), 10000))
          ]);
          
          // Wait a moment for any dynamic content
          await page.waitForTimeout(2000);
          
          // Check again after reload
          hasListings = await checkListingsContainer();
          if (!hasListings) {
            console.log('Listings container still not found after reload, trying alternative approach...');
            // Try navigating to the URL again
            await page.goto(eventUrl, { 
              waitUntil: 'domcontentloaded',
              timeout: 10000 
            });
            await page.waitForTimeout(2000);
            hasListings = await checkListingsContainer();
          }
        } catch (reloadError) {
          console.log('Reload failed, trying alternative approach...', reloadError.message);
          // If reload times out, try navigating to the URL again
          await page.goto(eventUrl, { 
            waitUntil: 'domcontentloaded',
            timeout: 10000 
          });
          await page.waitForTimeout(2000);
          hasListings = await checkListingsContainer();
        }
      }

      // Wait for listings container with multiple selector attempts
      let listingsFound = false;
      const selectors = [
        '#listings-container',
        '[data-testid="listings-container"]',
        '.listing-container',
        '[data-testid="event-listings"]'
      ];

      console.log('Waiting for listings container to be visible...');
      for (const selector of selectors) {
        try {
          await page.waitForSelector(selector, { 
            timeout: 5000,
            visible: true 
          });
          console.log(`Found listings container with selector: ${selector}`);
          listingsFound = true;
          break;
        } catch (error) {
          console.log(`Selector ${selector} not found, trying next...`);
        }
      }

      if (!listingsFound) {
        console.error('Could not find listings container with any known selector');
        await page.screenshot({ path: 'listings-error.png', fullPage: true });
        throw new Error('Listings container not found after all attempts');
      }

      // Wait for actual ticket listings to load with shorter timeout
      await page.waitForFunction(() => {
        const listings = document.querySelectorAll('[data-listing-id]');
        return listings.length > 0;
      }, { timeout: 10000 });

      // Additional delay to ensure all dynamic content is loaded
      await page.waitForTimeout(1000);

      const tickets = await page.evaluate(() => {
        const listings = Array.from(document.querySelectorAll('[data-listing-id]'));
        console.log(`Processing ${listings.length} listings`);
        
        const ticketsBySection = {};
        
        listings.forEach((listing, index) => {
          try {
            // Skip sold tickets
            if (listing.getAttribute('data-is-sold') === '1') return;

            // Get section name with multiple selector attempts
            const section = listing.querySelector('.sc-hlalgf-6')?.textContent?.trim() ||
                           listing.querySelector('[data-testid="section-name"]')?.textContent?.trim() ||
                           listing.querySelector('[data-auto="listing-section"]')?.textContent?.trim() ||
                           'General Admission';

            // Get price with multiple selector attempts
            const priceElement = listing.querySelector('[data-testid="listing-price"]') ||
                                listing.querySelector('.sc-hlalgf-1') ||
                                listing.querySelector('[data-auto="listing-price"]');
            const price = priceElement?.textContent?.trim();

            // Get quantity with multiple selector attempts
            const quantity = listing.querySelector('.sc-hlalgf-14')?.textContent?.trim() ||
                            listing.querySelector('[data-testid="quantity"]')?.textContent?.trim() ||
                            listing.querySelector('[data-auto="listing-quantity"]')?.textContent?.trim();

            if (!price) return;

            if (!ticketsBySection[section]) {
              ticketsBySection[section] = {
                section,
                tickets: [],
                lowestPrice: Infinity,
                highestPrice: -Infinity,
                numberOfListings: 0
              };
            }

            const numericPrice = parseFloat(price.replace(/[^0-9.]/g, ''));
            
            const ticketInfo = {
              quantity,
              price,
              rawPrice: numericPrice,
              listingUrl: window.location.href,
              listingId: listing.getAttribute('data-listing-id')
            };

            ticketsBySection[section].tickets.push(ticketInfo);
            
            if (!isNaN(numericPrice)) {
              ticketsBySection[section].lowestPrice = Math.min(ticketsBySection[section].lowestPrice, numericPrice);
              ticketsBySection[section].highestPrice = Math.max(ticketsBySection[section].highestPrice, numericPrice);
              ticketsBySection[section].numberOfListings++;
            }
          } catch (err) {
            console.log(`Error processing listing ${index}:`, err);
          }
        });

        Object.values(ticketsBySection).forEach(section => {
          if (section.lowestPrice === Infinity) section.lowestPrice = null;
          if (section.highestPrice === -Infinity) section.highestPrice = null;
          section.tickets.sort((a, b) => (a.rawPrice || Infinity) - (b.rawPrice || Infinity));
        });

        return {
          totalSections: Object.keys(ticketsBySection).length,
          sections: Object.values(ticketsBySection)
        };
      });

      console.log(`Found tickets in ${tickets.totalSections} sections`);
      return tickets;

    } catch (error) {
      console.error('Error fetching ticket prices:', error);
      if (page) {
        await page.screenshot({ path: 'error-state.png', fullPage: true });
        const content = await page.content();
        console.log('Page content at error:', content.substring(0, 500) + '...');
      }
      return { totalSections: 0, sections: [] };
    } finally {
      if (browser && !existingPage) {
        await browser.close();
      }
    }
  }

  async searchConcerts(artist, venue, location) {
    const browser = await this.setupBrowser();
    let searchPage;
    let eventPage;

    try {
      searchPage = await this.setupPage(browser);
      const searchUrl = this.generateSearchUrl(artist, venue, location);
      console.log('Searching StubHub:', searchUrl);

      await searchPage.goto(searchUrl, { waitUntil: 'networkidle0', timeout: 30000 });
      console.log('Page loaded, checking content...');

      await searchPage.waitForTimeout(2000);
      let content = await searchPage.content();

      if (!content.includes('data-testid="primaryGrid"')) {
        console.log('Reloading page due to missing content...');
        await searchPage.reload({ waitUntil: 'domcontentloaded' });
        await searchPage.waitForTimeout(3000);
      }

      console.log('Waiting for primary grid...');
      await searchPage.waitForSelector('[data-testid="primaryGrid"]');
      console.log('Found primary grid, extracting events...');

      await searchPage.waitForTimeout(2000);

      const events = await this.extractEventDetails(searchPage);
      console.log(`\nRaw events extracted: ${events.length}`);

      const matchingEvents = events.filter(event => {
        console.log('Checking event:', event.name);
        const titleMatch = !artist || event.name.toLowerCase().includes(artist.toLowerCase());
        const venueMatch = !venue || event.venue.toLowerCase().includes(venue.toLowerCase());
        const locationMatch = !location || event.location.toLowerCase().includes(location.toLowerCase());
        console.log('Match results:', { titleMatch, venueMatch, locationMatch });
        return titleMatch && venueMatch && locationMatch;
      });

      console.log('Found matching events:', matchingEvents.length);

      const eventsWithTickets = [];
      for (const event of matchingEvents) {
        const { success, page: newPage } = await this.navigateToEvent(searchPage, event);
        if (success && newPage) {
          eventPage = newPage;
          const tickets = await this.getTicketPrices(event.link, eventPage);
          console.log('Scraped Tickets:', JSON.stringify(tickets, null, 2));

          eventsWithTickets.push({
            name: event.name,
            date: event.date,
            venue: event.venue,
            location: event.location,
            category: event.category,
            link: event.link,
            source: event.source,
            tickets: tickets
          });

          await eventPage.close();
          await searchPage.waitForTimeout(1000);
        }
      }

      return eventsWithTickets;

    } catch (error) {
      console.error('Search error:', error);
      if (searchPage) {
        await searchPage.screenshot({ path: 'error.png', fullPage: true });
      }
      return [];
    } finally {
      if (eventPage && !eventPage.isClosed()) await eventPage.close();
      if (searchPage && !searchPage.isClosed()) await searchPage.close();
      if (browser) await browser.close();
    }
  }

  // Updated extractEventDetails method
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

      const listItems = Array.from(eventContainer.querySelectorAll('li')).slice(1);
      results.logs.push(`Processing ${listItems.length} event items`);

      listItems.forEach((item, index) => {
        try {
          const link = item.querySelector('a');
          const titleMatch = item.textContent.match(/(?:PM|AM)(.*?)(?:Byline|Shed|Theatre|Arena|Center|Complex|Bar|Bottle)/);
          const title = titleMatch?.[1]?.trim() || '';

          const timeElement = item.querySelector('time');
          const dateText = timeElement?.textContent?.trim() || '';
          
          // Updated regex to handle year in the middle
          const dateMatch = dateText.match(/([A-Za-z]+)\s+(\d+)\s+(\d{4})([A-Za-z]+)(\d+:\d+\s*[AP]M)/i);
          let formattedDate = null;
          
          if (dateMatch) {
            const [_, month, day, year, dayOfWeek, time] = dateMatch;
            const dateStr = `${month} ${day} ${year} ${time}`;
            formattedDate = dateStr;
            results.logs.push(`Parsed Date String: ${dateStr}`);
          } else {
            results.logs.push(`Failed to parse date from text: "${dateText}"`);
          }

          const venueMatch = item.textContent.match(/(?:at\s)?((?:Byline|Shed|Theatre|Arena|Center|Complex|Bar|Bottle)[^,]+)/);
          const venue = venueMatch?.[1]?.trim() || '';

          const locationMatch = item.textContent.match(/([^,]+,\s*[A-Z]{2})/);
          const location = locationMatch?.[1]?.trim() || '';

          // Set category
          const category = 'Concert';

          if (title && formattedDate && venue && location && link?.href) {
            results.events.push({
              name: title,
              date: formattedDate,
              venue,
              location,
              category,
              link: link.href,
              source: 'stubhub'
            });
            
            // Add debug logging for successful event
            results.logs.push(`Successfully parsed event: ${title} on ${formattedDate}`);
          } else {
            results.logs.push(`Incomplete data for event ${index + 1}, skipping insertion.`);
            results.logs.push(`Title: ${title}`);
            results.logs.push(`Date: ${formattedDate}`);
            results.logs.push(`Venue: ${venue}`);
            results.logs.push(`Location: ${location}`);
            results.logs.push(`Has link: ${!!link?.href}`);
          }

          // Debug logging
          results.logs.push(`\nList Item ${index + 1}:`);
          results.logs.push(`Name: ${title}`);
          results.logs.push(`Date: ${formattedDate}`);
          results.logs.push(`Original Date Text: ${dateText}`);
          results.logs.push(`Venue: ${venue}`);
          results.logs.push(`Location: ${location}`);
          results.logs.push(`Category: ${category}`);
          results.logs.push(`Has link: ${!!link?.href}`);
        } catch (err) {
          results.logs.push(`Error processing item ${index + 1}: ${err.message}`);
        }
      });

      return results;
    });

    // Log debug information
    results.logs.forEach(log => console.log(log));
    
    return results.events;
  }

  // navigateToEvent remains unchanged
  async navigateToEvent(page, event) {
    try {
      console.log('Attempting to navigate to event:', event.name);
      const containerSelector = '[data-testid="primaryGrid"]';
      await page.waitForSelector(containerSelector);
      console.log('Found event container');

      // Get all event links
      const eventLinks = await page.$$(`${containerSelector} a[href*="/event/"]`);
      console.log('Found event links:', eventLinks.length);
      
      for (const link of eventLinks) {
        const linkContent = await link.evaluate(el => {
          return {
            text: el.textContent.replace(/\s+/g, ' ').trim(),
            href: el.href
          };
        });
        console.log('Checking link:', linkContent);

        if (linkContent.text.includes(event.name)) {
          console.log('Found matching event, clicking link');
          
          // Create a promise that resolves when a new page is created
          const newPagePromise = new Promise(resolve => 
            page.browser().once('targetcreated', async target => {
              const newPage = await target.page();
              resolve(newPage);
            })
          );

          // Click the link
          await link.click();

          // Wait for the new page to open
          const newPage = await newPagePromise;
          console.log('New page opened');

          // Wait for the listings container in the new page
          await newPage.waitForSelector('#listings-container', { timeout: 60000 });
          console.log('Event page loaded');

          // Return both success status and the new page
          return { success: true, page: newPage };
        }
      }

      console.log(`Could not find event with name: ${event.name}`);
      return { success: false, page: null };
    } catch (error) {
      console.error('Navigation error:', error);
      return { success: false, page: null };
    }
  }
}

export default StubHubSearcher;