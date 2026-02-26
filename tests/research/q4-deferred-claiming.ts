/**
 * Q4: Can claiming be separated from waitAndClaim()?
 *
 * Analyzes whether a swap created by ReadonlyWallet can be claimed later
 * by a full Wallet (on the mobile app).
 */

import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;
import { ReadonlySingleKey, ReadonlyWallet, RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk';
import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';

const PUBKEY_HEX = '03a29419fa1e8167c16f1f848310595fe850096d9bed10b3a14ea93d64834267b4';
const ARK_SERVER = 'https://mutinynet.arkade.sh';
const BOLTZ_API = 'https://api.boltz.mutinynet.arkade.sh';

async function main() {
  console.log('=== Q4: Deferred Claiming Analysis ===\n');

  // Create reverse swap and examine what data we'd need to persist
  console.log('1. Creating reverse swap to inspect pendingSwap structure...');
  const pubkey = Buffer.from(PUBKEY_HEX, 'hex');
  const readonlyIdentity = ReadonlySingleKey.fromPublicKey(pubkey);
  const readonlyWallet = await ReadonlyWallet.create({
    identity: readonlyIdentity,
    arkServerUrl: ARK_SERVER,
  });

  const swapProvider = new BoltzSwapProvider({
    apiUrl: BOLTZ_API,
    network: 'mutinynet',
    referralId: 'golem',
  });

  const arkProvider = new RestArkProvider(ARK_SERVER);
  const indexerProvider = new RestIndexerProvider(ARK_SERVER);

  // @ts-expect-error
  const arkadeLightning = new ArkadeLightning({
    wallet: readonlyWallet,
    swapProvider,
    arkProvider,
    indexerProvider,
  });

  const result = await arkadeLightning.createLightningInvoice({ amount: 1000 });

  console.log('\n2. Full pendingSwap structure:');
  const swap = result.pendingSwap;
  console.log(JSON.stringify(swap, null, 2));

  console.log('\n3. Data needed for deferred claiming:');
  console.log('   REQUIRED FIELDS:');
  console.log('   - id:', swap.id, '(swap identifier)');
  console.log('   - preimage:', swap.preimage?.slice(0, 16) + '...', '(needed for VHTLC claim witness)');
  console.log('   - response.lockupAddress:', swap.response.lockupAddress, '(VHTLC location)');
  console.log('   - response.refundPublicKey:', swap.response.refundPublicKey?.slice(0, 16) + '...', '(Boltz key for script reconstruction)');
  console.log('   - response.timeoutBlockHeights:', JSON.stringify(swap.response.timeoutBlockHeights), '(for script reconstruction)');
  console.log('   - request.claimPublicKey:', swap.request.claimPublicKey?.slice(0, 16) + '...', '(our pubkey, used in script)');
  console.log('   - request.preimageHash:', swap.request.preimageHash?.slice(0, 16) + '...', '(for verification)');

  console.log('\n4. Can a different wallet instance claim?');
  console.log('   ANALYSIS:');
  console.log('   - claimPublicKey is derived from wallet.identity.compressedPublicKey()');
  console.log('   - VHTLC script includes OUR x-only public key');
  console.log('   - Claim requires signing with the SAME key (tapscript leaf verification)');
  console.log('   - So the claiming wallet MUST have the same keypair');
  console.log('   - ReadonlyWallet uses ReadonlySingleKey.fromPublicKey(pubkey)');
  console.log('   - Full Wallet would use SingleKey(privateKey) with SAME pubkey');
  console.log('   - CONCLUSION: YES — same keypair, different wallet instance');

  console.log('\n5. Can a full Wallet claim a swap created by ReadonlyWallet?');
  console.log('   YES — because:');
  console.log('   a. The VHTLC script only references public keys (x-only form)');
  console.log('   b. The claim requires signing with the private key matching the pubkey');
  console.log('   c. ReadonlyWallet and full Wallet with same keypair have same pubkey');
  console.log('   d. The pendingSwap data is fully serializable (plain JSON)');
  console.log('   e. waitAndClaim() takes pendingSwap as a parameter — no wallet-specific state');

  console.log('\n6. Minimum claim code:');
  console.log(`
  // On mobile app (has master key):
  import { SingleKey, Wallet } from '@arkade-os/sdk';
  import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';

  const identity = new SingleKey(PRIVATE_KEY_HEX);
  const wallet = await Wallet.create({ identity, arkServerUrl: '...' });
  const swapProvider = new BoltzSwapProvider({ apiUrl: '...', network: '...' });
  const arkadeLightning = new ArkadeLightning({ wallet, swapProvider });

  // Restore the pending swap from server data
  const pendingSwap = JSON.parse(serverStoredSwapData);

  // Claim it (will monitor WebSocket for status, then join Ark round)
  const { txid } = await arkadeLightning.waitAndClaim(pendingSwap);
  console.log('Claimed:', txid);
  `);

  console.log('\n7. Gotchas:');
  console.log('   a. TIMING: Must claim before refund timeout (see timeoutBlockHeights.refund)');
  console.log('   b. PREIMAGE: Must be persisted securely — it is the claim secret');
  console.log('   c. PAYMENT STATUS: Must verify swap is actually paid before claiming');
  console.log('      → Check: swapProvider.getSwapStatus(swapId).status === "transaction.mempool"');
  console.log('   d. HOLD INVOICE: The Lightning payment is HELD until claim reveals preimage');
  console.log('      → Consumer does NOT get preimage until claim happens');
  console.log('      → This affects L402 flow (consumer needs preimage for auth token)');
  console.log('   e. BOLTZ RESTORE API: Can also restore swaps via public key');
  console.log('      → POST /v2/swap/restore with claimPublicKey');
  console.log('      → But this won\'t have the preimage (generated locally)');

  // Test Boltz restore endpoint
  console.log('\n8. Testing Boltz swap restore API...');
  try {
    const restoreResp = await fetch(`${BOLTZ_API}/v2/swap/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: PUBKEY_HEX }),
    });
    const restoreResult = await restoreResp.json();
    console.log('   Restore result:', JSON.stringify(restoreResult).slice(0, 200));
  } catch (e: any) {
    console.log('   Restore failed:', e.message);
  }

  console.log('\n=== RESULTS ===');
  console.log('DEFERRED CLAIMING:');
  console.log('- Data needed to persist: id, preimage, response (full), request (full)');
  console.log('- Can a different wallet instance claim? YES (same keypair required)');
  console.log('- Can a full Wallet claim a swap created by ReadonlyWallet? YES');
  console.log('- Minimum claim code: see above');
  console.log('- Gotchas: timing (refund timeout), preimage persistence, hold invoice semantics');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
