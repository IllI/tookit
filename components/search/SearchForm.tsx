import React, { useState } from 'react';
import type { SearchParams } from '@/lib/types/api';

type SearchFormProps = {
  onSearch: (params: SearchParams) => void;
};

export default function SearchForm({ onSearch }: SearchFormProps) {
  const [params, setParams] = useState<SearchParams>({
    keyword: '',
    location: '',
    source: 'all'
  });

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    onSearch(params);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 max-w-lg mx-auto">
      <div className="form-group">
        <label 
          htmlFor="keyword" 
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Artist or Event Name
        </label>
        <input
          id="keyword"
          type="text"
          placeholder="e.g., Jamie XX"
          value={params.keyword}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => 
            setParams(p => ({ ...p, keyword: e.target.value }))
          }
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm 
                     focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
        />
      </div>

      <div className="form-group">
        <label 
          htmlFor="location" 
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Location
        </label>
        <input
          id="location"
          type="text"
          placeholder="e.g., Chicago"
          value={params.location}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => 
            setParams(p => ({ ...p, location: e.target.value }))
          }
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm 
                     focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
        />
      </div>

      <div className="form-group">
        <label 
          htmlFor="source" 
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Source
        </label>
        <select
          id="source"
          value={params.source}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => 
            setParams(p => ({ ...p, source: e.target.value as SearchParams['source'] }))
          }
          className="mt-1 block w-full rounded-md border-gray-300 shadow-sm 
                     focus:border-blue-500 focus:ring-blue-500 sm:text-sm"
        >
          <option value="all">All Sources</option>
          <option value="stubhub">StubHub</option>
          <option value="vividseats">VividSeats</option>
        </select>
      </div>

      <button
        type="submit"
        className="w-full flex justify-center py-2 px-4 border border-transparent 
                   rounded-md shadow-sm text-sm font-medium text-white 
                   bg-blue-600 hover:bg-blue-700 focus:outline-none focus:ring-2 
                   focus:ring-offset-2 focus:ring-blue-500"
      >
        Search Tickets
      </button>
    </form>
  );
}