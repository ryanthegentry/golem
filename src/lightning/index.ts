import { BoltzSwapProvider, ArkadeSwaps, setLogger } from '@arkade-os/boltz-swap';
import { SQLiteSwapRepository } from '@arkade-os/boltz-swap/repositories/sqlite';
import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import type { Wallet } from '@arkade-os/sdk';
import type { NetworkConfig } from '../config/networks.js';
import { lightningConfigFromNetwork } from './config.js';
import { createSQLExecutor } from '../storage/sqlite-executor.js';
import { BoltzPollMonitor } from './boltz-resilience.js';

export type { GolemLightningConfig } from './config.js';
export { lightningConfigFromNetwork } from './config.js';
export { ArkadeSwaps } from '@arkade-os/boltz-swap';
export { subscribeCovenantClaims } from './covenant-claim-subscription.js';
export type {
  CovenantRecipeProvider,
  SubscribeCovenantClaimsOptions,
} from './covenant-claim-subscription.js';
export { BoltzPollMonitor, DEFAULT_RESILIENCE_CONFIG } from './boltz-resilience.js';
export type { LightningHealth, BreakerState } from './boltz-resilience.js';

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
    // `autoStart` defaults to true, which makes the ArkadeSwaps constructor kick off its own
    // unawaited `startSwapManager()`. Combined with the explicit call below that is a race
    // whose loser logs "SwapManager is already running" — the line on every cold start
    // (golem#2). Turning autostart off makes initialisation single-path.
    swapManager: { enableAutoActions: true, autoStart: false },
    ...(swapRepository ? { swapRepository } : {}),
  });

  // Route the SDK's logging through the breaker before anything can emit. The SwapManager
  // has no failure event to subscribe to, so its log stream is the only signal that polls
  // are failing — and, unguarded, the source of the flood.
  const monitor = installPollMonitor(lightning, lnConfig.boltzApiUrl);

  await lightning.startSwapManager();

  const swapManager = lightning.getSwapManager?.();
  if (swapManager) monitor.attach(swapManager as never);

  return lightning;
}

// --- Poll monitor (golem#2) ---

let pollMonitor: BoltzPollMonitor | null = null;

/** The active poll monitor, or null before `createLightning` has run. */
export function getPollMonitor(): BoltzPollMonitor | null {
  return pollMonitor;
}

/**
 * Build a monitor for this ArkadeSwaps instance and install it as the SDK's logger.
 * Replaces any previous monitor — `setLogger` is process-global, so exactly one is live.
 */
function installPollMonitor(lightning: ArkadeSwaps, boltzApiUrl: string): BoltzPollMonitor {
  pollMonitor?.stop();

  const monitor = new BoltzPollMonitor({
    rebind: async () => {
      // Tear the subscription down and re-establish it. This is the automated form of the
      // Railway redeploy that every prior recovery depended on.
      await lightning.stopSwapManager();
      await lightning.startSwapManager();
      const mgr = lightning.getSwapManager?.();
      if (mgr) monitor.attach(mgr as never);
    },
    probe: async () => {
      try {
        const res = await fetch(`${boltzApiUrl}/v2/version`, {
          signal: AbortSignal.timeout(5000),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  });

  setLogger(monitor.createSdkLogger());
  pollMonitor = monitor;
  return monitor;
}

export interface SwapManagerHealthReport {
  healthy: boolean;
  action: 'none' | 'started' | 'rebound' | 'unavailable';
  stats?: {
    isRunning: boolean;
    monitoredSwaps: number;
    websocketConnected: boolean;
    usePollingFallback: boolean;
  };
  error?: string;
}

/**
 * Idempotent SwapManager init (golem#2, item 3).
 *
 * The SDK's own guard returns the cached manager whenever `isRunning` is set, without
 * checking that the manager is bound to anything — which is how a process can sit "running"
 * for two days while its subscription is dead. This verifies the manager is both running and
 * connected, and rebinds it when it is not.
 *
 * Mutates state, so it belongs on startup and explicit operator action, not on a read-only
 * health poll.
 */
export async function ensureSwapManagerHealthy(
  lightning: ArkadeSwaps,
  options: { allowRebind?: boolean } = {},
): Promise<SwapManagerHealthReport> {
  const allowRebind = options.allowRebind ?? true;
  const manager = lightning.getSwapManager?.();
  if (!manager) {
    return { healthy: false, action: 'unavailable', error: 'SwapManager not enabled' };
  }

  try {
    const stats = await manager.getStats();

    if (!stats.isRunning) {
      await lightning.startSwapManager();
      return { healthy: true, action: 'started', stats };
    }

    // Running but unbound: the socket is down and it has fallen back to polling. That is the
    // May 28 shape — process up, subscription gone. Skipped at startup, where the handshake
    // may simply not have finished yet and a rebind would restart what we just started.
    if (allowRebind && !stats.websocketConnected && stats.usePollingFallback) {
      await lightning.stopSwapManager();
      await lightning.startSwapManager();
      return { healthy: true, action: 'rebound', stats };
    }

    return { healthy: true, action: 'none', stats };
  } catch (err) {
    return {
      healthy: false,
      action: 'unavailable',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
