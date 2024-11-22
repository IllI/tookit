import { useState } from 'react';
import type { SearchParams } from '@/lib/types/api';

export default function SearchForm({ onSearch }: { onSearch: (params: SearchParams) => void }) {
  const [params, setParams] = useState<SearchParams>({
    keyword: '',
    location: '',
    source: 'all'
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(params);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label htmlFor="keyword" className="block text-sm font-medium text-gray-700">
          Artist or Event Name
        </label>
        <input
          id="keyword"
          type="text"
          placeholder="e.g., Jamie XX"
          value={params.keyword}
          onChange={e => setParams(p => ({ ...p, keyword: e.target.value }))}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
        />
      </div>

      <div>
        <label htmlFor="location" className="block text-sm font-medium text-gray-700">
          Location
        </label>
        <input
          id="location"
          type="text"
          placeholder="e.g., Chicago"
          value={params.location}
          onChange={e => setParams(p => ({ ...p, location: e.target.value }))}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
        />
      </div>

      <div>
        <label htmlFor="source" className="block text-sm font-medium text-gray-700">
          Source
        </label>
        <select
          id="source"
          value={params.source}
          onChange={e => setParams(p => ({ ...p, source: e.target.value as SearchParams['source'] }))}
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500"
        >
          <option value="all">All Sources</option>
          <option value="stubhub">StubHub</option>
          <option value="vividseats">VividSeats</option>
        </select>
      </div>

      <button
        type="submit"
        className="w-full rounded-md bg-blue-600 px-4 py-2 text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
      >
        Search Tickets
      </button>
    </form>
  );
}