import type { TicketData } from '@/lib/types/schemas';

interface TicketResultsProps {
  tickets: Array<{
    id: string;
    name: string;
    date: string;
    venue: string;
    location: {
      city: string;
      state: string;
      country: string;
    };
    section: string;
    row?: string;
    price: number;
    quantity: number;
    source: string;
    ticket_url: string;
  }>;
}

export function TicketResults({ tickets }: TicketResultsProps) {
  return (
    <div className="ticket-results">
      {tickets.map((ticket) => {
        // Format the price display
        const displayPrice = `$${ticket.price.toFixed(2)}`;

        // Format the date
        const displayDate = ticket.date || 'Date TBD';

        return (
          <div key={ticket.id} className="ticket-card">
            <div className="ticket-header">
              <h3>{ticket.name}</h3>
              <div className="ticket-date">{displayDate}</div>
            </div>
            <div className="ticket-details">
              <div className="venue">{ticket.venue}</div>
              <div className="location">
                {ticket.location?.city}, {ticket.location?.state}
              </div>
              <div className="section">Section {ticket.section}</div>
              {ticket.row && <div className="row">Row {ticket.row}</div>}
              <div className="price">Price: {displayPrice}</div>
              <div className="quantity">{ticket.quantity} available</div>
              <div className="source">via {ticket.source}</div>
            </div>
            <a 
              href={ticket.ticket_url}
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