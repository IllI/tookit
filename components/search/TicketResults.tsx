import { SearchResult, Event, Ticket, TicketSource } from '@/lib/types/api';
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
    const aPrice = Math.min(...(a.tickets || []).map(t => t.price));
    const bPrice = Math.min(...(b.tickets || []).map(t => t.price));
    return aPrice - bPrice;
  });

  const getSourceStatus = (source: TicketSource) => {
    if (source.error) {
      return (
        <span className="text-red-500 text-xs">
          Error updating • Last updated {formatDistanceToNow(new Date(source.lastUpdated))} ago
        </span>
      );
    }
    return source.isLive ? (
      <span className="text-green-500 text-xs">Live prices</span>
    ) : (
      <span className="text-yellow-500 text-xs">
        Cached • Last updated {formatDistanceToNow(new Date(source.lastUpdated))} ago
      </span>
    );
  };

  return (
    <div className="mt-8">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold">
          Found {results.data.length} events
        </h2>
        <div className="text-sm space-y-1">
          {results.metadata.sources && (
            <>
              <div>
                StubHub: {getSourceStatus(results.metadata.sources.stubhub)}
              </div>
              <div>
                VividSeats: {getSourceStatus(results.metadata.sources.vividseats)}
              </div>
            </>
          )}
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
                  ${Math.min(...event.tickets.map(t => t.price))}
                </p>
              </div>
            </div>

            <div className="grid gap-2">
              {event.tickets.map((ticket) => (
                <div 
                  key={ticket.id} 
                  className={`flex justify-between items-center p-2 rounded transition-colors ${
                    ticket.source === 'stubhub' 
                      ? 'bg-blue-50 hover:bg-blue-100' 
                      : 'bg-purple-50 hover:bg-purple-100'
                  }`}
                >
                  <div>
                    <p className="text-sm text-gray-600">
                      {ticket.section} • {ticket.quantity} tickets
                      {ticket.row ? ` • Row ${ticket.row}` : ''}
                      {ticket.dealScore ? ` • Deal Score: ${ticket.dealScore}` : ''}
                    </p>
                    {!results.metadata.sources?.[ticket.source]?.isLive && (
                      <p className="text-xs text-yellow-600">
                        Price from {formatDistanceToNow(new Date(results.metadata.sources?.[ticket.source]?.lastUpdated))} ago
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    <a
                      href={ticket.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-block"
                    >
                      <p className="font-semibold text-blue-600 hover:text-blue-800">
                        ${ticket.price}
                      </p>
                      <p className="text-xs text-gray-500">
                        Buy on {ticket.source}
                      </p>
                    </a>
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