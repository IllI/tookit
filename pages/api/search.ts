import { NextApiRequest, NextApiResponse } from 'next';
import StubHubSearcher from '@/lib/stub-hub';
import VividSeatsSearcher from '@/lib/vivid-seats';

// Type definitions for our API
type SearchParams = {
  keyword?: string;
  artist?: string;
  venue?: string;
  location?: string;
  date?: string;
};

type SearchResponse = {
  success: boolean;
  data?: any[];
  error?: string;
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<SearchResponse>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { keyword, artist, venue, location, date } = req.body as SearchParams;

    // Initialize searchers
    const stubHubSearcher = new StubHubSearcher();
    const vividSeatsSearcher = new VividSeatsSearcher();

    // Run searches in parallel
    const [stubHubResults, vividSeatsResults] = await Promise.all([
      stubHubSearcher.searchConcerts(artist || keyword || '', venue || '', location || ''),
      vividSeatsSearcher.searchConcerts(artist || keyword || '', venue || '', location || '')
    ]);

    // Combine and normalize results
    const allResults = [
      ...stubHubResults.map(event => ({
        ...event,
        source: 'StubHub',
        lowestPrice: event.tickets?.sections?.reduce((min, section) => 
          Math.min(min, section.lowestPrice || Infinity), Infinity) || null
      })),
      ...vividSeatsResults.map(event => ({
        ...event,
        source: 'VividSeats',
        lowestPrice: event.tickets?.sections?.reduce((min, section) => 
          Math.min(min, section.lowestPrice || Infinity), Infinity) || null
      }))
    ];

    // Sort by price
    const sortedResults = allResults.sort((a, b) => {
      if (a.lowestPrice === null) return 1;
      if (b.lowestPrice === null) return -1;
      return a.lowestPrice - b.lowestPrice;
    });

    return res.status(200).json({
      success: true,
      data: sortedResults
    });

  } catch (error) {
    console.error('Search error:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to perform search'
    });
  }
}