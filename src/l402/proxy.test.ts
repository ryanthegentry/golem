import { describe, it, expect, vi, afterEach } from 'vitest';
import { createProxyHandler } from './proxy.js';

/** Minimal Hono-like context for testing the proxy handler */
function makeContext(
  url: string,
  method = 'GET',
  headers: Record<string, string> = {},
  body?: string,
) {
  return {
    req: {
      url,
      method,
      header: (name: string) => headers[name.toLowerCase()],
      text: () => Promise.resolve(body ?? ''),
    },
    json: (data: any, status: number) => new Response(JSON.stringify(data), { status }),
  } as any;
}

describe('createProxyHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('proxies GET to upstream with path and query string', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('{"ok":true}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const handler = createProxyHandler('https://api.example.com');
    const c = makeContext('http://localhost:8402/v1/data?foo=bar');
    const res = await handler(c);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [calledUrl, calledOpts] = mockFetch.mock.calls[0];
    expect(calledUrl).toBe('https://api.example.com/v1/data?foo=bar');
    expect(calledOpts.method).toBe('GET');
    expect(calledOpts.body).toBeUndefined();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
  });

  it('forwards content-type, accept, and user-agent headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const handler = createProxyHandler('https://api.example.com');
    const c = makeContext('http://localhost:8402/test', 'GET', {
      'content-type': 'application/json',
      'accept': 'text/html',
      'user-agent': 'golem/1.0',
      'authorization': 'Bearer secret', // should NOT be forwarded
    });
    await handler(c);

    const [, opts] = mockFetch.mock.calls[0];
    const forwarded = opts.headers as Headers;
    expect(forwarded.get('content-type')).toBe('application/json');
    expect(forwarded.get('accept')).toBe('text/html');
    expect(forwarded.get('user-agent')).toBe('golem/1.0');
    expect(forwarded.get('authorization')).toBeNull();
  });

  it('forwards POST body to upstream', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('created', { status: 201, headers: { 'Content-Type': 'text/plain' } }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const handler = createProxyHandler('https://api.example.com');
    const c = makeContext('http://localhost:8402/submit', 'POST', {}, '{"name":"test"}');
    const res = await handler(c);

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.method).toBe('POST');
    expect(opts.body).toBe('{"name":"test"}');
    expect(res.status).toBe(201);
  });

  it('omits body for HEAD requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('', { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const handler = createProxyHandler('https://api.example.com');
    const c = makeContext('http://localhost:8402/health', 'HEAD');
    await handler(c);

    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toBeUndefined();
  });

  it('returns 502 when upstream is unreachable', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    vi.stubGlobal('fetch', mockFetch);

    const handler = createProxyHandler('https://down.example.com');
    const c = makeContext('http://localhost:8402/api');
    const res = await handler(c);

    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe('Upstream unavailable');
  });

  it('preserves upstream status code', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response('not found', { status: 404, headers: { 'Content-Type': 'text/plain' } }),
    );
    vi.stubGlobal('fetch', mockFetch);

    const handler = createProxyHandler('https://api.example.com');
    const c = makeContext('http://localhost:8402/missing');
    const res = await handler(c);

    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not found');
  });

  it('defaults content-type to application/json when upstream omits it', async () => {
    // Create a response where headers.get('content-type') returns null
    const fakeRes = {
      status: 200,
      headers: new Headers(), // empty — no content-type
      text: () => Promise.resolve('{}'),
    };
    const mockFetch = vi.fn().mockResolvedValue(fakeRes);
    vi.stubGlobal('fetch', mockFetch);

    const handler = createProxyHandler('https://api.example.com');
    const c = makeContext('http://localhost:8402/data');
    const res = await handler(c);

    expect(res.headers.get('Content-Type')).toBe('application/json');
  });
});
