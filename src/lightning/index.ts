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
import { capPollConcurrency } from './poll-concurrency.js';

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
export { capPollConcurrency, DEFAULT_POLL_CONCURRENCY } from './poll-concurrency.js';

/** Terminal Boltz swap statuses — these swaps will never change state again. */
const TERMINAL_STATUSES = [
  'transaction.claimed',
  'transaction.refunded',
  'swap.expired',
  'invoice.expired',
];

/**
 * `boltz_swaps.created_at` is written by the SDK as `Math.floor(Date.now() / 1e3)` —
 * **seconds**. These cutoffs used to be milliseconds, which made every comparison
 * `1.785e9 < 1.785e12`, i.e. always true: each startup deleted its entire eligible set
 * regardless of age. One production deploy log recorded 14,425 terminal rows and 533
 * "stale" pending swaps going in a single pass, the pending set including live in-flight
 * payments whose VHTLCs then refunded to Boltz unwatched.
 *
 * The failure direction matters if a row ever does land in milliseconds: against a seconds
 * cutoff it looks like the far future and is skipped. Not deleting a stale row is a leak;
 * deleting a live one loses money.
 */
const CLEANUP_AGE_SEC = 7 * 24 * 60 * 60; // 7 days
const STALE_PENDING_AGE_SEC = 24 * 60 * 60; // 24 hours

/** Current time in the same unit the SDK stores. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Delete terminal-state swaps older than 7 days from the swap DB.
 * Prevents SwapManager from polling Boltz for purged swaps (which return 404).
 * Returns the number of deleted rows.
 */
export function cleanupTerminalSwaps(db: import('better-sqlite3').Database): number {
  const cutoff = nowSeconds() - CLEANUP_AGE_SEC;
  const placeholders = TERMINAL_STATUSES.map(() => '?').join(', ');
  const result = db.prepare(
    `DELETE FROM boltz_swaps WHERE status IN (${placeholders}) AND created_at < ?`,
  ).run(...TERMINAL_STATUSES, cutoff);
  if (result.changes > 0) {
    console.log(`[lightning] Cleaned up ${result.changes} terminal swap(s) older than 7 days`);
  }
  return result.changes;
}

/**
 * Delete non-terminal swaps older than 24 hours. A pending swap that has not moved in a day
 * is not coming back; one that is younger than that may be an L402 payment in flight, and
 * dropping it from monitoring is how an unclaimed VHTLC ends up refunded to Boltz.
 */
export function cleanupStalePendingSwaps(db: import('better-sqlite3').Database): number {
  const cutoff = nowSeconds() - STALE_PENDING_AGE_SEC;
  const result = db.prepare(
    `DELETE FROM boltz_swaps WHERE status NOT IN (${TERMINAL_STATUSES.map(() => '?').join(', ')}) AND created_at < ?`,
  ).run(...TERMINAL_STATUSES, cutoff);
  if (result.changes > 0) {
    console.log(`[lightning] Cleaned up ${result.changes} stale pending swap(s) older than 24 hours`);
  }
  return result.changes;
}

// --- Swap DB cleanup (golem#2 RC3) ---

/**
 * The swap DB handle, kept so the hourly interval in the server can re-run cleanup. Stale
 * swaps used to be cleaned only at process start, which is why 58 days of uptime grew the
 * monitored set to 533 pending swaps and a redeploy was always the fix.
 */
let swapDb: import('better-sqlite3').Database | null = null;

export interface SwapCleanupResult {
  terminal: number;
  stalePending: number;
}

/**
 * Run both cleanups. Returns null when there is no swap DB (in-memory repository) or when
 * the table is not there yet — neither is worth failing a scheduled tick over.
 */
export function runSwapCleanup(
  db: import('better-sqlite3').Database | null = swapDb,
): SwapCleanupResult | null {
  if (!db) return null;
  try {
    return {
      terminal: cleanupTerminalSwaps(db),
      stalePending: cleanupStalePendingSwaps(db),
    };
  } catch (err) {
    // Non-fatal — table may not exist yet on first run
    console.warn('[lightning] Swap cleanup skipped:', err instanceof Error ? err.message : err);
    return null;
  }
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
    swapDb = db;

    // Clean up stale terminal swaps before starting the manager.
    // Boltz purges completed/expired swaps after some TTL. Polling purged swaps
    // generates 404s that feed the circuit breaker and flood logs.
    runSwapCleanup(db);
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
  if (swapManager) {
    monitor.attach(swapManager as never);
    capPollConcurrency(swapManager);
  }

  trackSwapInstance(lightning);
  return lightning;
}

// Instances created above, registered so the CLI's central teardown (issue
// #10) can stop their SwapManager — its Boltz WebSocket is a second
// event-loop holder on the pay/receive paths. The server creates exactly one
// instance for the process lifetime and never drains it; that single entry
// is inert.
const createdSwapInstances: Pick<ArkadeSwaps, 'stopSwapManager'>[] = [];

/** Register an ArkadeSwaps instance for central CLI teardown. */
export function trackSwapInstance(lightning: Pick<ArkadeSwaps, 'stopSwapManager'>): void {
  createdSwapInstances.push(lightning);
}

/** Return and clear all registered instances (teardown claims them once). */
export function drainSwapInstances(): Pick<ArkadeSwaps, 'stopSwapManager'>[] {
  return createdSwapInstances.splice(0);
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
      if (mgr) {
        monitor.attach(mgr as never);
        // A rebind may hand back a fresh manager instance, which arrives uncapped.
        capPollConcurrency(mgr);
      }
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
      capPollConcurrency(lightning.getSwapManager?.());
      return { healthy: true, action: 'started', stats };
    }

    // Running but unbound: the socket is down and it has fallen back to polling. That is the
    // May 28 shape — process up, subscription gone. Skipped at startup, where the handshake
    // may simply not have finished yet and a rebind would restart what we just started.
    if (allowRebind && !stats.websocketConnected && stats.usePollingFallback) {
      await lightning.stopSwapManager();
      await lightning.startSwapManager();
      capPollConcurrency(lightning.getSwapManager?.());
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
