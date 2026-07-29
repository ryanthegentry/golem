/**
 * Live probe for central CLI teardown (issue #10), spawned by
 * teardown.test.ts — not a test file itself.
 *
 * Reproduces the wallet-touching command shape: create a real wallet against
 * mutinynet (which opens the Ark SDK's indexer SSE subscription — the
 * event-loop holder), read the balance, run the central teardown, and then
 * EXIT ON ITS OWN. The natural exit is the assertion; the parent only
 * watches for it. Handle-counting inside the test process was tried first
 * and is unusable: server-controlled keep-alive can hold unrelated sockets
 * open for minutes (they are unref'd and do not keep a process alive, but
 * they poison any count).
 *
 * TEARDOWN_PROBE_SKIP_DISPOSE=1 skips teardown, for validating that the
 * probe genuinely hangs without it.
 */

import '../polyfills.js';
import { getPublicKey, utils } from '@noble/secp256k1';
import { GolemWallet } from '../wallet/golem-wallet.js';
import { walletConfigFromNetwork } from '../wallet/config.js';
import { getNetworkConfig } from '../config/networks.js';
import { ReadOnlySigner } from '../signer/read-only-signer.js';
import { trackCliWallet, disposeCliResources } from './wallet.js';

const signer = new ReadOnlySigner(Buffer.from(getPublicKey(utils.randomSecretKey(), true)));
console.error('[probe] creating wallet…');
const wallet = await GolemWallet.create(signer, {
  ...walletConfigFromNetwork(getNetworkConfig('mutinynet')),
  dataDir: null,
});
trackCliWallet(wallet);
console.error('[probe] wallet created, reading balance…');
await wallet.getBalance();
console.error('[probe] balance read, tearing down…');

if (process.env.TEARDOWN_PROBE_SKIP_DISPOSE !== '1') {
  await disposeCliResources();
}
console.log('TEARDOWN_COMPLETE');

if (process.env.TEARDOWN_PROBE_DEBUG === '1') {
  // unref'd, so it only fires while something ELSE is holding the loop open
  const t = setInterval(() => {
    console.error('[probe] still alive; active resources:', process.getActiveResourcesInfo().join(','));
  }, 5000);
  t.unref();
}
// deliberately no process.exit() — exiting on its own is the point
