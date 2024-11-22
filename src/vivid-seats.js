import { createClient } from '@supabase/supabase-js';
import { config } from '@/src/config/env';
import { setupBrowser, setupPage, formatPrice } from './utils.js';
import { parse } from 'date-fns';

const supabase = createClient(
  config.supabase.url,
  config.supabase.serviceKey
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

    try {
      searchPage = await setupPage(browser);
      const searchUrl = this.generateSearchUrl(artist, venue, location);
      console.log('Searching VividSeats:', searchUrl);

      await searchPage.goto(searchUrl, {
        waitUntil: 'networkidle0',
        timeout: 30000
      });

      // Wait for either productions list to appear
      await searchPage.waitForSelector('[data-testid="productions-list"]', { timeout: 10000 });

      const concerts = await searchPage.evaluate(({ artist, location, venue }) => {
        // Get all production listings from both "Upcoming Events" and "All Locations" sections
        const productionLists = Array.from(document.querySelectorAll('[data-testid="productions-list"]'));
        const allEvents = [];

        productionLists.forEach(list => {
          // First, get all production listings
          const listings = Array.from(list.querySelectorAll('[data-testid^="production-listing-"]'));
          console.log(`Found ${listings.length} listings`);

          listings.forEach(listing => {
            try {
              // Get the anchor element and check if it exists and has href
              const anchor = listing.querySelector('a');
              if (!anchor || !anchor.href) {
                console.log('Skipping listing - no valid link found');
                return;
              }

              // Skip parking listings
              if (anchor.href.toLowerCase().includes('parking')) {
                console.log('Skipping parking listing');
                return;
              }

              // Get date components with null checks
              const dateElement = listing.querySelector('[data-testid="date-time-left-element"]');
              if (!dateElement) {
                console.log('Skipping listing - no date element found');
                return;
              }

              const dayOfWeek = dateElement.querySelector('.MuiTypography-overline')?.textContent?.trim() || '';
              const date = dateElement.querySelector('.MuiTypography-small-bold')?.textContent?.trim() || '';
              const year = dateElement.querySelector('.MuiTypography-small-bold:last-of-type')?.textContent?.trim() || '';
              const time = dateElement.querySelector('.MuiTypography-caption')?.textContent?.trim() || '';

              // Get title with null check
              const titleElement = listing.querySelector('.styles_titleTruncate__XiZ53');
              if (!titleElement) {
                console.log('Skipping listing - no title element found');
                return;
              }
              const title = titleElement.textContent.trim();

              // Find venue and location using the styles_labelContainer__ wildcard
              const labelContainer = listing.querySelector('[class^="styles_labelContainer__"]');
              if (!labelContainer) {
                console.log('Skipping listing - no label container found');
                return;
              }

              // Get all text truncate spans within the label container
              const truncateSpans = Array.from(labelContainer.querySelectorAll('.styles_textTruncate__wsM3Q'));
              if (truncateSpans.length < 2) {
                console.log('Skipping listing - incomplete venue/location info');
                return;
              }

              // First span is venue, last span is location
              const venue = truncateSpans[0].textContent.trim();
              const eventLocation = truncateSpans[truncateSpans.length - 1].textContent.trim();

              // Only add event if we have all required fields
              if (title && date && venue && eventLocation && anchor.href) {
                console.log(`Found valid event: ${title} at ${venue}`);
                allEvents.push({
                  title,
                  date: `${date} ${dayOfWeek} ${time}`,
                  venue,
                  location: eventLocation,
                  link: anchor.href,
                  source: 'vividseats',
                  rawData: {
                    dayOfWeek,
                    date,
                    year,
                    time,
                    fullTitle: title
                  }
                });
              }
            } catch (err) {
              console.log('Error parsing event:', err);
            }
          });
        });

        // Score and sort events by relevance
        return allEvents.map(event => {
          let score = 0;
          
          // Exact title match
          if (event.title.toLowerCase() === artist.toLowerCase()) score += 100;
          // Contains artist name
          else if (event.title.toLowerCase().includes(artist.toLowerCase())) score += 50;
          
          // Location match
          if (event.location.toLowerCase().includes(location.toLowerCase())) score += 30;
          
          // Venue match (if provided)
          if (venue && event.venue.toLowerCase().includes(venue.toLowerCase())) score += 20;

          return { ...event, matchScore: score };
        }).sort((a, b) => b.matchScore - a.matchScore);
      }, { artist, location, venue });

      console.log(`Found ${concerts.length} matching VividSeats event(s)`);
      
      // Get tickets for the best matching event(s)
      const bestMatches = concerts.filter(event => event.matchScore >= 50);
      const concertsWithPrices = [];

      // Process each event only once
      const processedUrls = new Set();

      for (const concert of bestMatches) {
        // Skip if we've already processed this URL
        if (processedUrls.has(concert.link)) {
          continue;
        }
        
        console.log(`Processing event: "${concert.title}" (match score: ${concert.matchScore})`);
        
        // Use the existing page to navigate to the event
        await searchPage.goto(concert.link, { waitUntil: 'networkidle0', timeout: 30000 });
        
        // Extract tickets directly from the loaded page
        const tickets = await searchPage.evaluate(() => {
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

        if (tickets && tickets.totalSections > 0) {
          console.log(`Found tickets in ${tickets.totalSections} sections`);
          concertsWithPrices.push({
            ...concert,
            tickets
          });
        }

        // Mark this URL as processed
        processedUrls.add(concert.link);
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