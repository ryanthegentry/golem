/**
 * Invoice rate limiter — caps pending unpaid invoices.
 *
 * Max 10 pending unpaid invoices. When limit is hit, returns the oldest
 * pending invoice instead of creating a new one. Cleans up invoices
 * that have been pending > 15 minutes.
 */

export interface PendingInvoice {
  invoice: string;
  paymentHash: string;
  macaroonBase64: string;
  priceSats: number;
  createdAt: number;
}

export class InvoiceLimiter {
  private pending = new Map<string, PendingInvoice>();
  private readonly maxPending: number;
  private readonly staleMs: number;

  constructor(maxPending: number = 10, staleMs: number = 15 * 60 * 1000) {
    this.maxPending = maxPending;
    this.staleMs = staleMs;
  }

  /** Clean up stale (>15min) pending invoices. Returns count removed. */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [hash, inv] of this.pending) {
      if (now - inv.createdAt > this.staleMs) {
        this.pending.delete(hash);
        removed++;
      }
    }
    return removed;
  }

  /** Check if we're at the limit. If so, return the oldest pending invoice. */
  getOrNull(): PendingInvoice | null {
    this.cleanup();
    if (this.pending.size < this.maxPending) return null;

    // Return oldest pending invoice
    let oldest: PendingInvoice | null = null;
    for (const inv of this.pending.values()) {
      if (!oldest || inv.createdAt < oldest.createdAt) {
        oldest = inv;
      }
    }
    return oldest;
  }

  /** Register a new pending invoice. */
  add(invoice: PendingInvoice): void {
    this.pending.set(invoice.paymentHash, invoice);
  }

  /** Mark an invoice as paid (remove from pending). */
  markPaid(paymentHash: string): void {
    this.pending.delete(paymentHash);
  }

  /** Current count of pending invoices. */
  get count(): number {
    return this.pending.size;
  }
}
