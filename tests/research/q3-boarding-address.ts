/**
 * Q3: Can a ReadonlyWallet generate a boarding address?
 */

import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;
import { ReadonlySingleKey, ReadonlyWallet } from '@arkade-os/sdk';

const PUBKEY_HEX = '03a29419fa1e8167c16f1f848310595fe850096d9bed10b3a14ea93d64834267b4';
const ARK_SERVER = 'https://mutinynet.arkade.sh';

async function main() {
  console.log('=== Q3: ReadonlyWallet Boarding Address ===\n');

  const pubkey = Buffer.from(PUBKEY_HEX, 'hex');
  const readonlyIdentity = ReadonlySingleKey.fromPublicKey(pubkey);
  const readonlyWallet = await ReadonlyWallet.create({
    identity: readonlyIdentity,
    arkServerUrl: ARK_SERVER,
  });

  try {
    const boardingAddress = await readonlyWallet.getBoardingAddress();
    console.log('Boarding address from ReadonlyWallet:', boardingAddress);
    console.log('SUCCESS: ReadonlyWallet can generate boarding addresses');
  } catch (error: any) {
    console.log('FAILURE:', error.message);
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
