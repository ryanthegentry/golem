/**
 * Where the wallet keeps `ark-sdk.db`.
 *
 * The 2026-07-25 incident: the server passed './data', which under the container's
 * `WORKDIR /app` is `/app/data` — the ephemeral overlay. Railway's volume is mounted at
 * `/app/data-l402`. Every deploy therefore destroyed the contract repository, and with it
 * the wallet's ability to name the scripts holding its coins.
 */

import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  resolveWalletDataDir,
  resolveL402DataDir,
  DEFAULT_L402_DATA_DIR,
  WALLET_DIR_NAME,
} from './data-dir.js';

describe('wallet data dir resolution', () => {
  it('defaults to a directory under the L402 volume mount', () => {
    const dir = resolveWalletDataDir({});
    const l402 = resolveL402DataDir({});

    expect(path.resolve(dir).startsWith(path.resolve(l402) + path.sep)).toBe(true);
    expect(path.basename(dir)).toBe(WALLET_DIR_NAME);
  });

  it('never resolves to ./data — the ephemeral overlay path that lost the contract repo', () => {
    for (const env of [{}, { GOLEM_L402_DATA_DIR: '/app/data-l402' }]) {
      expect(path.resolve(resolveWalletDataDir(env))).not.toBe(path.resolve('./data'));
    }
  });

  it('resolves to /app/data-l402/wallet under the production container layout', () => {
    // Dockerfile: WORKDIR /app, volume mounted at /app/data-l402. The default L402 dir is
    // relative, so this pins the path production actually gets.
    const dir = resolveWalletDataDir({});
    expect(path.resolve('/app', dir)).toBe('/app/data-l402/wallet');
  });

  it('follows GOLEM_L402_DATA_DIR when the volume moves', () => {
    const dir = resolveWalletDataDir({ GOLEM_L402_DATA_DIR: '/mnt/vol' });
    expect(dir).toBe(path.join('/mnt/vol', WALLET_DIR_NAME));
  });

  it('GOLEM_WALLET_DATA_DIR overrides everything', () => {
    const dir = resolveWalletDataDir({
      GOLEM_L402_DATA_DIR: '/mnt/vol',
      GOLEM_WALLET_DATA_DIR: '/mnt/other/wallet',
    });
    expect(dir).toBe('/mnt/other/wallet');
  });

  it('ignores an empty override rather than resolving to the process cwd', () => {
    const dir = resolveWalletDataDir({ GOLEM_WALLET_DATA_DIR: '' });
    expect(dir).toBe(path.join(DEFAULT_L402_DATA_DIR, WALLET_DIR_NAME));
  });

  it('keeps the wallet dir separate from the L402 dir so the existing dbs are untouched', () => {
    // macaroons.db, boltz-swaps.db and root-keys.json live directly in the L402 dir and
    // have persisted since March. The wallet gets its own subdirectory.
    expect(path.resolve(resolveWalletDataDir({}))).not.toBe(path.resolve(resolveL402DataDir({})));
  });
});
