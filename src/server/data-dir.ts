/**
 * Resolves where the wallet keeps its SQLite state.
 *
 * `ark-sdk.db` holds the contract repository, the transaction history, and the pre-signed
 * transaction-tree data that unilateral exit depends on. Until 2026-07-25 the server passed
 * a literal './data' here. The container's WORKDIR is /app and Railway's volume is mounted
 * at /app/data-l402, so './data' resolved to /app/data — the copy-on-write overlay, which
 * is thrown away on every deploy. The wallet came back each time with an empty contract
 * registry, could no longer name the scripts holding its coins, and reported a zero balance
 * while the coins sat untouched at the ASP.
 *
 * The default is derived from the L402 data dir rather than hardcoded, so a deployment that
 * moves its volume moves both together. `GOLEM_WALLET_DATA_DIR` overrides it outright.
 */

import * as path from 'node:path';

/** Where the Railway volume is mounted, relative to the container's /app WORKDIR. */
export const DEFAULT_L402_DATA_DIR = './data-l402';

/** Subdirectory of the volume that holds ark-sdk.db. */
export const WALLET_DIR_NAME = 'wallet';

type Env = Record<string, string | undefined>;

/**
 * The L402 dir — macaroons.db, boltz-swaps.db and root-keys.json. This volume has persisted
 * since March; nothing here changes what lives in it.
 */
export function resolveL402DataDir(env: Env = process.env): string {
  return env.GOLEM_L402_DATA_DIR || DEFAULT_L402_DATA_DIR;
}

/**
 * The wallet dir — ark-sdk.db. A subdirectory of the volume rather than the volume root,
 * so the SDK's own database cannot collide with the L402 stores already there.
 */
export function resolveWalletDataDir(env: Env = process.env): string {
  if (env.GOLEM_WALLET_DATA_DIR) return env.GOLEM_WALLET_DATA_DIR;
  return path.join(resolveL402DataDir(env), WALLET_DIR_NAME);
}
