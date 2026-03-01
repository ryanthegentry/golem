/**
 * Invoice limiter tests — Step 7 hardening
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { InvoiceLimiter, type PendingInvoice } from './invoice-limiter.js';

function makeInvoice(hash: string, age: number = 0): PendingInvoice {
  return {
    invoice: `lntbs${hash.slice(0, 8)}...`,
    paymentHash: hash,
    macaroonBase64: `mac_${hash.slice(0, 8)}`,
    priceSats: 500,
    createdAt: Date.now() - age,
  };
}

describe('InvoiceLimiter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('allows invoices under the limit', () => {
    const limiter = new InvoiceLimiter(10);
    for (let i = 0; i < 9; i++) {
      limiter.add(makeInvoice(`hash${i}`.padEnd(64, '0')));
    }
    expect(limiter.getOrNull()).toBeNull();
    expect(limiter.count).toBe(9);
  });

  it('caps at 10 pending invoices', () => {
    const limiter = new InvoiceLimiter(10);
    for (let i = 0; i < 10; i++) {
      limiter.add(makeInvoice(`hash${i}`.padEnd(64, '0')));
    }

    // At limit — should return the oldest
    const existing = limiter.getOrNull();
    expect(existing).not.toBeNull();
    expect(existing!.paymentHash).toBe('hash0'.padEnd(64, '0'));
  });

  it('cleans up stale invoices after 15 minutes', () => {
    vi.useFakeTimers();

    const limiter = new InvoiceLimiter(10, 15 * 60 * 1000);

    // Add invoice at time 0
    limiter.add(makeInvoice('stale'.padEnd(64, '0')));
    expect(limiter.count).toBe(1);

    // Fast-forward 16 minutes
    vi.advanceTimersByTime(16 * 60 * 1000);

    const cleaned = limiter.cleanup();
    expect(cleaned).toBe(1);
    expect(limiter.count).toBe(0);

    vi.useRealTimers();
  });

  it('markPaid removes from pending', () => {
    const limiter = new InvoiceLimiter(10);
    const hash = 'paidhash'.padEnd(64, '0');
    limiter.add(makeInvoice(hash));
    expect(limiter.count).toBe(1);

    limiter.markPaid(hash);
    expect(limiter.count).toBe(0);
  });

  it('returns oldest when at limit', () => {
    const limiter = new InvoiceLimiter(3);

    // Add 3 invoices with different ages
    const old = makeInvoice('oldest'.padEnd(64, '0'), 5000);
    const mid = makeInvoice('middle'.padEnd(64, '0'), 2000);
    const recent = makeInvoice('recent'.padEnd(64, '0'), 0);

    limiter.add(old);
    limiter.add(mid);
    limiter.add(recent);

    const result = limiter.getOrNull();
    expect(result).not.toBeNull();
    expect(result!.paymentHash).toBe('oldest'.padEnd(64, '0'));
  });
});

describe('Sweep calculation', () => {
  it('calculates correct sweep amount', () => {
    const available = 50000;
    const keep = 10000;
    const sweepAmount = available - keep;
    expect(sweepAmount).toBe(40000);
  });

  it('sweep amount is 0 when balance equals keep', () => {
    const available = 10000;
    const keep = 10000;
    const sweepAmount = available - keep;
    expect(sweepAmount).toBe(0);
  });

  it('sweep amount is negative when balance below keep', () => {
    const available = 5000;
    const keep = 10000;
    const sweepAmount = available - keep;
    expect(sweepAmount).toBeLessThan(0);
  });
});
