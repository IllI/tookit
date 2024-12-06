import { useState } from 'react';
import SearchForm from '@/components/search/SearchForm';
import TicketResults from '@/components/search/TicketResults';
import type { SearchParams, SearchResult } from '@/lib/types/api';

export default function Home() {
  const [searchResults, setSearchResults] = useState<SearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchStatus, setSearchStatus] = useState<string>('');
  const [lastUpdated, setLastUpdated] = useState(new Date());

  const handleSearch = async (params: SearchParams) => {
    setLoading(true);
    setError(null);
    setSearchStatus('Starting search...');
    setSearchResults(null);

    try {
      // Make a single POST request with SSE
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'text/event-stream',
        },
        body: JSON.stringify(params),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body');

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(5));
              console.log('SSE update received:', data);

              switch (data.type) {
                case 'status':
                  setSearchStatus(data.message);
                  break;
                
                case 'tickets':
                  setSearchResults(prev => ({
                    success: true,
                    data: prev?.data ? [...prev.data, ...data.tickets] : data.tickets,
                    metadata: prev?.metadata || {}
                  }));
                  setLastUpdated(new Date());
                  break;
                
                case 'error':
                  setError(data.error);
                  setLoading(false);
                  break;
                
                case 'complete':
                  setSearchResults({
                    success: true,
                    data: data.tickets,
                    metadata: data.metadata
                  });
                  setLoading(false);
                  break;
              }
            } catch (e) {
              console.error('Error parsing SSE message:', e);
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      console.error('Search error:', err);
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl font-bold text-gray-900 text-center mb-8">
            Tookit Ticket Search
          </h1>

          <div className="bg-white rounded-lg shadow p-6 mb-8">
            <SearchForm onSearch={handleSearch} isSearching={loading} />
          </div>

          {loading && (
            <div className="flex justify-center items-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
              <p className="ml-2 text-gray-600">{searchStatus}</p>
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