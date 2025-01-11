import type { NextApiRequest, NextApiResponse } from 'next';
import { SearchService } from '../../lib/services/search-service';
import type { SearchParams } from '../../lib/types/api';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Set SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });

  const searchService = new SearchService();
  const params = req.body as SearchParams;

  // Helper function to send SSE messages
  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    // Force flush if available
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
  };

  try {
    // Set up event listeners
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

    // Start the search
    console.log('Starting search with params:', params);
    const result = await searchService.searchAll(params);

    // Send completion event
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
