/**
 * golem init — Generate a new wallet and save config to ~/.golem/config.json
 */

import { Command } from 'commander';
import { utils, etc } from '@noble/secp256k1';
import { MockSigner } from '../../signer/mock-signer.js';
import { GolemWallet } from '../../wallet/golem-wallet.js';
import { MUTINYNET_CONFIG } from '../../wallet/config.js';
import { configExists, saveConfig, getConfigPath, getConfigDir } from '../config.js';

const DEFAULT_ARK_SERVER = 'https://mutinynet.arkade.sh';

export const initCommand = new Command('init')
  .description('Initialize a new Golem wallet')
  .option('--network <network>', 'Network to use', 'mutinynet')
  .option('--ark-server <url>', 'Ark server URL', DEFAULT_ARK_SERVER)
  .option('--force', 'Overwrite existing config')
  .action(async (opts) => {
    if (opts.network === 'mainnet') {
      console.error('Error: Mainnet is not supported yet. Use --network mutinynet.');
      process.exit(1);
    }

    if (configExists() && !opts.force) {
      console.error(`Error: Config already exists at ${getConfigPath()}`);
      console.error('Use --force to overwrite.');
      process.exit(1);
    }

    console.log('Generating new wallet...');

    // Generate key externally so we can store the hex
    const secretKeyBytes = utils.randomSecretKey();
    const privateKeyHex = etc.bytesToHex(secretKeyBytes);

    const signer = MockSigner.fromSecretKey(secretKeyBytes);

    const walletConfig = {
      ...MUTINYNET_CONFIG,
      arkServerUrl: opts.arkServer,
      dataDir: `${getConfigDir()}/data`,
    };

    const wallet = await GolemWallet.create(signer, walletConfig);
    const walletAddress = await wallet.getAddress();

    saveConfig({
      version: 1,
      network: opts.network,
      arkServer: opts.arkServer,
      privateKey: privateKeyHex,
      walletAddress,
      createdAt: new Date().toISOString(),
    });

    console.log('');
    console.log('Wallet initialized successfully!');
    console.log('');
    console.log(`  Network:  ${opts.network}`);
    console.log(`  Server:   ${opts.arkServer}`);
    console.log(`  Address:  ${walletAddress}`);
    console.log(`  Config:   ${getConfigPath()}`);
    console.log('');
    console.log('WARNING: Private key stored unencrypted. Do NOT use with real funds.');
    console.log('');
    console.log('Next steps:');
    console.log('  golem balance          — Check your balance');
    console.log('  golem gateway --help   — Start an L402 gateway');
  });
