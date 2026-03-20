import { BoltzSwapProvider, ArkadeSwaps } from '@arkade-os/boltz-swap';
import { SQLiteSwapRepository } from '@arkade-os/boltz-swap/repositories/sqlite';
import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Wallet } from '@arkade-os/sdk';
import type { NetworkConfig } from '../config/networks.js';
import { lightningConfigFromNetwork } from './config.js';
import { createSQLExecutor } from '../storage/sqlite-executor.js';

export type { GolemLightningConfig } from './config.js';
export { lightningConfigFromNetwork } from './config.js';
export { ArkadeSwaps } from '@arkade-os/boltz-swap';

/** Terminal Boltz swap statuses — these swaps will never change state again. */
const TERMINAL_STATUSES = [
  'transaction.claimed',
  'transaction.refunded',
  'swap.expired',
  'invoice.expired',
];

const CLEANUP_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Delete terminal-state swaps older than 7 days from the swap DB.
 * Prevents SwapManager from polling Boltz for purged swaps (which return 404).
 * Returns the number of deleted rows.
 */
export function cleanupTerminalSwaps(db: import('better-sqlite3').Database): number {
  const cutoff = Date.now() - CLEANUP_AGE_MS;
  const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
  const result = db.prepare(
    `DELETE FROM boltz_swaps WHERE status IN (${placeholders}) AND created_at < ?`,
  ).run(...TERMINAL_STATUSES, cutoff);
  if (result.changes > 0) {
    console.log(`[lightning] Cleaned up ${result.changes} terminal swap(s) older than 7 days`);
  }
  return result.changes;
}

const STALE_PENDING_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

export function cleanupStalePendingSwaps(db: import('better-sqlite3').Database): number {
  const cutoff = Date.now() - STALE_PENDING_AGE_MS;
  const result = db.prepare(
    `DELETE FROM boltz_swaps WHERE status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(', ')}) AND created_at < ?`,
  ).run(...TERMINAL_STATUSES, cutoff);
  if (result.changes > 0) {
    console.log(`[lightning] Cleaned up ${result.changes} stale pending swap(s) older than 24 hours`);
  }
  return result.changes;
}

/**
 * Create and start an ArkadeSwaps instance from an SDK wallet and network config.
 *
 * Encapsulates the BoltzSwapProvider + ArkadeSwaps + startSwapManager boilerplate
 * that was previously duplicated across gateway, serve, receive, pay-lightning, pay-l402,
 * and gateway-server.
 *
 * @param dataDir — Directory for swap persistence. When provided, uses SQLite
 *   (required in Node.js server environments where IndexedDB is unavailable).
 *   When omitted, ArkadeSwaps falls back to IndexedDbSwapRepository (browser-only).
 */
export async function createLightning(
  sdkWallet: Wallet,
  netConfig: NetworkConfig,
  dataDir?: string,
): Promise<ArkadeSwaps> {
  const lnConfig = lightningConfigFromNetwork(netConfig);

  const swapProvider = new BoltzSwapProvider({
    apiUrl: lnConfig.boltzApiUrl,
    network: lnConfig.network,
    referralId: lnConfig.referralId,
  });

  // Use SQLite swap repository in Node.js (IndexedDB is browser-only)
  let swapRepository: SQLiteSwapRepository | undefined;
  if (dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    const db = new Database(path.join(dataDir, 'boltz-swaps.db'));
    db.pragma('journal_mode = DELETE');
    swapRepository = new SQLiteSwapRepository(createSQLExecutor(db));

    // Clean up stale terminal swaps before starting the manager.
    // Boltz purges completed/expired swaps after some TTL. Polling purged swaps
    // generates 404s that feed the circuit breaker and flood logs.
    try {
      cleanupTerminalSwaps(db);
      cleanupStalePendingSwaps(db);
    } catch (err) {
      // Non-fatal — table may not exist yet on first run
      console.warn('[lightning] Swap cleanup skipped:', err instanceof Error ? err.message : err);
    }
  }

  const lightning = new ArkadeSwaps({
    wallet: sdkWallet,
    swapProvider,
    swapManager: { enableAutoActions: true },
    ...(swapRepository ? { swapRepository } : {}),
  });

  await lightning.startSwapManager();

  return lightning;
}
