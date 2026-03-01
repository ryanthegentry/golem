import { MockSigner } from '../src/signer/mock-signer.js';
import { GolemWallet } from '../src/wallet/golem-wallet.js';
import { walletConfigFromNetwork } from '../src/wallet/config.js';
import { getNetworkConfig } from '../src/config/networks.js';

const MUTINYNET_CONFIG = walletConfigFromNetwork(getNetworkConfig('mutinynet'));

async function main() {
  // Deterministic key for e2e testing
  const secret = new Uint8Array(32);
  secret[0] = 0xDE; secret[1] = 0xAD; secret[2] = 0xBE; secret[3] = 0xEF;
  secret[31] = 0x01;

  const signer = MockSigner.fromSecretKey(secret);
  const wallet = await GolemWallet.create(signer, { ...MUTINYNET_CONFIG, dataDir: null });

  const boardingAddr = await wallet.getBoardingAddress();
  const arkAddr = await wallet.getAddress();
  const balance = await wallet.getBalance();

  console.log('Boarding address:', boardingAddr);
  console.log('Ark address:', arkAddr);
  console.log('Balance:', JSON.stringify(balance));
}

main().catch(console.error);
