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
