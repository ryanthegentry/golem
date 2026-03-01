// EventSource polyfill — MUST be set before SDK uses it
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import { MockSigner } from '../src/signer/mock-signer.js';
import { GolemWallet } from '../src/wallet/golem-wallet.js';
import { walletConfigFromNetwork } from '../src/wallet/config.js';
import { getNetworkConfig } from '../src/config/networks.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

async function main() {
  const secret = new Uint8Array(32);
  secret[0] = 0xDE; secret[1] = 0xAD; secret[2] = 0xBE; secret[3] = 0xEF;
  secret[31] = 0x01;

  const signer = MockSigner.fromSecretKey(secret);
  const wallet = await GolemWallet.create(signer, { ...MUTINYNET_CONFIG, dataDir: null });

  // Intercept getEventStream to log raw SSE events
  const provider = wallet.sdkWallet.arkProvider as any;
  const origGetEventStream = provider.getEventStream.bind(provider);

  provider.getEventStream = async function*(signal: AbortSignal, topics: string[]) {
    for await (const event of origGetEventStream(signal, topics)) {
      yield event;
    }
  };

  // Also intercept registerIntent
  const origRegister = provider.registerIntent.bind(provider);
  provider.registerIntent = async (intent: any) => {
    const result = await origRegister(intent);
    return result;
  };

  // And confirmRegistration
  const origConfirm = provider.confirmRegistration?.bind(provider);
  if (origConfirm) {
    provider.confirmRegistration = async (intentId: string) => {
      const result = await origConfirm(intentId);
      return result;
    };
  }

  console.log('\nAttempting settle (auto-discover boarding UTXOs)...');
  try {
    const txid = await wallet.settle(undefined);
    console.log('\nSUCCESS! txid:', txid);
  } catch (err: any) {
    console.error('\nFAILED:', err.message);
  }

  process.exit(0);
}

main().catch(console.error);
