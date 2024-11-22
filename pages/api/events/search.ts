import { NextApiRequest, NextApiResponse } from 'next';
import { searchService } from '@/lib/services/search-service';
import type { SearchParams, SearchResult } from '@/lib/types/api';
import { logger } from '@/lib/utils/logger';

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
    const params = req.body as SearchParams;
    logger.info('Search request received', params);

    const result = await searchService.searchAll({
      ...params,
      source: 'all'
    });

    return res.status(result.success ? 200 : 500).json(result);
  } catch (error) {
    logger.error('API error:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      metadata: {
        error: error instanceof Error ? error.message : 'Unknown error'
      }
    });
  }
} 