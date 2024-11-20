const StubHubSearcher = require('./src/stub-hub');
const VividSeatsSearcher = require('./src/vivid-seats');

module.exports = {
  StubHubSearcher,
  VividSeatsSearcher
};

// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// const { executablePath } = require('puppeteer');
// const yargs = require('yargs/yargs');
// const { hideBin } = require('yargs/helpers');

// puppeteer.use(StealthPlugin());

// class StubHubSearcher {
//   constructor() {
//     this.baseUrl = 'https://www.stubhub.com/secure/search';
//   }

//   generateSearchUrl(artist, venue, location) {
//     const searchParams = new URLSearchParams();
//     let searchTerms = [];
    
//     if (artist) searchTerms.push(artist);
//     if (venue) searchTerms.push(venue);
//     if (location) searchTerms.push(location);
    
//     searchParams.append('q', searchTerms.join(' '));
    
//     return `${this.baseUrl}?${searchParams.toString()}`;
//   }

//   async searchConcerts(artist, venue, location) {
//     const browser = await puppeteer.launch({
//       headless: false,
//       executablePath: executablePath(),
//       args: [
//         '--no-sandbox',
//         '--disable-setuid-sandbox',
//         '--disable-blink-features=AutomationControlled',
//         '--window-size=1920,1080',
//         '--disable-features=site-per-process',
//         '--disable-web-security'
//       ],
//       defaultViewport: null
//     });

//     let page;

//     try {
//       page = await browser.newPage();
      
//       // Basic anti-detection setup
//       await page.setExtraHTTPHeaders({
//         'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
//         'Accept-Language': 'en-US,en;q=0.9',
//         'Accept-Encoding': 'gzip, deflate, br',
//         'Connection': 'keep-alive'
//       });

//       await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

//       // Navigate directly to search URL
//       const searchUrl = this.generateSearchUrl(artist, venue, location);
//       console.log('Searching:', searchUrl);

//       const response = await page.goto(searchUrl, {
//         waitUntil: 'networkidle0',
//         timeout: 30000
//       });

//       // Handle blank page with reload if needed
//       const content = await page.content();
//       if (!content.includes('event-card') && !content.includes('EventItem')) {
//         console.log('Reloading page...');
//         await page.reload({ waitUntil: 'networkidle0' });
//         await page.waitForTimeout(3000);
//       }

//       // Extract and filter events
//       const concerts = await page.evaluate(({ artist, location }) => {
//         const events = Array.from(document.querySelectorAll('.sc-1or4et4-0.erUdBv'));
        
//         return events.map(event => {
//           try {
//             const title = event.querySelector('.sc-1mafo1b-4')?.textContent?.trim() || '';
//             const dateElement = event.querySelector('time');
//             const dateDay = dateElement?.querySelector('.sc-ja5jff-4')?.textContent || '';
//             const dateTime = dateElement?.querySelector('.sc-ja5jff-2')?.textContent || '';
//             const venue = event.querySelector('.sc-1pilhev-2')?.textContent?.trim() || '';
//             const eventLocation = event.querySelector('.sc-1pilhev-8')?.textContent?.trim() || '';
//             const link = event.querySelector('a')?.href || '';

//             return {
//               title,
//               date: `${dateDay} ${dateTime}`.trim(),
//               venue,
//               location: eventLocation,
//               link
//             };
//           } catch (err) {
//             console.log('Error parsing event:', err);
//             return null;
//           }
//         })
//         .filter(event => event !== null) // Remove any events that failed to parse
//         .filter(event => {
//           try {
//             // Case-insensitive exact match for artist name
//             const artistMatch = !artist || 
//               (event.title && event.title.toLowerCase() === artist.toLowerCase());
            
//             // Case-insensitive partial match for location
//             const locationMatch = !location || 
//               (event.location && event.location.toLowerCase().includes(location.toLowerCase()));
            
//             // Ensure event has a valid link
//             const hasValidLink = event.link && event.link.length > 0;
            
//             return artistMatch && locationMatch && hasValidLink;
//           } catch (err) {
//             console.log('Error filtering event:', err);
//             return false;
//           }
//         });
//       }, { artist, location });

//       // Log the results for debugging
//       console.log(`Found ${concerts.length} matching event${concerts.length === 1 ? '' : 's'} with valid links`);
      
//       // If we have multiple matches with the same title/venue/date, return only the first one
//       const uniqueConcerts = concerts.reduce((acc, current) => {
//         const key = `${current.title}-${current.venue}-${current.date}`;
//         if (!acc[key]) {
//           acc[key] = current;
//         }
//         return acc;
//       }, {});

//       return Object.values(uniqueConcerts);

//     } catch (error) {
//       console.error('Error details:', error);
//       if (page) {
//         const content = await page.content();
//         console.log('Page content preview:', content.substring(0, 1000));
//         await page.screenshot({ path: 'error-screenshot.png', fullPage: true });
//       }
//       return [];
//     } finally {
//       if (browser) {
//         await browser.close();
//       }
//     }
//   }
// }

// class VividSeatsSearcher {
//   constructor() {
//     this.baseUrl = 'https://www.vividseats.com/search';
//   }

//   generateSearchUrl(artist, venue, location) {
//     const searchParams = new URLSearchParams();
//     let searchTerms = [];
    
//     if (artist) searchTerms.push(artist);
//     if (location) searchTerms.push(location);
    
//     searchParams.append('searchTerm', searchTerms.join(' '));
    
//     return `${this.baseUrl}?${searchParams.toString()}`;
//   }

//   async getTicketPrices(eventUrl) {
//     const browser = await puppeteer.launch({
//       headless: false,
//       executablePath: executablePath(),
//       args: [
//         '--no-sandbox',
//         '--disable-setuid-sandbox',
//         '--disable-blink-features=AutomationControlled',
//         '--window-size=1920,1080'
//       ],
//       defaultViewport: null
//     });

//     let page;

//     try {
//       page = await browser.newPage();
      
//       await page.setExtraHTTPHeaders({
//         'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
//         'Accept-Language': 'en-US,en;q=0.9',
//         'Accept-Encoding': 'gzip, deflate, br',
//         'Connection': 'keep-alive'
//       });

//       await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

//       console.log('Navigating to event page:', eventUrl);
//       await page.goto(eventUrl, {
//         waitUntil: 'networkidle0',
//         timeout: 30000
//       });

//       // Wait for either type of listing container
//       await Promise.race([
//         page.waitForSelector('.styles_listingRowContainer__KNM4_', { timeout: 10000 }),
//         page.waitForSelector('.styles_listingRowContainer__d8WLZ', { timeout: 10000 })
//       ]);

//       // Extract ticket information
//       const tickets = await page.evaluate(() => {
//         // Get both types of listing containers
//         const groupListings = Array.from(document.querySelectorAll('[data-testid="listing-group-row-container"]'));
//         const individualListings = Array.from(document.querySelectorAll('[data-testid="listing-row-container"]'));
        
//         console.log(`Found ${groupListings.length} group listings and ${individualListings.length} individual listings`);
        
//         const allListings = [...groupListings, ...individualListings];

//         // Helper function to normalize section names using fuzzy logic
//         const normalizeSection = (section) => {
//           if (!section) return 'UNKNOWN';
          
//           const sectionUpper = section.toUpperCase();
          
//           // Create a scoring system for each category
//           const categoryScores = {
//             'GENERAL ADMISSION': 0,
//             'GRANDSTAND': 0,
//             'PREMIUM': 0,
//             'VIP': 0,
//             'BALCONY': 0,
//             'FLOOR': 0,
//             'STANDING': 0
//           };

//           // Score different patterns
//           if (sectionUpper.includes('GA') || sectionUpper.includes('GEN') || sectionUpper.includes('GENADM')) {
//             categoryScores['GENERAL ADMISSION'] += 2;
//           }
//           if (sectionUpper.includes('GRAND') || sectionUpper.includes('GSADA') || sectionUpper.includes('GS')) {
//             categoryScores['GRANDSTAND'] += 2;
//           }
//           if (sectionUpper.includes('PREM') || sectionUpper.includes('PRM')) {
//             categoryScores['PREMIUM'] += 2;
//           }
//           if (sectionUpper.includes('VIP')) {
//             categoryScores['VIP'] += 2;
//           }
//           if (sectionUpper.includes('BAL') || sectionUpper.includes('BALC')) {
//             categoryScores['BALCONY'] += 2;
//           }
//           if (sectionUpper.includes('FLR') || sectionUpper.includes('FLOOR')) {
//             categoryScores['FLOOR'] += 2;
//           }
//           if (sectionUpper.includes('STAND')) {
//             categoryScores['STANDING'] += 2;
//           }

//           // Add context-based scoring
//           if (sectionUpper.includes('SEAT')) {
//             categoryScores['GRANDSTAND'] += 1;
//             categoryScores['BALCONY'] += 1;
//           }
//           if (sectionUpper.includes('ADMISSION')) {
//             categoryScores['GENERAL ADMISSION'] += 1;
//           }

//           // Find category with highest score
//           const entries = Object.entries(categoryScores);
//           const highestScore = Math.max(...entries.map(([_, score]) => score));
          
//           if (highestScore === 0) {
//             // If no category matched well, store original but mark as uncategorized
//             return `UNCATEGORIZED: ${section}`;
//           }

//           // Get all categories that tied for highest score
//           const topCategories = entries
//             .filter(([_, score]) => score === highestScore)
//             .map(([category]) => category);

//           return topCategories[0]; // Return first matching category
//         };

//         // Group tickets by normalized section
//         const ticketsBySection = {};
        
//         allListings.forEach((listing, index) => {
//           try {
//             // Get section name (try both possible selectors)
//             const section = listing.querySelector('[data-testid^="GRANDS"], [data-testid^="GSADA"], [data-testid^="PREM"], [data-testid^="GENADM"], .MuiTypography-small-medium')?.textContent?.trim() || '';
            
//             // Get quantity
//             const quantity = listing.querySelector('.MuiTypography-caption-regular')?.textContent?.trim() || '';
            
//             // Get price (try both possible selectors)
//             const priceElement = listing.querySelector('[data-testid="listing-price"]');
//             const price = priceElement?.textContent?.trim() || '';
            
//             // Get row information if available
//             const row = listing.querySelector('[data-testid="row"]')?.textContent?.trim();
            
//             // Get deal score if available
//             const dealScore = listing.querySelector('[data-testid="deal-score"], .styles_greatestScoreLabel__Kq4O3')?.textContent?.trim() || '';

//             const normalizedSection = normalizeSection(section);
            
//             if (!ticketsBySection[normalizedSection]) {
//               ticketsBySection[normalizedSection] = {
//                 section: normalizedSection,
//                 originalSection: section,
//                 category: normalizedSection.startsWith('UNCATEGORIZED') ? 'UNKNOWN' : normalizedSection,
//                 tickets: []
//               };
//             }

//             // Only add if we have valid price and section
//             if (price && section) {
//               ticketsBySection[normalizedSection].tickets.push({
//                 quantity,
//                 price,
//                 dealScore,
//                 rawPrice: parseFloat(price.replace(/[^0-9.]/g, '')),
//                 row: row || null,
//                 listingId: listing.getAttribute('data-testid'),
//                 originalSection: section,
//                 listingUrl: window.location.href
//               });
//             }
//           } catch (err) {
//             console.log(`Error parsing ticket listing ${index + 1}:`, err);
//           }
//         });

//         // Sort tickets within each section by price
//         Object.values(ticketsBySection).forEach(section => {
//           section.tickets.sort((a, b) => a.rawPrice - b.rawPrice);
//           section.lowestPrice = section.tickets[0]?.rawPrice || null;
//           section.highestPrice = section.tickets[section.tickets.length - 1]?.rawPrice || null;
//           section.numberOfListings = section.tickets.length;
//         });

//         return Object.values(ticketsBySection);
//       });

//       // Add more detailed logging after evaluation
//       console.log('Raw ticket data:', JSON.stringify(tickets, null, 2));

//       console.log(`Found tickets in ${tickets.length} different sections`);
//       return {
//         totalSections: tickets.length,
//         sections: tickets.sort((a, b) => a.lowestPrice - b.lowestPrice)
//       };

//     } catch (error) {
//       console.error('Error fetching ticket prices:', error);
//       if (page) {
//         await page.screenshot({ path: 'ticket-prices-error.png', fullPage: true });
//       }
//       return {
//         totalSections: 0,
//         sections: []
//       };
//     } finally {
//       if (browser) {
//         await browser.close();
//       }
//     }
//   }

//   async searchConcerts(artist, venue, location) {
//     const browser = await puppeteer.launch({
//       headless: false,
//       executablePath: executablePath(),
//       args: [
//         '--no-sandbox',
//         '--disable-setuid-sandbox',
//         '--disable-blink-features=AutomationControlled',
//         '--window-size=1920,1080'
//       ],
//       defaultViewport: null
//     });

//     let page;

//     try {
//       page = await browser.newPage();
      
//       await page.setExtraHTTPHeaders({
//         'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
//         'Accept-Language': 'en-US,en;q=0.9',
//         'Accept-Encoding': 'gzip, deflate, br',
//         'Connection': 'keep-alive'
//       });

//       await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

//       const searchUrl = this.generateSearchUrl(artist, venue, location);
//       console.log('Searching VividSeats:', searchUrl);

//       await page.goto(searchUrl, {
//         waitUntil: 'networkidle0',
//         timeout: 30000
//       });

//       // Wait for the listings to load
//       await page.waitForSelector('[data-testid^="production-listing-"]', { timeout: 10000 });

//       // Extract and filter events
//       const concerts = await page.evaluate(({ artist, location }) => {
//         // Get all event listings
//         const events = Array.from(document.querySelectorAll('[data-testid^="production-listing-"]'));
        
//         return events.map(event => {
//           try {
//             // Get the title
//             const title = event.querySelector('.MuiTypography-small-medium')?.textContent?.trim() || '';
            
//             // Get date components
//             const dayOfWeek = event.querySelector('.MuiTypography-overline')?.textContent?.trim() || '';
//             const date = event.querySelector('.MuiTypography-small-bold')?.textContent?.trim() || '';
//             const time = event.querySelector('.MuiTypography-caption')?.textContent?.trim() || '';
            
//             // Get venue and location
//             const venueElement = event.querySelector('.MuiTypography-small-regular.styles_truncate__yWy53');
//             const locationElement = event.querySelector('.MuiTypography-small-regular.styles_truncate__yWy53:last-child');
            
//             const venue = venueElement?.textContent?.trim() || '';
//             const eventLocation = locationElement?.textContent?.trim() || '';
            
//             // Get the link (full URL)
//             const link = event.querySelector('a')?.href || '';

//             // Filter out parking tickets
//             if (title.toLowerCase().includes('parking')) {
//               return null;
//             }

//             return {
//               title,
//               date: `${date} ${dayOfWeek} ${time}`,
//               venue,
//               location: eventLocation,
//               link,
//               source: 'vividseats'
//             };
//           } catch (err) {
//             console.log('Error parsing VividSeats event:', err);
//             return null;
//           }
//         })
//         .filter(event => event !== null)
//         .filter(event => {
//           try {
//             // Case-insensitive exact match for artist name
//             const artistMatch = !artist || 
//               (event.title && event.title.toLowerCase() === artist.toLowerCase());
            
//             // Case-insensitive partial match for location
//             const locationMatch = !location || 
//               (event.location && event.location.toLowerCase().includes(location.toLowerCase()));
            
//             const hasValidLink = event.link && event.link.length > 0;
            
//             return artistMatch && locationMatch && hasValidLink;
//           } catch (err) {
//             console.log('Error filtering VividSeats event:', err);
//             return false;
//           }
//         });
//       }, { artist, location });

//       // Log the results for debugging
//       console.log(`Found ${concerts.length} matching VividSeats event(s) with valid links`);
      
//       // Remove duplicates
//       const uniqueConcerts = concerts.reduce((acc, current) => {
//         const key = `${current.title}-${current.venue}-${current.date}`;
//         if (!acc[key]) {
//           acc[key] = current;
//         }
//         return acc;
//       }, {});

//       // After finding concerts, get ticket prices for each one
//       const concertsWithPrices = [];
//       for (const concert of Object.values(uniqueConcerts)) {
//         const prices = await this.getTicketPrices(concert.link);
//         concertsWithPrices.push({
//           ...concert,
//           tickets: prices
//         });
//       }

//       return concertsWithPrices;

//     } catch (error) {
//       console.error('VividSeats error details:', error);
//       if (page) {
//         await page.screenshot({ path: 'vividseats-error.png', fullPage: true });
//       }
//       return [];
//     } finally {
//       if (browser) {
//         await browser.close();
//       }
//     }
//   }
// }

// async function main() {
//   const argv = yargs(hideBin(process.argv))
//     .option('artist', {
//       alias: 'a',
//       description: 'Artist name',
//       type: 'string'
//     })
//     .option('venue', {
//       alias: 'v',
//       description: 'Venue name',
//       type: 'string'
//     })
//     .option('location', {
//       alias: 'l',
//       description: 'Location (city, state)',
//       type: 'string'
//     })
//     .option('source', {
//       alias: 's',
//       description: 'Ticket source (stubhub or vividseats)',
//       type: 'string',
//       default: 'vividseats'  // Set VividSeats as default for testing
//     })
//     .check((argv) => {
//       if (!argv.artist && !argv.venue && !argv.location) {
//         throw new Error('At least one search parameter (artist, venue, or location) is required');
//       }
//       if (argv.source && !['stubhub', 'vividseats'].includes(argv.source.toLowerCase())) {
//         throw new Error('Source must be either "stubhub" or "vividseats"');
//       }
//       return true;
//     })
//     .argv;

//   let results = [];
  
//   try {
//     if (argv.source === 'vividseats') {
//       console.log('Testing VividSeats search...');
//       const searcher = new VividSeatsSearcher();
//       results = await searcher.searchConcerts(argv.artist, argv.venue, argv.location);
//     } else {
//       console.log('Testing StubHub search...');
//       const searcher = new StubHubSearcher();
//       results = await searcher.searchConcerts(argv.artist, argv.venue, argv.location);
//     }

//     // Format results
//     const output = {
//       query: {
//         artist: argv.artist,
//         venue: argv.venue,
//         location: argv.location,
//         source: argv.source
//       },
//       results: results,
//       timestamp: new Date().toISOString()
//     };

//     if (results.length > 0) {
//       console.log(JSON.stringify(output, null, 2));
//     } else {
//       console.log('No concerts found matching your criteria.');
//     }
//   } catch (error) {
//     console.error(`Error in ${argv.source} search:`, error);
//   }
// }

// if (require.main === module) {
//   main().catch(console.error);
// }

// module.exports = {
//   StubHubSearcher,
//   VividSeatsSearcher
// };