import { SearchResult, Event, Ticket } from '@/lib/types/api';
import { formatDistanceToNow } from 'date-fns';

interface TicketResultsProps {
  results: SearchResult;
  isLoading: boolean;
  lastUpdated: Date;
}

export default function TicketResults({ results, isLoading, lastUpdated }: TicketResultsProps) {
  if (!results.data || results.data.length === 0) {
    return <div className="mt-8">No tickets found</div>;
  }

  // Sort events by lowest ticket price
  const sortedEvents = [...results.data].sort((a, b) => {
    const aPrice = Math.min(...(a.tickets?.sections || []).flatMap(s => s.tickets.map(t => t.rawPrice)));
    const bPrice = Math.min(...(b.tickets?.sections || []).flatMap(s => s.tickets.map(t => t.rawPrice)));
    return aPrice - bPrice;
  });

  return (
    <div className="mt-8">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">
          Found {results.data.length} events
        </h2>
        <div className="text-sm text-gray-500">
          Last updated {formatDistanceToNow(lastUpdated)} ago
        </div>
      </div>

      <div className="space-y-8">
        {sortedEvents.map((event) => (
          <div key={event.id} className="border rounded-lg p-4 shadow-sm">
            <div className="flex justify-between items-start mb-4">
              <div>
                <h3 className="text-lg font-semibold">{event.name}</h3>
                <p className="text-gray-600">{event.venue}</p>
                <p className="text-sm text-gray-500">
                  {new Date(event.date).toLocaleDateString()} at{' '}
                  {new Date(event.date).toLocaleTimeString()}
                </p>
              </div>
              <div className="text-right">
                <p className="text-sm text-gray-500">Starting from</p>
                <p className="text-xl font-bold text-green-600">
                  ${Math.min(...(event.tickets?.sections || []).flatMap(s => s.tickets.map(t => t.rawPrice)))}
                </p>
              </div>
            </div>

            <div className="space-y-2">
              {event.tickets?.sections?.map((section) => (
                <div key={section.section} className="border-t pt-2">
                  <h4 className="font-medium text-gray-700">{section.section}</h4>
                  <div className="space-y-1">
                    {section.tickets.map((ticket, idx) => (
                      <div 
                        key={ticket.listingId || idx} 
                        className="flex justify-between items-center p-2 bg-gray-50 rounded"
                      >
                        <div>
                          <p className="text-sm text-gray-600">
                            {ticket.quantity} • 
                            {ticket.row ? ` Row ${ticket.row} • ` : ' '}
                            {ticket.dealScore ? `Deal Score: ${ticket.dealScore}` : ''}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-semibold">${ticket.rawPrice}</p>
                          <p className="text-xs text-gray-500">{event.source}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>

            <div className="mt-4 flex gap-2">
              {event.links?.map((link) => (
                <a
                  key={link.id}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-blue-600 hover:underline"
                >
                  View on {link.source}
                </a>
              ))}
            </div>
          </div>
        ))}
      </div>

      {isLoading && (
        <div className="mt-4 text-center text-sm text-gray-500">
          Refreshing results...
        </div>
      )}
    </div>
  );
} 