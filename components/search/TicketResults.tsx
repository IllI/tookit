import { SearchResult } from '@/lib/types/api';

interface Ticket {
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
  ticket_url?: string;
}

interface TicketResultsProps {
  results: {
    success: boolean;
    data: Ticket[];
    metadata: { sources: string[] };
  };
  isLoading: boolean;
  lastUpdated: Date;
}

export default function TicketResults({ results, isLoading, lastUpdated }: TicketResultsProps) {
  const formatDate = (dateString: string) => {
    if (!dateString) return 'Date TBD';
    
    try {
      // Parse the ISO string manually to avoid timezone conversion
      const match = dateString.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
      if (!match) return 'Date TBD';

      const [_, year, month, day, hour, minute] = match;
      
      // Create the date parts
      const weekday = new Date(`${year}-${month}-${day}`).toLocaleDateString('en-US', { weekday: 'long' });
      const monthName = new Date(`${year}-${month}-${day}`).toLocaleDateString('en-US', { month: 'long' });
      
      // Format hour for 12-hour clock
      const hourNum = parseInt(hour);
      const hour12 = hourNum % 12 || 12;
      const ampm = hourNum >= 12 ? 'PM' : 'AM';

      return `${weekday}, ${monthName} ${parseInt(day)}, ${year} at ${hour12}:${minute} ${ampm}`;
    } catch (error) {
      console.error('Error formatting date:', error);
      return 'Date TBD';
    }
  };

  const formatPrice = (price: number) => {
    try {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD'
      }).format(price);
    } catch (e) {
      return '$0.00';
    }
  };

  if (!results?.data?.length) {
    return (
      <div className="p-4 text-center text-gray-500">
        No tickets found
      </div>
    );
  }

  return (
    <div className="divide-y divide-gray-200">
      {results.data.map((ticket) => (
        <a
          key={ticket.id}
          href={ticket.ticket_url || '#'}
          target="_blank"
          rel="noopener noreferrer"
          className="block p-4 hover:bg-gray-50 transition duration-150 ease-in-out"
        >
          <div className="flex justify-between items-start">
            <div>
              <h3 className="text-lg font-medium text-gray-900">
                {ticket.name}
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                {formatDate(ticket.date)}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {ticket.venue}
              </p>
              <p className="mt-2 text-sm text-gray-500">
                Section {ticket.section} {ticket.row ? `Row ${ticket.row}` : ''}
              </p>
            </div>
            <div className="text-right">
              <p className="text-lg font-medium text-gray-900">
                {formatPrice(ticket.price)}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {ticket.quantity} available
              </p>
              <p className="mt-1 text-xs text-gray-400">
                via {ticket.source}
              </p>
            </div>
          </div>
          <div className="mt-2 text-sm text-blue-600">
            View Tickets →
          </div>
        </a>
      ))}
      <div className="p-4 text-sm text-gray-500 text-right">
        Last updated: {lastUpdated.toLocaleTimeString()}
      </div>
    </div>
  );
} 