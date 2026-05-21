/**
 * 402index auto-registration tests.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { registerWithIndex } from './register.js';

describe('402index registration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends correct POST body to /api/v1/register', async () => {
    // 402index returns the service in a wrapped envelope: { service: {...}, message }.
    // register.ts:62 reads data.service?.id / data.service?.status accordingly.
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ service: { id: 'abc-123', status: 'pending' }, message: 'Registration received' }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await registerWithIndex({
      registryUrl: 'https://402index.io',
      publicUrl: 'https://my-gateway.example.com',
      serviceName: 'Test Ollama Gateway',
      description: 'Ollama llama3.2 — 10 sats/request',
      priceSats: 10,
      category: 'ai/inference',
      probeBody: '{"model":"llama3.2","messages":[{"role":"user","content":"test"}]}',
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://402index.io/api/v1/register');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.url).toBe('https://my-gateway.example.com');
    expect(body.name).toBe('Test Ollama Gateway');
    expect(body.protocol).toBe('L402');
    expect(body.provider).toBe('golem-gateway');
    expect(result.status).toBe('pending');
    expect(result.id).toBe('abc-123');
  });

  it('returns already_registered on 409', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      json: async () => ({ error: 'URL already registered' }),
    }));

    const result = await registerWithIndex({
      registryUrl: 'https://402index.io',
      publicUrl: 'https://my-gateway.example.com',
      serviceName: 'Test',
      priceSats: 10,
    });

    expect(result.status).toBe('already_registered');
  });

  it('returns failed on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));

    const result = await registerWithIndex({
      registryUrl: 'https://402index.io',
      publicUrl: 'https://my-gateway.example.com',
      serviceName: 'Test',
      priceSats: 10,
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBeDefined();
  });

  it('returns probe_failed on 422', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({ error: 'L402 verification failed', probe: { valid: false } }),
    }));

    const result = await registerWithIndex({
      registryUrl: 'https://402index.io',
      publicUrl: 'https://my-gateway.example.com',
      serviceName: 'Test',
      priceSats: 10,
    });

    expect(result.status).toBe('probe_failed');
  });

  it('skips registration when publicUrl is missing', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const result = await registerWithIndex({
      registryUrl: 'https://402index.io',
      publicUrl: '',
      serviceName: 'Test',
      priceSats: 10,
    });

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.status).toBe('skipped');
    expect(result.reason).toContain('publicUrl');
  });

  it('uses AbortController signal for timeout', async () => {
    const mockFetch = vi.fn().mockImplementation((_url: string, opts: any) => {
      expect(opts.signal).toBeDefined();
      return Promise.resolve({
        ok: true,
        status: 201,
        json: async () => ({ id: 'x', status: 'pending' }),
      });
    });
    vi.stubGlobal('fetch', mockFetch);

    await registerWithIndex({
      registryUrl: 'https://402index.io',
      publicUrl: 'https://my-gateway.example.com',
      serviceName: 'Test',
      priceSats: 10,
    });

    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it('handles malformed JSON on 201 response without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }));

    const result = await registerWithIndex({
      registryUrl: 'https://402index.io',
      publicUrl: 'https://my-gateway.example.com',
      serviceName: 'Test',
      priceSats: 10,
    });

    // Should NOT throw — should return a non-throwing status
    expect(['pending', 'failed']).toContain(result.status);
  });

  it('handles malformed JSON on 422 response without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => { throw new SyntaxError('Unexpected token'); },
    }));

    const result = await registerWithIndex({
      registryUrl: 'https://402index.io',
      publicUrl: 'https://my-gateway.example.com',
      serviceName: 'Test',
      priceSats: 10,
    });

    expect(['probe_failed', 'failed']).toContain(result.status);
  });
});
