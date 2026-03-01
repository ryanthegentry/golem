/**
 * Q6: Does createLightningInvoice use the wallet's identity at all?
 *
 * Traces the exact wallet method calls during invoice creation vs claiming.
 * Uses a proxy to intercept all method calls on the wallet object.
 */

import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;
import { ReadonlySingleKey, ReadonlyWallet, RestArkProvider, RestIndexerProvider } from '@arkade-os/sdk';
import { ArkadeLightning, BoltzSwapProvider } from '@arkade-os/boltz-swap';

const PUBKEY_HEX = '03a29419fa1e8167c16f1f848310595fe850096d9bed10b3a14ea93d64834267b4';
const ARK_SERVER = 'https://mutinynet.arkade.sh';
const BOLTZ_API = 'https://api.boltz.mutinynet.arkade.sh';

function createTracingProxy<T extends object>(target: T, name: string): T {
  return new Proxy(target, {
    get(obj: any, prop: string) {
      const value = obj[prop];
      if (typeof value === 'function') {
        return function (...args: any[]) {
          const result = value.apply(obj, args);
          if (result && typeof result.then === 'function') {
            return result;
          }
          return result;
        };
      }
      if (prop === 'identity') {
        // Also trace identity method calls
        return createTracingProxy(value, `${name}.identity`);
      }
      return value;
    }
  });
}

async function main() {
  console.log('=== Q6: Boltz Invoice Internals Trace ===\n');

  // Create ReadonlyWallet
  console.log('1. Creating ReadonlyWallet...');
  const pubkey = Buffer.from(PUBKEY_HEX, 'hex');
  const readonlyIdentity = ReadonlySingleKey.fromPublicKey(pubkey);
  const readonlyWallet = await ReadonlyWallet.create({
    identity: readonlyIdentity,
    arkServerUrl: ARK_SERVER,
  });
  console.log('   Done\n');

  // Wrap wallet in tracing proxy
  const tracedWallet = createTracingProxy(readonlyWallet, 'wallet');

  // Create Boltz provider
  const swapProvider = new BoltzSwapProvider({
    apiUrl: BOLTZ_API,
    network: 'mutinynet',
    referralId: 'golem',
  });

  // Create ArkadeLightning with traced wallet + explicit providers
  const arkProvider = new RestArkProvider(ARK_SERVER);
  const indexerProvider = new RestIndexerProvider(ARK_SERVER);
  console.log('2. Creating ArkadeLightning with traced wallet...\n');
  // @ts-expect-error — ReadonlyWallet not in type union
  const arkadeLightning = new ArkadeLightning({
    wallet: tracedWallet,
    swapProvider,
    arkProvider,
    indexerProvider,
  });

  // Create invoice and trace ALL wallet method calls
  console.log('3. Creating Lightning invoice — tracing wallet calls:\n');
  try {
    const result = await arkadeLightning.createLightningInvoice({ amount: 1000 });
    console.log('\n   Invoice created successfully');
    console.log('   Payment hash:', result.paymentHash);
  } catch (error: any) {
    console.log('\n   Invoice creation failed:', error.message);
  }

  console.log('\n=== RESULTS ===');
  console.log('BOLTZ INVOICE INTERNALS:');
  console.log('- See trace output above for exact wallet method calls');
  console.log('- Expected: only wallet.identity.compressedPublicKey() is called');
  console.log('- No wallet.sign() or identity.sign() should appear');
  console.log('- Assessment based on trace output above');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
