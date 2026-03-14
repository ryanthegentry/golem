/**
 * Shared HTTP proxy handler for L402 gateway.
 * Forwards requests to an upstream URL, passing select headers.
 */

import type { Context } from 'hono';

const FORWARDED_HEADERS = ['content-type', 'accept', 'user-agent'] as const;

/**
 * Creates a Hono handler that proxies requests to the given upstream URL.
 */
export function createProxyHandler(upstream: string) {
  return async (c: Context): Promise<Response> => {
    const url = new URL(c.req.url);
    const upstreamTarget = `${upstream}${url.pathname}${url.search}`;

    try {
      const headers = new Headers();
      for (const key of FORWARDED_HEADERS) {
        const val = c.req.header(key);
        if (val) headers.set(key, val);
      }

      const res = await fetch(upstreamTarget, {
        method: c.req.method,
        headers,
        body: ['GET', 'HEAD'].includes(c.req.method) ? undefined : await c.req.text(),
        signal: AbortSignal.timeout(60_000),  // 60s — generous for LLM inference
      });

      const body = await res.text();
      const contentType = res.headers.get('content-type') || 'application/json';

      return new Response(body, {
        status: res.status,
        headers: { 'Content-Type': contentType },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'TimeoutError') {
        console.error(`[proxy] Upstream timeout after 60s: ${upstreamTarget}`);
        return c.json({ error: 'Upstream timeout' }, 504);
      }
      console.error(`[proxy] Failed to reach upstream ${upstreamTarget}:`, err instanceof Error ? err.message : err);
      return c.json({ error: 'Upstream unavailable' }, 502);
    }
  };
}
