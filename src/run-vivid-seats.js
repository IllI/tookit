import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import VividSeatsSearcher from './vivid-seats.js';
import { parse } from 'date-fns';
import { findMatchingEvent } from './event-utils.js';

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
  // Parse VividSeats date format (e.g., "Jan 17 Fri 7:00pm")
  const dateRegex = /([A-Za-z]+)\s+(\d+)\s+[A-Za-z]+\s+(\d+:\d+[ap]m)/i;
  const match = event.date.match(dateRegex);
  
  if (!match) {
    console.error('Could not parse date format:', event.date);
    return null;
  }

  const [_, month, day, time] = match;
  const year = '2025'; // Default to 2025 for future dates
  const standardDateStr = `${month} ${day} ${year} ${time}`;
  
  console.log('Standardized date string:', standardDateStr);
  const parsedDate = parse(standardDateStr, 'MMM d yyyy h:mma', new Date());

  console.log(`Parsed Date Object: ${parsedDate} | Timestamp: ${parsedDate.getTime()}`);

  if (isNaN(parsedDate)) {
    console.error('Invalid Date object:', standardDateStr);
    return null;
  }

  // Check if the event already exists
  const existingEventId = await eventExists(event.title || event.name, parsedDate.toISOString());
  if (existingEventId) {
    console.log(`Event "${event.title || event.name}" on ${parsedDate.toISOString()} already exists with ID ${existingEventId}.`);
    return existingEventId;
  }

  const eventData = {
    name: event.title || event.name,
    type: 'Concert',
    category: 'Concert',
    date: parsedDate.toISOString(),
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
          source: 'vividseats',
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
      .eq('source', 'vividseats');
    
    if (fetchError) {
      console.error('Error fetching existing tickets for removal:', fetchError);
      return;
    }
    
    const scrapedTicketsSet = new Set(scrapedTicketURLs);
    
    const ticketsToRemove = existingTickets.filter(ticket => !scrapedTicketsSet.has(ticket.url));
    
    if (ticketsToRemove.length === 0) {
      console.log('No VividSeats tickets to remove.');
      return;
    }
    
    const ticketIdsToRemove = ticketsToRemove.map(ticket => ticket.id);
    
    const { error } = await supabaseClient
      .from('tickets')
      .delete()
      .in('id', ticketIdsToRemove)
      .eq('source', 'vividseats');
    
    if (error) {
      console.error('Error removing unavailable VividSeats tickets:', error);
    } else {
      console.log(`Removed ${ticketsToRemove.length} unavailable VividSeats tickets.`);
    }
  } catch (err) {
    console.error('Exception in removeUnavailableTickets:', err);
  }
}

async function mainSearch(artist, venue, location) {
  try {
    const searcher = new VividSeatsSearcher();
    const eventsWithTickets = await searcher.searchConcerts(artist, venue, location);

    for (const event of eventsWithTickets) {
      // Use findMatchingEvent to check for existing event
      const matchingEvent = await findMatchingEvent(supabaseClient, {
        name: event.title,
        date: event.date,
        venue: event.venue
      }, 'vividseats');

      if (matchingEvent) {
        console.log(`Found matching event: "${matchingEvent.name}"`);
        
        if (!matchingEvent.hasSourceLink) {
          // Add VividSeats link to existing event
          console.log('Adding VividSeats link to existing event');
          await insertEventLink(matchingEvent.id, 'vividseats', event.link);
        }

        // Update tickets regardless of whether we just added the link
        if (event.tickets && event.tickets.totalSections > 0) {
          await insertTickets(matchingEvent.id, event.tickets);

          const scrapedTicketURLs = event.tickets.sections.flatMap(section =>
            section.tickets.map(ticket => ticket.listingUrl)
          );

          await removeUnavailableTickets(matchingEvent.id, scrapedTicketURLs);
        }
      } else {
        // Create new event if no match found
        const eventId = await insertEvent(event);
        if (eventId) {
          await insertEventLink(eventId, 'vividseats', event.link);
          
          if (event.tickets && event.tickets.totalSections > 0) {
            await insertTickets(eventId, event.tickets);
          }
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