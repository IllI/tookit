import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import StubHubSearcher from './stub-hub.js';
import { parse } from 'date-fns'; // Import parse from date-fns

dotenv.config();

const supabaseClient = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Function to check if an event exists based on name and date
async function eventExists(name, date) {
  try {
    const { data, error } = await supabaseClient
      .from('events')
      .select('id')
      .eq('name', name)
      .eq('date', date)
      .single();
    
    if (error && error.code !== 'PGRST116') { // PGRST116 means no rows found
      console.error('Error checking event existence:', error);
      return false;
    }
    
    return data ? data.id : null;
  } catch (err) {
    console.error('Exception in eventExists:', err);
    return false;
  }
}

// Function to check if a link exists for a specific event and source
async function linkExists(eventId, source) {
  try {
    const { data, error } = await supabaseClient
      .from('event_links')
      .select('id')
      .eq('event_id', eventId)
      .eq('source', source)
      .single();
    
    if (error && error.code !== 'PGRST116') {
      console.error('Error checking link existence:', error);
      return false;
    }
    
    return data ? data.id : null;
  } catch (err) {
    console.error('Exception in linkExists:', err);
    return false;
  }
}

// Function to insert an event and return its ID
async function insertEvent(event) {
  // Parse the date string into a proper Date object using date-fns
  const parsedDate = parse(event.date, 'MMM d yyyy h:mm a', new Date());

  // Log the date parsing result
  console.log(`Parsed Date Object: ${parsedDate} | Timestamp: ${parsedDate.getTime()}`);

  if (isNaN(parsedDate)) {
    console.error('Invalid Date object:', event.date);
    return null;
  }

  // Check if the event already exists
  const existingEventId = await eventExists(event.name, parsedDate.toISOString());
  if (existingEventId) {
    console.log(`Event "${event.name}" on ${parsedDate.toISOString()} already exists with ID ${existingEventId}.`);
    return existingEventId;
  }

  const eventData = {
    name: event.name,
    type: event.type || 'Concert',
    category: event.category || 'Unknown',
    date: parsedDate.toISOString(), // Convert to ISO string for PostgreSQL
    venue: event.venue
  };

  console.log('Attempting to insert event:', eventData);

  const { data, error } = await supabaseClient
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

// Function to insert an event link
async function insertEventLink(eventId, source, url) {
  // Check if the link already exists to prevent duplicates
  const existingLinkId = await linkExists(eventId, source);
  if (existingLinkId) {
    console.log(`Event link from ${source} already exists for event ID ${eventId}.`);
    return url; // Return existing link URL
  }

  const linkData = {
    event_id: eventId,
    source: source,
    url: url
  };

  const { data, error } = await supabaseClient
    .from('event_links')
    .insert([linkData])
    .select('id');

  if (error) {
    console.error(`Error inserting event link (${source}):`, error);
    return null;
  }

  console.log(`Inserted event link (${source}):`, data[0].id);
  return url; // Return the URL instead of link id
}

// Function to insert tickets
async function insertTickets(eventId, tickets) {
  try {
    if (!tickets || !tickets.sections || !Array.isArray(tickets.sections)) {
      console.error('Invalid tickets data structure:', tickets);
      return;
    }

    // Fetch existing tickets for comparison
    const { data: existingTickets, error: fetchError } = await supabaseClient
      .from('tickets')
      .select('id, url')
      .eq('event_id', eventId);
    
    if (fetchError) {
      console.error('Error fetching existing tickets:', fetchError);
      return;
    }
    
    const existingTicketURLs = new Set(existingTickets?.map(ticket => ticket.url) || []);
    
    // Filter out tickets that already exist
    const newTickets = tickets.sections.flatMap(section => 
      (section.tickets || [])
        .filter(ticket => !existingTicketURLs.has(ticket.listingUrl))
        .map(ticket => ({
          event_id: eventId,
          price: ticket.rawPrice,
          type: section.category,
          section: section.section,
          row: ticket.row || null,
          quantity: parseInt(ticket.quantity, 10) || 1,
          source: 'stubhub',
          url: ticket.listingUrl,
          raw_data: ticket
        }))
    );
    
    if (newTickets.length === 0) {
      console.log('No new tickets to insert.');
      return;
    }
    
    const { data, error } = await supabaseClient
      .from('tickets')
      .insert(newTickets);
    
    if (error) {
      console.error('Error inserting tickets:', error);
    } else {
      console.log('Inserted tickets:', newTickets.length);
    }
  } catch (err) {
    console.error('Exception in insertTickets:', err);
  }
}

// Function to remove tickets no longer available
async function removeUnavailableTickets(eventId, scrapedTicketURLs) {
  try {
    const { data: existingTickets, error: fetchError } = await supabaseClient
      .from('tickets')
      .select('id, url')
      .eq('event_id', eventId)
      .eq('source', 'stubhub');  // Only get StubHub tickets
    
    if (fetchError) {
      console.error('Error fetching existing tickets for removal:', fetchError);
      return;
    }
    
    const scrapedTicketsSet = new Set(scrapedTicketURLs);
    
    const ticketsToRemove = existingTickets.filter(ticket => !scrapedTicketsSet.has(ticket.url));
    
    if (ticketsToRemove.length === 0) {
      console.log('No StubHub tickets to remove.');
      return;
    }
    
    const ticketIdsToRemove = ticketsToRemove.map(ticket => ticket.id);
    
    const { error } = await supabaseClient
      .from('tickets')
      .delete()
      .in('id', ticketIdsToRemove)
      .eq('source', 'stubhub');  // Extra safety check to only delete StubHub tickets
    
    if (error) {
      console.error('Error removing unavailable StubHub tickets:', error);
    } else {
      console.log(`Removed ${ticketsToRemove.length} unavailable StubHub tickets.`);
    }
  } catch (err) {
    console.error('Exception in removeUnavailableTickets:', err);
  }
}

async function mainSearch(artist, venue, location) {
  // First, try to find the event in the database
  try {
    // Search for events matching the artist name
    const { data: existingEvents, error: searchError } = await supabaseClient
      .from('events')
      .select(`
        id,
        name,
        date,
        event_links (
          url,
          source
        )
      `)
      .ilike('name', `%${artist}%`);

    if (searchError) {
      console.error('Error searching for existing events:', searchError);
    } else if (existingEvents && existingEvents.length > 0) {
      console.log('Found existing events in database:', existingEvents.length);
      
      // Find the StubHub link for the event
      for (const event of existingEvents) {
        const stubHubLink = event.event_links.find(link => link.source === 'stubhub')?.url;
        
        if (stubHubLink) {
          console.log(`Found existing StubHub link for event "${event.name}": ${stubHubLink}`);
          
          // Create a new StubHubSearcher instance just for getting ticket prices
          const searcher = new StubHubSearcher();
          const tickets = await searcher.getTicketPrices(stubHubLink);
          
          if (tickets && tickets.totalSections > 0) {
            await insertTickets(event.id, tickets);

            // Collect all scraped ticket URLs for removal logic
            const scrapedTicketURLs = tickets.sections.flatMap(section =>
              section.tickets.map(ticket => ticket.listingUrl)
            );

            // Remove tickets that are no longer available
            await removeUnavailableTickets(event.id, scrapedTicketURLs);
          } else {
            console.log(`No tickets found for event "${event.name}". Consider marking it as sold or removing it.`);
          }
          
          // We found and processed the event, no need to continue
          return;
        }
      }
    }

    // If we didn't find the event or couldn't process existing events, proceed with the web scraping
    console.log('No existing event found in database, proceeding with web scraping...');
    
    const searcher = new StubHubSearcher();
    const eventsWithTickets = await searcher.searchConcerts(artist, venue, location);

    console.log('Events with Tickets:', JSON.stringify(eventsWithTickets, null, 2));

    for (const event of eventsWithTickets) {
      console.log('Processing Event:', JSON.stringify(event, null, 2));
      
      const eventId = await insertEvent(event);
      if (eventId) {
        if (event.source === 'stubhub' && event.link) {
          const stubhubLink = await insertEventLink(eventId, 'stubhub', event.link);
          
          if (event.tickets && event.tickets.totalSections > 0) {
            await insertTickets(eventId, event.tickets);

            // Collect all scraped ticket URLs for removal logic
            const scrapedTicketURLs = event.tickets.sections.flatMap(section =>
              section.tickets.map(ticket => ticket.listingUrl)
            );

            // Remove tickets that are no longer available
            await removeUnavailableTickets(eventId, scrapedTicketURLs);
          } else {
            console.log(`No tickets found for event "${event.name}". Consider marking it as sold or removing it.`);
          }
        } else {
          console.warn(`No StubHub link found for event "${event.name}".`);
        }
      }
    }
  } catch (error) {
    console.error('Error in mainSearch:', error);
  }
}

// Replace with your actual search parameters
mainSearch('jamie xx', '', 'Chicago')
  .then(() => console.log('Search and insertion completed'))
  .catch(err => console.error('Error in mainSearch:', err)); 