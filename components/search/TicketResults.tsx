import { SearchResult } from '@/lib/types/api';

interface TicketResultsProps {
  results: SearchResult;
  isLoading: boolean;
  lastUpdated: Date;
}

export default function TicketResults({ results, isLoading, lastUpdated }: TicketResultsProps) {
  if (!results?.data?.length && !isLoading) {
    return (
      <div className="p-4 text-center text-gray-500">
        No results found
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <div className="flex justify-between items-center text-sm text-gray-500 mb-4">
        <span>{results.data?.length || 0} results found</span>
        <span>Last updated: {lastUpdated.toLocaleTimeString()}</span>
      </div>

      <div className="space-y-4">
        {results.data?.map((item: any, index: number) => (
          <div key={index} className="border rounded-lg p-4 hover:shadow-md transition-shadow">
            <h3 className="font-semibold text-lg">{item.title || 'Event Title'}</h3>
            <p className="text-gray-600">{item.description || 'No description available'}</p>
            {item.price && (
              <p className="mt-2 text-green-600 font-medium">
                Starting at ${typeof item.price === 'number' ? item.price.toFixed(2) : item.price}
              </p>
            )}
          </div>
        ))}
      </div>

      {results.metadata?.error && (
        <div className="mt-4 p-4 bg-red-50 text-red-700 rounded-md">
          {results.metadata.error}
        </div>
      )}
    </div>
  );
}