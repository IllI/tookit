#!/usr/bin/env node

const yargs = require('yargs/yargs');
const { hideBin } = require('yargs/helpers');
const { StubHubSearcher, VividSeatsSearcher } = require('./index.js');

async function testSearch(options) {
  const { artist, venue, location, source, debug } = options;

  if (debug) {
    console.log('Debug mode enabled');
    console.log('Search parameters:', { artist, venue, location, source });
  }

  try {
    let results = [];
    console.log(`Testing ${source} search...`);

    if (source.toLowerCase() === 'vividseats') {
      const searcher = new VividSeatsSearcher();
      results = await searcher.searchConcerts(artist, venue, location);
    } else if (source.toLowerCase() === 'stubhub') {
      const searcher = new StubHubSearcher();
      results = await searcher.searchConcerts(artist, venue, location);
    }

    const output = {
      query: {
        artist,
        venue,
        location,
        source
      },
      results,
      timestamp: new Date().toISOString()
    };

    if (results.length > 0) {
      if (debug) {
        console.log('\nDetailed Results:');
        results.forEach((event, index) => {
          console.log(`\nEvent ${index + 1}:`);
          console.log('Title:', event.title);
          console.log('Date:', event.date);
          console.log('Venue:', event.venue);
          console.log('Location:', event.location);
          console.log('Link:', event.link);
          
          if (event.tickets) {
            console.log('\nTicket Information:');
            console.log(`Total Sections: ${event.tickets.totalSections}`);
            event.tickets.sections.forEach(section => {
              console.log(`\nSection: ${section.section}`);
              console.log(`Price Range: $${section.lowestPrice} - $${section.highestPrice}`);
              console.log(`Available Listings: ${section.numberOfListings}`);
            });
          }
        });
      }
      
      console.log('\nFull Results:');
      console.log(JSON.stringify(output, null, 2));
    } else {
      console.log('No concerts found matching your criteria.');
    }

  } catch (error) {
    console.error(`Error in ${source} search:`, error);
    if (debug) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

async function main() {
  const argv = yargs(process.argv.slice(2))  // Changed from hideBin
    .usage('Usage: $0 [options]')
    .option('artist', {
      alias: 'a',
      description: 'Artist name',
      type: 'string'
    })
    .option('venue', {
      alias: 'v',
      description: 'Venue name',
      type: 'string'
    })
    .option('location', {
      alias: 'l',
      description: 'Location (city, state)',
      type: 'string'
    })
    .option('source', {
      alias: 's',
      description: 'Ticket source (stubhub or vividseats)',
      type: 'string',
      default: 'vividseats'
    })
    .option('debug', {
      alias: 'd',
      description: 'Enable debug mode',
      type: 'boolean',
      default: false
    })
    .check((argv) => {
      if (!argv.artist && !argv.venue && !argv.location) {
        throw new Error('At least one search parameter (artist, venue, or location) is required');
      }
      if (argv.source && !['stubhub', 'vividseats'].includes(argv.source.toLowerCase())) {
        throw new Error('Source must be either "stubhub" or "vividseats"');
      }
      return true;
    })
    .help()
    .alias('help', 'h')
    .argv;

  await testSearch(argv);
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = { testSearch };