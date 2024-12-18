import type { NextApiRequest, NextApiResponse } from 'next';
import { searchService, type SearchParams } from '@/src/services/search';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const params = req.body as SearchParams;

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
  };

  try {
    searchService.on('status', (message: string) => {
      console.log('Status update:', message);
      sendEvent({ type: 'status', message });
    });

    searchService.on('tickets', (tickets: any[]) => {
      console.log('Found tickets:', tickets.length);
      sendEvent({ type: 'tickets', tickets });
    });

    searchService.on('error', (error: string) => {
      console.error('Search error:', error);
      sendEvent({ type: 'error', error });
    });

    console.log('Starting search with params:', params);
    const result = await searchService.searchAll(params);

    sendEvent({
      type: 'complete',
      success: true,
      tickets: result.data,
      metadata: result.metadata
    });

  } catch (error) {
    console.error('API error:', error);
    sendEvent({
      type: 'error',
      error: error instanceof Error ? error.message : 'Search failed'
    });
  } finally {
    res.end();
  }
}