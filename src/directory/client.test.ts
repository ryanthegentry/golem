import { describe, it, expect, vi, beforeEach } from 'vitest';
import { queryDirectory } from './client.js';
import type { DirectoryResponse, DirectoryService } from './client.js';

function mockService(overrides?: Partial<DirectoryService>): DirectoryService {
  return {
    id: 'test-1',
    name: 'Test Service',
    description: 'A test service',
    url: 'https://example.com/api',
    protocol: 'L402',
    price_sats: 100,
    price_usd: null,
    payment_asset: 'BTC',
    payment_network: 'mainnet',
    category: 'data/weather',
    provider: 'TestCorp',
    source: 'exclusive',
    featured: 0,
    health_status: 'healthy',
    uptime_30d: 99.5,
    latency_p50_ms: 250,
    last_checked: '2026-02-28T12:00:00Z',
    registered_at: '2026-02-01T00:00:00Z',
    ...overrides,
  };
}

function mockResponse(services: DirectoryService[], total?: number): DirectoryResponse {
  return {
    services,
    total: total ?? services.length,
    limit: 50,
    offset: 0,
  };
}

describe('queryDirectory', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches services from the API', async () => {
    const expected = mockResponse([mockService()]);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(expected), { status: 200 }),
    );

    const result = await queryDirectory({}, 'https://402index.io');

    expect(result.services).toHaveLength(1);
    expect(result.services[0].name).toBe('Test Service');
    expect(result.total).toBe(1);
  });

  it('passes search query as q parameter', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse([])), { status: 200 }),
    );

    await queryDirectory({ q: 'weather' }, 'https://402index.io');

    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.searchParams.get('q')).toBe('weather');
  });

  it('passes all filter parameters', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse([])), { status: 200 }),
    );

    await queryDirectory({
      q: 'test',
      protocol: 'L402',
      category: 'crypto',
      health: 'healthy',
      limit: 10,
      offset: 20,
    }, 'https://402index.io');

    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.searchParams.get('q')).toBe('test');
    expect(url.searchParams.get('protocol')).toBe('L402');
    expect(url.searchParams.get('category')).toBe('crypto');
    expect(url.searchParams.get('health')).toBe('healthy');
    expect(url.searchParams.get('limit')).toBe('10');
    expect(url.searchParams.get('offset')).toBe('20');
  });

  it('omits undefined/empty parameters', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse([])), { status: 200 }),
    );

    await queryDirectory({ q: '', protocol: undefined }, 'https://402index.io');

    const url = new URL(fetchSpy.mock.calls[0][0] as string);
    expect(url.searchParams.has('q')).toBe(false);
    expect(url.searchParams.has('protocol')).toBe(false);
  });

  it('throws on non-200 response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500, statusText: 'Internal Server Error' }),
    );

    await expect(queryDirectory({}, 'https://402index.io'))
      .rejects.toThrow('402Index API returned 500');
  });

  it('handles multiple services', async () => {
    const services = [
      mockService({ id: 's1', name: 'Weather API', protocol: 'L402', price_sats: 50 }),
      mockService({ id: 's2', name: 'Bitcoin Price', protocol: 'x402', price_sats: 200 }),
      mockService({ id: 's3', name: 'AI Chat', protocol: 'both', price_sats: null, price_usd: 0.01 }),
    ];
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse(services, 42)), { status: 200 }),
    );

    const result = await queryDirectory({ limit: 3 }, 'https://402index.io');

    expect(result.services).toHaveLength(3);
    expect(result.total).toBe(42);
    expect(result.services[0].protocol).toBe('L402');
    expect(result.services[2].price_usd).toBe(0.01);
  });

  it('handles empty results', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse([])), { status: 200 }),
    );

    const result = await queryDirectory({ q: 'nonexistent' }, 'https://402index.io');

    expect(result.services).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('uses default base URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse([])), { status: 200 }),
    );

    await queryDirectory({});

    const url = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('402index.io');
  });

  it('handles services with null fields gracefully', async () => {
    const service = mockService({
      description: null,
      price_sats: null,
      price_usd: null,
      category: null,
      provider: null,
      uptime_30d: null,
      latency_p50_ms: null,
      last_checked: null,
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockResponse([service])), { status: 200 }),
    );

    const result = await queryDirectory({}, 'https://402index.io');

    expect(result.services[0].price_sats).toBeNull();
    expect(result.services[0].provider).toBeNull();
    expect(result.services[0].health_status).toBe('healthy');
  });
});
