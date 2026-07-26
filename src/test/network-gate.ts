/**
 * Gate for tests that talk to a live Ark server.
 *
 * Several wallet test files construct a real `GolemWallet` against mutinynet, which reaches
 * `https://mutinynet.arkade.sh` over the wire. Normally that is useful coverage; during a
 * dependency upgrade it is noise, because a red suite has to mean "the upgrade broke
 * something" rather than "the testnet hiccuped".
 *
 * Run `SKIP_INTEGRATION=1 npm test` for a network-free signal.
 *
 * Not gated on `CI`, unlike `config/mainnet.integration.test.ts`: these are the only tests
 * exercising the SDK against a real server, so CI should keep running them.
 */

type Env = Record<string, string | undefined>;

export function skipNetworkTests(env: Env = process.env): boolean {
  return !!env.SKIP_INTEGRATION;
}

/** Evaluated once at import, for use in `describe.skipIf(...)`. */
export const SKIP_NETWORK = skipNetworkTests();
