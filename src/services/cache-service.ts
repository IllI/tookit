import type { ScrapedContent } from '@/lib/types/schemas';

interface CacheItem {
  data: ScrapedContent;
  timestamp: number;
}

class CacheService {
  private cache: Map<string, CacheItem>;
  private readonly TTL: number = 1000 * 60 * 60; // 1 hour

  constructor() {
    this.cache = new Map();
  }

  private getCacheKey(url: string, html: string): string {
    // Create a cache key based on URL and content hash
    const contentHash = Buffer.from(html).toString('base64').slice(0, 20);
    return `${url}:${contentHash}`;
  }

  private isExpired(timestamp: number): boolean {
    return Date.now() - timestamp > this.TTL;
  }

  async get(url: string, html: string): Promise<ScrapedContent | null> {
    const key = this.getCacheKey(url, html);
    const item = this.cache.get(key);

    if (!item) return null;
    if (this.isExpired(item.timestamp)) {
      this.cache.delete(key);
      return null;
    }

    return item.data;
  }

  async set(url: string, html: string, data: ScrapedContent): Promise<void> {
    const key = this.getCacheKey(url, html);
    this.cache.set(key, {
      data,
      timestamp: Date.now()
    });

    // Clean up old entries
    this.cleanup();
  }

  private cleanup(): void {
    for (const [key, item] of this.cache.entries()) {
      if (this.isExpired(item.timestamp)) {
        this.cache.delete(key);
      }
    }
  }
}

export const cacheService = new CacheService();