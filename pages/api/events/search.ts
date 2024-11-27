import type { NextApiRequest, NextApiResponse } from 'next';
import { SearchService } from '@/lib/services/search-service';
import type { SearchResult } from '@/lib/types/api';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<SearchResult>
) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      success: false,
      error: 'Method not allowed',
      metadata: {}
    });
  }

  try {
    const searchService = new SearchService();
    const result = await searchService.searchAll(req.body);
    return res.status(200).json(result);
  } catch (error) {
    console.error('[ERROR] API error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      metadata: {
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    });
  }
} 