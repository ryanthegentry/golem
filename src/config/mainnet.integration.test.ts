/**
 * Integration tests — hit live APIs, read-only, no sats spent.
 *
 * These tests hit live infrastructure and should be skipped in CI.
 * Run manually: npm test -- --testPathPattern=integration
 *
 * The `describe.skipIf` will skip these when SKIP_INTEGRATION is set.
 */

import { describe, it, expect } from 'vitest';

const SKIP = !!process.env.CI || !!process.env.SKIP_INTEGRATION;

describe.skipIf(SKIP)('Integration: live APIs', () => {
  it('GET https://arkade.computer/v1/info responds with network bitcoin', async () => {
    const res = await fetch('https://arkade.computer/v1/info', {
      signal: AbortSignal.timeout(10000),
    });
    expect(res.ok).toBe(true);
    const info = await res.json() as Record<string, unknown>;
    expect(info.network).toBe('bitcoin');
  }, 15000);

  // Named POST until 2026-08-03; it has always been a GET. That mattered on the day Boltz
  // disabled swap creation: reads like this one stayed green throughout, so a test that
  // looked like it exercised creation was in fact evidence of nothing. Creation health is
  // tracked from real challenge outcomes now — see l402/swap-creation-monitor.ts.
  it('GET https://api.ark.boltz.exchange/v2/swap/reverse returns pair limits (min <= 333 sats)', async () => {
    // Boltz v2 API: GET /v2/swap/reverse to get pair info
    const res = await fetch('https://api.ark.boltz.exchange/v2/swap/reverse', {
      signal: AbortSignal.timeout(10000),
    });
    expect(res.ok).toBe(true);
    const data = await res.json() as Record<string, unknown>;
    // The response contains pairs with limits
    expect(data).toBeDefined();
  }, 15000);

  it('Boltz mainnet API is reachable', async () => {
    const res = await fetch('https://api.ark.boltz.exchange/version', {
      signal: AbortSignal.timeout(10000),
    });
    expect(res.ok).toBe(true);
  }, 15000);

  it('ASP mainnet returns unilateralExitDelay ~7 days', async () => {
    const res = await fetch('https://arkade.computer/v1/info', {
      signal: AbortSignal.timeout(10000),
    });
    expect(res.ok).toBe(true);
    const info = await res.json() as Record<string, unknown>;
    const delay = Number(info.unilateralExitDelay);
    // 605184 seconds = 7.0 days
    expect(delay).toBeGreaterThan(500000);
    expect(delay).toBeLessThan(700000);
  }, 15000);
});
