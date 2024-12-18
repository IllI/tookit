import type { NextApiRequest, NextApiResponse } from 'next';
import { browserService } from '@/src/lib/browser';

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

  const sendEvent = (data: any) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof (res as any).flush === 'function') {
      (res as any).flush();
    }
  };

  try {
    // Set up event listeners
    browserService.on('status', (message: string) => {
      console.log('Status update:', message);
      sendEvent({ type: 'status', message });
    });

    browserService.on('tickets', (tickets: any[]) => {
      console.log('Found tickets:', tickets.length);
      sendEvent({ type: 'tickets', tickets });
    });

    browserService.on('error', (error: string) => {
      console.error('Search error:', error);
      sendEvent({ type: 'error', error });
    });

    // Start the search
    console.log('Starting search with params:', req.body);
    const result = await browserService.search(req.body);

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