import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { parse } from 'date-fns';

dotenv.config();

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function testInsert() {
  const eventData = {
    name: 'Test Event',
    type: 'Concert',
    category: 'Rock',
    date: parse('Nov 23 2024 8:00 PM', 'MMM d yyyy h:mm a', new Date()).toISOString(),
    venue: 'Test Venue',
    source: 'stubhub',
    link: 'https://www.stubhub.com/test-event',
    tickets: {
      totalSections: 1,
      sections: [{
        section: 'General Admission',
        category: 'Concert',
        tickets: [{
          listingUrl: 'https://www.stubhub.com/test-event/ticket1',
          rawPrice: 150
        }]
      }]
    }
  };

  // Insert Event
  const { data: insertedEvent, error: insertError } = await supabase
    .from('events')
    .insert({
      name: eventData.name,
      type: eventData.type,
      category: eventData.category,
      date: eventData.date,
      venue: eventData.venue
    })
    .select('id');
  
  if (insertError) {
    console.error('Insert Event Error:', insertError);
    return;
  }

  const eventId = insertedEvent[0].id;
  console.log('Inserted Event ID:', eventId);

  // Insert Event Link
  const { data: insertedLink, error: linkError } = await supabase
    .from('event_links')
    .insert({
      event_id: eventId,
      source: eventData.source,
      url: eventData.link
    })
    .select('id');
  
  if (linkError) {
    console.error('Insert Link Error:', linkError);
  } else {
    console.log('Inserted Link ID:', insertedLink[0].id);
  }

  // Insert Tickets
  const { data: insertedTickets, error: ticketError } = await supabase
    .from('tickets')
    .insert(eventData.tickets.sections.flatMap(section => 
      section.tickets.map(ticket => ({
        event_id: eventId,
        price: ticket.rawPrice,
        type: section.category,
        section: section.section,
        row: ticket.row || null,
        quantity: ticket.quantity || 1,
        source: eventData.source,
        url: ticket.listingUrl,
        raw_data: ticket
      }))
    ))
    .select('id');
  
  if (ticketError) {
    console.error('Insert Tickets Error:', ticketError);
  } else {
    console.log('Inserted Tickets:', insertedTickets.length);
  }
}

testInsert(); 