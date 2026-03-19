/**
 * Bug 4: Circuit breaker should distinguish client errors (4xx) from server errors (5xx).
 *
 * 4xx errors are config/request problems — retrying won't help and they should NOT
 * trip the circuit breaker. Only 5xx and network errors should trip it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { createL402Gateway } from './gateway.js';

function makePreimage() {
  const preimage = randomBytes(32).toString('hex');
  const paymentHash = createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest('hex');
  return { preimage, paymentHash };
}

function makeContext(urlPath: string, headers: Record<string, string> = {}) {
  const url = new URL(`http://localhost:8402${urlPath}`);
  let responseStatus = 200;
  let responseBody: any = null;
  let responseHeaders: Record<string, string> = {};

  return {
    req: {
      url: url.toString(),
      method: 'GET',
      header: (name: string) => headers[name.toLowerCase()],
      query: () => undefined,
      text: () => Promise.resolve(''),
    },
    json: (body: any, status?: number, hdrs?: Record<string, string>) => {
      responseBody = body;
      if (status) responseStatus = status;
      if (hdrs) responseHeaders = hdrs;
      return { status: responseStatus, body: responseBody, headers: responseHeaders };
    },
    _getResponse: () => ({ status: responseStatus, body: responseBody, headers: responseHeaders }),
  };
}

describe('Bug 4: Circuit breaker error classification', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('400 errors do NOT trip the circuit breaker (even after many calls)', async () => {
    const err = Object.assign(new Error('below minimum'), { statusCode: 400 });
    const lightning = {
      createLightningInvoice: vi.fn().mockRejectedValue(err),
      startSwapManager: vi.fn(),
      dispose: vi.fn(),
    } as any;

    const gateway = createL402Gateway(lightning, { priceSats: 500 });
    const cb = gateway._testInternals().boltzCircuitBreaker;

    // Make 10 requests — all fail with 400
    for (let i = 0; i < 10; i++) {
      const c = makeContext('/api/data');
      await gateway.middleware(c as any, vi.fn());
    }

    // Circuit breaker should NOT be open — 400 errors are never recorded
    expect(cb.isOpen()).toBe(false);
    expect((cb as any).failures.length).toBe(0);

    gateway.dispose();
  });

  it('5xx errors ARE recorded in the circuit breaker', async () => {
    vi.useFakeTimers();
    const err = Object.assign(new Error('service unavailable'), { statusCode: 503 });
    const lightning = {
      createLightningInvoice: vi.fn().mockRejectedValue(err),
      startSwapManager: vi.fn(),
      dispose: vi.fn(),
    } as any;

    const gateway = createL402Gateway(lightning, { priceSats: 500 });
    const cb = gateway._testInternals().boltzCircuitBreaker;

    // Make one request — it does 3 retries (advancing through backoff), then records 1 failure
    const promise = gateway.middleware(makeContext('/api/data') as any, vi.fn());
    await vi.advanceTimersByTimeAsync(500);  // 1st backoff
    await vi.advanceTimersByTimeAsync(1000); // 2nd backoff
    await vi.advanceTimersByTimeAsync(2000); // 3rd backoff
    await promise;

    // Should have recorded the failure
    expect((cb as any).failures.length).toBe(1);

    // Record 4 more to trip the breaker
    for (let i = 0; i < 4; i++) cb.record();
    expect(cb.isOpen()).toBe(true);

    gateway.dispose();
  });

  it('network errors (no statusCode) ARE recorded in the circuit breaker', async () => {
    vi.useFakeTimers();
    const lightning = {
      createLightningInvoice: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      startSwapManager: vi.fn(),
      dispose: vi.fn(),
    } as any;

    const gateway = createL402Gateway(lightning, { priceSats: 500 });
    const cb = gateway._testInternals().boltzCircuitBreaker;

    const promise = gateway.middleware(makeContext('/api/data') as any, vi.fn());
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await promise;

    expect((cb as any).failures.length).toBe(1);

    gateway.dispose();
  });

  it('400 error exits retry loop after 1 attempt (no retries)', async () => {
    const err = Object.assign(new Error('below minimum'), { statusCode: 400 });
    const lightning = {
      createLightningInvoice: vi.fn().mockRejectedValue(err),
      startSwapManager: vi.fn(),
      dispose: vi.fn(),
    } as any;

    const gateway = createL402Gateway(lightning, { priceSats: 500 });

    const c = makeContext('/api/data');
    await gateway.middleware(c as any, vi.fn());

    // Should only call once — no point retrying a 400
    expect(lightning.createLightningInvoice).toHaveBeenCalledTimes(1);

    gateway.dispose();
  });

  it('400 error returns 500 (config error) not 503 (service unavailable)', async () => {
    const err = Object.assign(new Error('1 is less than minimal of 333'), { statusCode: 400 });
    const lightning = {
      createLightningInvoice: vi.fn().mockRejectedValue(err),
      startSwapManager: vi.fn(),
      dispose: vi.fn(),
    } as any;

    const gateway = createL402Gateway(lightning, { priceSats: 500 });

    const c = makeContext('/api/data');
    await gateway.middleware(c as any, vi.fn());
    const result = c._getResponse();

    // 500 = config/request error, NOT 503 = service unavailable
    expect(result.status).toBe(500);
    // Should NOT have Retry-After header (this isn't a transient issue)
    expect(result.headers['Retry-After']).toBeUndefined();

    gateway.dispose();
  });
});
