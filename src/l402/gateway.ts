/**
 * L402 Gateway — Hono middleware that gates HTTP routes behind Lightning payments.
 *
 * Unpaid requests get a 402 with a macaroon + invoice.
 * Paid requests include "Authorization: L402 <macaroon>:<preimage>" and pass through.
 */

import { randomBytes } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { ArkadeLightning } from '@arkade-os/boltz-swap';
import {
  mintL402Macaroon,
  verifyL402Token,
  parseL402Header,
  formatL402Challenge,
} from './macaroon.js';

export interface GatewayConfig {
  /** Price per request in satoshis */
  priceSats: number;
  /** Server root key for macaroon signing (hex, 32 bytes). Generated randomly if not provided. */
  rootKey?: string;
  /** Optional description shown in 402 response */
  description?: string;
  /** Paths that are free (no payment required), e.g. ["/health", "/docs"] */
  freePaths?: string[];
  /** Optional macaroon caveats to add to every token */
  caveats?: string[];
}

export interface GatewayStats {
  totalRequests: number;
  paidRequests: number;
  challengesIssued: number;
  totalSatsEarned: number;
}

export interface L402Gateway {
  middleware: MiddlewareHandler;
  stats: GatewayStats;
  rootKey: string;
}

/**
 * Creates an L402 gateway middleware.
 *
 * Flow:
 * 1. Free path? → pass through
 * 2. Has valid L402 Authorization header? → verify → pass through
 * 3. Otherwise → create invoice, mint macaroon → 402 challenge
 */
export function createL402Gateway(
  lightning: ArkadeLightning,
  config: GatewayConfig,
): L402Gateway {
  const rootKey = config.rootKey ?? randomBytes(32).toString('hex');
  const freePaths = new Set(config.freePaths ?? []);
  const caveats = config.caveats ?? [];
  const priceSats = config.priceSats;
  const description = config.description ?? `Payment required: ${priceSats} sats`;

  if (!config.rootKey) {
    console.warn('[l402] No rootKey provided — generated random key. Tokens will not survive restarts.');
  }

  const stats: GatewayStats = {
    totalRequests: 0,
    paidRequests: 0,
    challengesIssued: 0,
    totalSatsEarned: 0,
  };

  const middleware: MiddlewareHandler = async (c, next) => {
    stats.totalRequests++;

    // Free paths pass through
    const path = new URL(c.req.url).pathname;
    if (freePaths.has(path)) {
      return next();
    }

    // Check for L402 Authorization header
    const authHeader = c.req.header('Authorization');
    if (authHeader) {
      const parsed = parseL402Header(authHeader);
      if (parsed) {
        const result = verifyL402Token(rootKey, parsed.macaroon, parsed.preimage, caveats.length > 0 ? caveats : undefined);
        if (result.valid) {
          stats.paidRequests++;
          stats.totalSatsEarned += priceSats;
          console.log(`[l402] Verified payment for ${path} (hash: ${result.paymentHash?.slice(0, 16)}...)`);
          return next();
        }
        console.log(`[l402] Invalid L402 token for ${path}: ${result.error}`);
      }
    }

    // Issue 402 challenge
    try {
      const invoiceResult = await lightning.createLightningInvoice({ amount: priceSats });
      const macaroon = mintL402Macaroon(rootKey, invoiceResult.paymentHash, 'golem', caveats);
      const challenge = formatL402Challenge(macaroon, invoiceResult.invoice);

      stats.challengesIssued++;
      console.log(`[l402] Issued 402 challenge for ${path} (${priceSats} sats)`);

      return c.json({
        error: 'Payment Required',
        description,
        price: priceSats,
        invoice: invoiceResult.invoice,
        macaroon,
        paymentHash: invoiceResult.paymentHash,
      }, 402, {
        'WWW-Authenticate': challenge,
      });
    } catch (err) {
      console.error('[l402] Failed to create invoice:', err instanceof Error ? err.message : err);
      return c.json({ error: 'Failed to create payment challenge' }, 500);
    }
  };

  return { middleware, stats, rootKey };
}
