import { SocksProxyAgent } from 'socks-proxy-agent';
import { config } from '@/src/config/env';

// List of SOCKS5 proxies to rotate through
const PROXY_LIST = [
  'socks5://proxy1.example.com:1080',
  'socks5://proxy2.example.com:1080',
  'socks5://proxy3.example.com:1080'
].filter(proxy => proxy.startsWith('socks5://')); // Only use valid SOCKS5 proxies

let currentProxyIndex = 0;

export async function fetchWithRotatingProxy(url: string, options: RequestInit = {}): Promise<Response> {
  // If no proxies are configured, fall back to direct request
  if (PROXY_LIST.length === 0) {
    return fetch(url, options);
  }

  // Try each proxy in sequence until one works
  let lastError;
  for (let attempt = 0; attempt < PROXY_LIST.length; attempt++) {
    const proxyUrl = PROXY_LIST[currentProxyIndex];
    currentProxyIndex = (currentProxyIndex + 1) % PROXY_LIST.length;

    try {
      const agent = new SocksProxyAgent(proxyUrl);
      const response = await fetch(url, {
        ...options,
        agent
      });

      if (response.ok) {
        return response;
      }

      // If we get a rate limit error, try the next proxy
      if (response.status === 429) {
        console.log(`Rate limited on proxy ${proxyUrl}, trying next proxy...`);
        continue;
      }

      // For other errors, return the response as is
      return response;
    } catch (error) {
      console.error(`Error with proxy ${proxyUrl}:`, error);
      lastError = error;
    }
  }

  // If all proxies fail, throw the last error
  throw lastError || new Error('All proxies failed');
}

export async function fetchWithCorsProxy(url: string): Promise<string> {
  const corsUrl = `https://proxy.cors.sh/${url}`;
  const response = await fetchWithRotatingProxy(corsUrl, {
    headers: {
      'accept': 'application/json, text/plain, */*',
      'accept-language': 'en-US,en;q=0.9',
      'origin': 'https://cors.sh',
      'priority': 'u=1, i',
      'referer': 'https://cors.sh/',
      'sec-ch-ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-site',
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    }
  });

  if (!response.ok) {
    throw new Error(`cors.sh error: ${response.status} ${response.statusText}`);
  }

  return response.text();
} 