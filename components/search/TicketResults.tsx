import { SearchResult } from '@/lib/types/api';

interface TicketResultsProps {
  results: SearchResult;
  isLoading: boolean;
  lastUpdated: Date;
}

export default function TicketResults({ results, isLoading, lastUpdated }: TicketResultsProps) {
  const formatDate = (dateString: string) => {
    try {
      const date = new Date(dateString);
      return date.toLocaleDateString('en-US', {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric'
      });
    } catch (e) {
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
        <div key={ticket.id} className="p-4 hover:bg-gray-50">
          <div className="flex justify-between items-start">
            <div>
              <h3 className="text-lg font-medium text-gray-900">
                {ticket.event?.name}
              </h3>
              <p className="mt-1 text-sm text-gray-500">
                {formatDate(ticket.event?.date)}
              </p>
              <p className="mt-1 text-sm text-gray-500">
                {ticket.event?.venue}
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
        </div>
      ))}
      <div className="p-4 text-sm text-gray-500 text-right">
        Last updated: {lastUpdated.toLocaleTimeString()}
      </div>
    </div>
  );
} 