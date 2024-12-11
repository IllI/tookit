import { Event, Ticket } from '@/lib/types/api';

interface TicketResultsProps {
  tickets: Event[];
}

export function TicketResults({ tickets }: TicketResultsProps) {
  return (
    <div className="ticket-results">
      {tickets.map((event) => {
        // Format the price display
        const price = typeof event.price === 'number' 
          ? `$${event.price.toFixed(2)}` 
          : event.price;

        // Get lowest price from tickets array if available
        const lowestPrice = event.tickets?.length 
          ? Math.min(...event.tickets.map(t => t.price))
          : null;

        const displayPrice = lowestPrice 
          ? `$${lowestPrice.toFixed(2)}` 
          : price || 'Check website';

        // Format the date
        const displayDate = event.date === 'Date TBD' 
          ? 'Date TBD'
          : event.date;

        // Get the correct base URL based on source
        const baseUrl = event.source === 'stubhub' 
          ? 'https://www.stubhub.com'
          : 'https://www.vividseats.com';

        // Construct full URL with fallback
        const fullUrl = event.eventUrl
          ? (event.eventUrl.startsWith('http') 
              ? event.eventUrl 
              : `${baseUrl}${event.eventUrl}`)
          : `${baseUrl}/search?q=${encodeURIComponent(`${event.name} ${event.venue}`)}`;

        return (
          <div key={event.id} className="ticket-card">
            <div className="ticket-header">
              <h3>{event.name}</h3>
              <div className="ticket-date">{displayDate}</div>
            </div>
            <div className="ticket-details">
              <div className="venue">{event.venue}</div>
              <div className="location">{event.location}</div>
              <div className="price">Starting at {displayPrice}</div>
              <div className="source">via {event.source}</div>
              {event.tickets && event.tickets.length > 0 && (
                <div className="ticket-count">
                  {event.tickets.length} tickets available
                </div>
              )}
            </div>
            <a 
              href={fullUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="view-tickets-btn"
            >
              View Tickets →
            </a>
          </div>
        );
      })}
    </div>
  );
} 