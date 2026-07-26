/**
 * Operator override for the refresh safety margin.
 *
 * The margin is how much time must remain before expiry for the RefreshAgent to renew a
 * VTXO. It was hardcoded at 3 days, which is right in steady state but leaves no way to
 * make the agent act sooner during an incident. On 2026-07-26 a recovered VTXO sat 84.6
 * hours from expiry — outside the 72-hour window — and the only ways to renew it were to
 * wait half a day or to hand-roll a settle next to mainnet funds. Neither is a good option
 * with a deadline running.
 */

import { describe, it, expect } from 'vitest';
import { resolveRefreshSafetyMarginMs, DEFAULT_SAFETY_MARGIN_MS } from './refresh-config.js';

describe('resolveRefreshSafetyMarginMs', () => {
  it('defaults to 3 days when unset', () => {
    expect(resolveRefreshSafetyMarginMs({})).toBe(DEFAULT_SAFETY_MARGIN_MS);
    expect(DEFAULT_SAFETY_MARGIN_MS).toBe(3 * 24 * 60 * 60 * 1000);
  });

  it('takes an operator override in milliseconds', () => {
    expect(resolveRefreshSafetyMarginMs({ GOLEM_REFRESH_SAFETY_MARGIN_MS: '432000000' })).toBe(
      432_000_000,
    );
  });

  it('a 5-day override covers a VTXO 84.6 hours out — the recovery case', () => {
    const fiveDays = 5 * 24 * 60 * 60 * 1000;
    const margin = resolveRefreshSafetyMarginMs({
      GOLEM_REFRESH_SAFETY_MARGIN_MS: String(fiveDays),
    });
    expect(margin).toBeGreaterThan(84.6 * 60 * 60 * 1000);
  });

  it('ignores values that are not positive integers rather than disabling refresh', () => {
    for (const bad of ['', '0', '-1', 'abc', '1.5e3', 'NaN', 'Infinity']) {
      expect(resolveRefreshSafetyMarginMs({ GOLEM_REFRESH_SAFETY_MARGIN_MS: bad })).toBe(
        DEFAULT_SAFETY_MARGIN_MS,
      );
    }
  });

  it('refuses an absurd override so a typo cannot make everything look expiring forever', () => {
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    expect(
      resolveRefreshSafetyMarginMs({ GOLEM_REFRESH_SAFETY_MARGIN_MS: String(oneYear) }),
    ).toBe(DEFAULT_SAFETY_MARGIN_MS);
  });

  it('accepts the documented ceiling but not one millisecond past it', () => {
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(
      resolveRefreshSafetyMarginMs({ GOLEM_REFRESH_SAFETY_MARGIN_MS: String(thirtyDays) }),
    ).toBe(thirtyDays);
    expect(
      resolveRefreshSafetyMarginMs({ GOLEM_REFRESH_SAFETY_MARGIN_MS: String(thirtyDays + 1) }),
    ).toBe(DEFAULT_SAFETY_MARGIN_MS);
  });
});
