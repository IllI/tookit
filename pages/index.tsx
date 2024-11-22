import { useState, useEffect } from 'react';
import SearchForm from '@/components/search/SearchForm';
import TicketResults from '@/components/search/TicketResults';
import { SearchParams, SearchResult } from '@/lib/types/api';
import { logger } from '@/lib/utils/logger';

export default function Home() {
  const [searchResults, setSearchResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSearchParams, setLastSearchParams] = useState<SearchParams | null>(null);

  // Function to perform search
  const handleSearch = async (params: SearchParams) => {
    setLoading(true);
    setError(null);
    setLastSearchParams(params);

    try {
      const response = await fetch('/api/events/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params)
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Search failed');
      
      setSearchResults(data);
      logger.info('Search completed', data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      logger.error('Search error', err);
    } finally {
      setLoading(false);
    }
  };

  // Auto-refresh results every 2 minutes if we have active search
  useEffect(() => {
    if (!lastSearchParams) return;

    const intervalId = setInterval(() => {
      logger.info('Auto-refreshing results');
      handleSearch(lastSearchParams);
    }, 120000); // 2 minutes

    return () => clearInterval(intervalId);
  }, [lastSearchParams]);

  return (
    <div className="container mx-auto p-4">
      <h1 className="text-3xl font-bold mb-8">Ticket Search</h1>
      
      <SearchForm onSearch={handleSearch} />
      
      {loading && (
        <div className="my-4 text-center">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 mx-auto"></div>
          <p className="mt-2">Searching tickets...</p>
        </div>
      )}
      
      {error && (
        <div className="my-4 p-4 bg-red-100 text-red-700 rounded">
          {error}
        </div>
      )}
      
      {searchResults && (
        <TicketResults 
          results={searchResults} 
          isLoading={loading}
          lastUpdated={new Date()}
        />
      )}
    </div>
  );
}