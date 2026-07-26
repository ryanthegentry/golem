/**
 * Gate for tests that talk to a live Ark server.
 *
 * Eight test files call `GolemWallet.create(signer, MUTINYNET_CONFIG)`, which reaches
 * `https://mutinynet.arkade.sh` over the wire. They run ungated today, so a mutinynet blip
 * reads as a code failure — one flaked during the 2026-07-26 session with
 * `Failed to fetch vtxos: <none>` and passed on retry.
 *
 * That is tolerable noise in normal work and intolerable during a dependency upgrade, where
 * a red suite has to mean "the upgrade broke something". `SKIP_INTEGRATION=1 npm test` gives
 * a network-free signal.
 *
 * Deliberately NOT gated on `CI`: unlike `mainnet.integration.test.ts`, these are the only
 * tests exercising the SDK against a real server, so CI keeps running them.
 */

import { describe, it, expect } from 'vitest';
import { skipNetworkTests } from './network-gate.js';

describe('skipNetworkTests', () => {
  it('runs network tests by default', () => {
    expect(skipNetworkTests({})).toBe(false);
  });

  it('skips when SKIP_INTEGRATION is set', () => {
    expect(skipNetworkTests({ SKIP_INTEGRATION: '1' })).toBe(true);
  });

  it('does not gate on CI — these are the only real-server tests we have', () => {
    expect(skipNetworkTests({ CI: 'true' })).toBe(false);
  });

  it('treats an empty value as unset rather than truthy', () => {
    expect(skipNetworkTests({ SKIP_INTEGRATION: '' })).toBe(false);
  });

  it('accepts any non-empty value', () => {
    for (const v of ['1', 'true', 'yes', '0']) {
      expect(skipNetworkTests({ SKIP_INTEGRATION: v })).toBe(true);
    }
  });
});
