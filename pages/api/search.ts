import { NextApiRequest, NextApiResponse } from 'next';
import StubHubSearcher from '../../src/stub-hub';
import VividSeatsSearcher from '../../src/vivid-seats';
import { createClient } from '@supabase/supabase-js';
import { config } from '../../src/config/env';
import type { SearchParams, SearchResult } from '@/lib/types/api';
import { findMatchingEvent } from '../../src/event-utils';
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

    const supabase = createClient(
      config.supabase.url,
      config.supabase.serviceKey
    );

    const stubHubSearcher = new StubHubSearcher();
    const vividSeatsSearcher = new VividSeatsSearcher();

    // ... rest of your handler code
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