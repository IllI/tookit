import { useState } from 'react';
import SearchForm from '@/components/search/SearchForm';
import TicketResults from '@/components/search/TicketResults';
import type { SearchParams, SearchResult } from '@/lib/types/api';

export default function Home() {
  const [searchResults, setSearchResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const handleSearch = async (params: SearchParams) => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/events/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const data = await response.json();
      setSearchResults(data);
      setLastUpdated(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      console.error('Search error:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl font-bold text-gray-900 text-center mb-8">
            Ticket Search
          </h1>

          <div className="bg-white rounded-lg shadow p-6 mb-8">
            <SearchForm onSearch={handleSearch} />
          </div>

          {loading && (
            <div className="flex justify-center items-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <p className="ml-2 text-gray-600">Searching tickets...</p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-8">
              <p className="text-red-700">{error}</p>
            </div>
          )}

          {searchResults && (
            <div className="bg-white rounded-lg shadow">
              <TicketResults 
                results={searchResults} 
                isLoading={loading}
                lastUpdated={lastUpdated}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}