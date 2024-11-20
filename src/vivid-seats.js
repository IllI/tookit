import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { setupBrowser, setupPage, formatPrice } from './utils.js';
import { parse } from 'date-fns';

dotenv.config();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Function to check if an event exists
async function eventExists(name, date) {
  const { data, error } = await supabase
    .from('events')
    .select('id')
    .eq('name', name)
    .eq('date', date)
    .single();
  
  if (error && error.code !== 'PGRST116') {
    console.error('Error checking event existence:', error);
    return false;
  }
  
  return data ? true : false;
}

// Function to check if a link exists
async function linkExists(eventId, source) {
  const { data, error } = await supabase
    .from('event_links')
    .select('id')
    .eq('event_id', eventId)
    .eq('source', source)
    .single();
  
  if (error && error.code !== 'PGRST116') {
    console.error('Error checking link existence:', error);
    return false;
  }
  
  return data ? true : false;
}

// Function to insert an event
async function insertEvent(event) {
  const parsedDate = parse(event.date, 'MMM d yyyy h:mm a', new Date());

  console.log(`Parsed Date Object: ${parsedDate} | Timestamp: ${parsedDate.getTime()}`);

  if (isNaN(parsedDate)) {
    console.error('Invalid Date object:', event.date);
    return null;
  }

  // Check if the event already exists
  const exists = await eventExists(event.title, parsedDate.toISOString());
  if (exists) {
    console.log(`Event "${event.title}" on ${parsedDate.toISOString()} already exists. Skipping insertion.`);
    return null;
  }

  const eventData = {
    name: event.title,
    type: event.type || 'Concert',
    category: event.category || 'Unknown',
    date: parsedDate.toISOString(),
    venue: event.venue
  };

  console.log('Attempting to insert event:', eventData);

  const { data, error } = await supabase
    .from('events')
    .insert([eventData])
    .select('id');
  
  if (error) {
    console.error('Error inserting event:', error);
    console.error('Error details:', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint
    });
    return null;
  }
  
  console.log('Successfully inserted event:', data[0].id);
  return data[0].id;
}

// Function to insert event links
async function insertEventLink(eventId, source, url) {
  // Check if the link already exists to prevent duplicates
  const exists = await linkExists(eventId, source);
  if (exists) {
    console.log(`Event link from ${source} already exists for event ID ${eventId}. Skipping insertion.`);
    return;
  }

  const linkData = {
    event_id: eventId,
    source: source,
    url: url
  };

  const { data, error } = await supabase
    .from('event_links')
    .insert([linkData]);
  
  if (error) {
    console.error(`Error inserting event link (${source}):`, error);
  } else {
    console.log(`Inserted event link (${source}):`, data[0].id);
  }
}

// Function to insert tickets
async function insertTickets(eventId, tickets) {
  const formattedTickets = tickets.sections.flatMap(section => 
    section.tickets.map(ticket => ({
      event_id: eventId,
      price: ticket.rawPrice,
      type: section.category,
      section: section.section,
      row: ticket.row || null,
      quantity: parseInt(ticket.quantity, 10) || 1,
      source: 'vividseats',
      url: ticket.listingUrl,
      raw_data: ticket
    }))
  );
  
  const { data, error } = await supabase
    .from('tickets')
    .insert(formattedTickets);
  
  if (error) {
    console.error('Error inserting tickets:', error);
  } else {
    console.log('Inserted tickets:', data.length);
  }
}

async function mainSearch(artist, venue, location) {
  const searcher = new VividSeatsSearcher();
  const concertsWithPrices = await searcher.searchConcerts(artist, venue, location);
  
  for (const concert of concertsWithPrices) {
    const eventId = await insertEvent(concert);
    if (eventId) {
      // Insert event links into event_links table
      await insertEventLink(eventId, 'vividseats', concert.link);

      // Insert tickets into tickets table
      if (concert.tickets) {
        await insertTickets(eventId, concert.tickets);
      }
    }
  }
}

// Call mainSearch with your parameters
// mainSearch('Cake', 'Salt Shed', 'Chicago');

class VividSeatsSearcher {
  constructor() {
    this.baseUrl = 'https://www.vividseats.com/search';
  }

  generateSearchUrl(artist, venue, location) {
    const searchParams = new URLSearchParams();
    let searchTerms = [];
    
    if (artist) searchTerms.push(artist);
    if (location) searchTerms.push(location);
    
    searchParams.append('searchTerm', searchTerms.join(' '));
    
    return `${this.baseUrl}?${searchParams.toString()}`;
  }

  // ... existing methods including getTicketPrices and searchConcerts ...

  async searchConcerts(artist, venue, location) {
    const browser = await setupBrowser();
    let searchPage;
    let eventPage;

    try {
      searchPage = await setupPage(browser);
      const searchUrl = this.generateSearchUrl(artist, venue, location);
      console.log('Searching VividSeats:', searchUrl);

      await searchPage.goto(searchUrl, {
        waitUntil: 'networkidle0',
        timeout: 30000
      });

      await searchPage.waitForSelector('[data-testid^="production-listing-"]', { timeout: 10000 });

      const concerts = await searchPage.evaluate((params) => {
        const { artist, location } = params;
        const events = Array.from(document.querySelectorAll('[data-testid^="production-listing-"]'));
        
        return events.map(event => {
          try {
            const title = event.querySelector('.MuiTypography-small-medium')?.textContent?.trim() || '';
            const dayOfWeek = event.querySelector('.MuiTypography-overline')?.textContent?.trim() || '';
            const date = event.querySelector('.MuiTypography-small-bold')?.textContent?.trim() || '';
            const time = event.querySelector('.MuiTypography-caption')?.textContent?.trim() || '';
            const venueElement = event.querySelector('.MuiTypography-small-regular.styles_truncate__yWy53');
            const locationElement = event.querySelector('.MuiTypography-small-regular.styles_truncate__yWy53:last-child');
            const venue = venueElement?.textContent?.trim() || '';
            const eventLocation = locationElement?.textContent?.trim() || '';
            const link = event.querySelector('a')?.href || '';

            if (title.toLowerCase().includes('parking')) {
              return null;
            }

            return {
              title,
              date: `${date} ${dayOfWeek} ${time}`,
              venue,
              location: eventLocation,
              link,
              source: 'vividseats'
            };
          } catch (err) {
            console.log('Error parsing VividSeats event:', err);
            return null;
          }
        })
        .filter(event => event !== null)
        .filter(event => {
          const artistMatch = !artist || event.title.toLowerCase().includes(artist.toLowerCase());
          const locationMatch = !location || event.location.toLowerCase().includes(location.toLowerCase());
          return artistMatch && locationMatch && event.link;
        });
      }, { artist, location });

      console.log(`Found ${concerts.length} matching VividSeats event(s)`);
      
      const uniqueConcerts = concerts.reduce((acc, current) => {
        const key = `${current.title}-${current.venue}-${current.date}`;
        if (!acc[key]) {
          acc[key] = current;
        }
        return acc;
      }, {});

      const concertsWithPrices = [];
      for (const concert of Object.values(uniqueConcerts)) {
        const prices = await this.getTicketPrices(concert.link);
        concertsWithPrices.push({
          ...concert,
          tickets: prices
        });
      }

      return concertsWithPrices;

    } catch (error) {
      console.error('VividSeats error details:', error);
      if (searchPage) {
        await searchPage.screenshot({ path: 'vividseats-error.png', fullPage: true });
      }
      return [];
    } finally {
      if (browser) {
        await browser.close();
      }
    }
  }

  async getTicketPrices(eventUrl, existingPage = null) {
    let browser = null;
    let page = existingPage;
    
    try {
      if (!existingPage) {
        browser = await setupBrowser();
        page = await setupPage(browser);
        console.log('Navigating to event page:', eventUrl);
      }

      // Function to check for content
      const checkContent = async () => {
        try {
          const content = await page.evaluate(() => {
            const selectors = [
              '.styles_listingRowContainer__KNM4_',
              '.styles_listingRowContainer__d8WLZ',
              '[data-testid="listing-group-row-container"]',
              '[data-testid="listing-row-container"]'
            ];
            
            for (const selector of selectors) {
              if (document.querySelector(selector)) {
                return true;
              }
            }
            return false;
          });
          return content;
        } catch (error) {
          console.log('Error checking content:', error);
          return false;
        }
      };

      // Initial navigation
      try {
        await page.goto(eventUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
      } catch (error) {
        console.log('Initial navigation error:', error);
      }

      // Check for content
      let contentFound = await checkContent();
      let attempts = 1;
      const maxAttempts = 3;

      while (!contentFound && attempts < maxAttempts) {
        console.log(`Content check attempt ${attempts} of ${maxAttempts}`);
        
        try {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForTimeout(2000);
          contentFound = await checkContent();
          
          if (contentFound) {
            console.log('Found content on attempt', attempts);
            break;
          }
        } catch (error) {
          console.log(`Error on attempt ${attempts}:`, error);
        }
        
        attempts++;
      }

      if (!contentFound) {
        throw new Error('Could not find content after multiple attempts');
      }

      // Extract tickets only if content was found
      const tickets = await page.evaluate(() => {
        const groupListings = Array.from(document.querySelectorAll('[data-testid="listing-group-row-container"]'));
        const individualListings = Array.from(document.querySelectorAll('[data-testid="listing-row-container"]'));
        
        console.log(`Found ${groupListings.length} group listings and ${individualListings.length} individual listings`);
        
        const allListings = [...groupListings, ...individualListings];

        const normalizeSection = (section) => {
          if (!section) return 'UNKNOWN';
          
          const sectionUpper = section.toUpperCase();
          const categories = {
            'GENERAL ADMISSION': ['GA', 'GEN', 'GENADM'],
            'GRANDSTAND': ['GRAND', 'GSADA', 'GS'],
            'PREMIUM': ['PREM', 'PRM'],
            'VIP': ['VIP'],
            'BALCONY': ['BAL', 'BALC'],
            'FLOOR': ['FLR', 'FLOOR'],
            'STANDING': ['STAND']
          };

          for (const [category, keywords] of Object.entries(categories)) {
            if (keywords.some(keyword => sectionUpper.includes(keyword))) {
              return category;
            }
          }

          return `UNCATEGORIZED: ${section}`;
        };

        const ticketsBySection = {};
        
        allListings.forEach((listing, index) => {
          try {
            const section = listing.querySelector('[data-testid^="GRANDS"], [data-testid^="GSADA"], [data-testid^="PREM"], [data-testid^="GENADM"], .MuiTypography-small-medium')?.textContent?.trim() || '';
            const quantity = listing.querySelector('.MuiTypography-caption-regular')?.textContent?.trim() || '';
            const price = listing.querySelector('[data-testid="listing-price"]')?.textContent?.trim() || '';
            const row = listing.querySelector('[data-testid="row"]')?.textContent?.trim();
            const dealScore = listing.querySelector('[data-testid="deal-score"], .styles_greatestScoreLabel__Kq4O3')?.textContent?.trim() || '';
            const listingId = listing.getAttribute('data-listing-id');

            const normalizedSection = normalizeSection(section);
            
            if (!ticketsBySection[normalizedSection]) {
              ticketsBySection[normalizedSection] = {
                section: normalizedSection,
                originalSection: section,
                category: normalizedSection.startsWith('UNCATEGORIZED') ? 'UNKNOWN' : normalizedSection,
                tickets: []
              };
            }

            if (price && section) {
              ticketsBySection[normalizedSection].tickets.push({
                quantity,
                price,
                dealScore,
                rawPrice: parseFloat(price.replace(/[^0-9.]/g, '')),
                row: row || null,
                listingId,
                originalSection: section,
                listingUrl: window.location.href
              });
            }
          } catch (err) {
            console.log(`Error processing listing ${index + 1}:`, err);
          }
        });

        Object.values(ticketsBySection).forEach(section => {
          section.tickets.sort((a, b) => a.rawPrice - b.rawPrice);
          section.lowestPrice = section.tickets[0]?.rawPrice || null;
          section.highestPrice = section.tickets[section.tickets.length - 1]?.rawPrice || null;
          section.numberOfListings = section.tickets.length;
        });

        return {
          totalSections: Object.keys(ticketsBySection).length,
          sections: Object.values(ticketsBySection).sort((a, b) => a.lowestPrice - b.lowestPrice)
        };
      });

      console.log(`Found tickets in ${tickets.totalSections} sections`);
      return tickets;

    } catch (error) {
      console.error('Error fetching ticket prices:', error);
      return { totalSections: 0, sections: [] };
    } finally {
      if (browser && !existingPage) {
        try {
          await browser.close();
        } catch (error) {
          console.log('Error closing browser:', error);
        }
      }
    }
  }
}

export default VividSeatsSearcher;