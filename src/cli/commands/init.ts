/**
 * golem init — Generate a new wallet and save config to ~/.golem/config.json
 */

import * as fs from 'node:fs';
import { Command } from 'commander';
import { utils, etc } from '@noble/secp256k1';
import { MockSigner } from '../../signer/mock-signer.js';
import { encryptSecretKeySync } from '../../signer/key-crypto.js';
import { GolemWallet } from '../../wallet/golem-wallet.js';
import { walletConfigFromNetwork } from '../../wallet/config.js';
import { getNetworkConfig, toAddressNetwork, type GolemNetwork } from '../../config/networks.js';
import {
  configExists, saveConfig, getConfigPath, getConfigDir, getDataDir,
  type GolemConfig,
} from '../config.js';
import { DEFAULT_EXIT_THRESHOLD_BLOCKS, DEFAULT_ONCHAIN_RESERVE_SATS } from '../../config/defaults.js';
import { validateBitcoinAddress } from '../../utils/address-validation.js';
import { promptSecret, exitWithError } from '../wallet.js';

export const initCommand = new Command('init')
  .description('Initialize a new Golem wallet')
  .option('--network <network>', 'Network to use', 'mutinynet')
  .option('--ark-server <url>', 'Ark server URL (overrides network default)')
  .option('--force', 'Overwrite existing config')
  .option('--safe-harbor <address>', 'On-chain Bitcoin address for emergency exit')
  .option('--encrypt', 'Encrypt private key with a password (default on mainnet)')
  .option('--no-encrypt', 'Store private key unencrypted (default on testnet/mutinynet)')
  .action(async (opts) => {
    // GOLEM_NETWORK env var takes precedence over --network flag
    // (Commander's default for --network is 'mutinynet', which would shadow the env var)
    const networkName = (process.env.GOLEM_NETWORK || opts.network) as GolemNetwork;
    let netConfig;
    try {
      netConfig = getNetworkConfig(networkName);
    } catch (err) {
      exitWithError((err as Error).message);
    }

    const isMainnet = networkName === 'mainnet';
    const arkServer = opts.arkServer || netConfig.arkServerUrl;

    if (configExists() && !opts.force) {
      exitWithError(`Config already exists at ${getConfigPath()}. Use --force to overwrite.`);
    }

    // Purge stale swap state on --force to avoid cross-network 404 polling
    if (opts.force) {
      purgeSwapState();
    }

    // Mainnet: reject plaintext GOLEM_SIGNER_KEY env var
    if (isMainnet && process.env.GOLEM_SIGNER_KEY) {
      exitWithError('GOLEM_SIGNER_KEY plaintext env var is not allowed on mainnet. Use encrypted config + GOLEM_PASSWORD instead.');
    }

    // Validate safe harbor address if provided
    let safeHarborAddress: string | undefined;
    if (opts.safeHarbor) {
      try {
        const addrNetwork = toAddressNetwork(networkName);
        const validated = validateBitcoinAddress(opts.safeHarbor, addrNetwork);
        safeHarborAddress = validated.address;
        for (const warning of validated.warnings) {
          console.log(`WARNING: ${warning}`);
        }
      } catch (err) {
        exitWithError(`Invalid safe harbor address — ${(err as Error).message}`);
      }
    }

    // Mainnet requires safe harbor
    if (isMainnet && !safeHarborAddress) {
      exitWithError('Safe harbor address is required on mainnet. Use --safe-harbor <address> to set an on-chain Bitcoin address for emergency exit.');
    }

    // Determine if we should encrypt
    // Mainnet: encrypt by default, --no-encrypt opt-out (with warning)
    // Testnet/mutinynet: plaintext by default, --encrypt opt-in
    const shouldEncrypt = opts.encrypt === true || (isMainnet && opts.encrypt !== false);

    if (isMainnet && !shouldEncrypt) {
      exitWithError('--no-encrypt is not allowed on mainnet. Remove the flag to encrypt your key.');
    }

    console.log('Generating new wallet...');

    // Generate key externally so we can store the hex
    const secretKeyBytes = utils.randomSecretKey();
    const privateKeyHex = etc.bytesToHex(secretKeyBytes);

    const signer = MockSigner.fromSecretKey(secretKeyBytes);

    const walletConfig = {
      ...walletConfigFromNetwork(netConfig, `${getConfigDir()}/data`),
      arkServerUrl: arkServer,
    };

    const wallet = await GolemWallet.create(signer, walletConfig);
    const walletAddress = await wallet.getAddress();
    const boardingAddress = await wallet.getBoardingAddress();

    // Build config
    const config: GolemConfig = {
      version: 1,
      network: networkName,
      arkServer,
      walletAddress,
      createdAt: new Date().toISOString(),
      safeHarborAddress,
      safeHarborExitThresholdBlocks: DEFAULT_EXIT_THRESHOLD_BLOCKS,
      onchainReserveSats: DEFAULT_ONCHAIN_RESERVE_SATS,
    };

    if (shouldEncrypt) {
      // Get password
      const password = await getInitPassword();
      if (!password) {
        exitWithError('Password is required for encrypted wallet.');
      }
      config.encryptedKey = encryptSecretKeySync(privateKeyHex, password);
    } else {
      config.privateKey = privateKeyHex;
    }

    saveConfig(config);

    console.log('');
    console.log('Wallet initialized successfully!');
    console.log('');
    console.log(`  Network:  ${networkName}`);
    console.log(`  Server:   ${arkServer}`);
    console.log(`  Ark addr: ${walletAddress}`);
    console.log(`  Boarding: ${boardingAddress}  <-- send BTC here to fund wallet`);
    if (safeHarborAddress) {
      console.log(`  Safe harbor: ${safeHarborAddress}`);
    }
    console.log(`  Config:   ${getConfigPath()}`);
    console.log(`  Encrypted: ${shouldEncrypt ? 'yes' : 'no'}`);

    if (!shouldEncrypt) {
      console.log('');
      console.log('WARNING: Private key stored unencrypted. Do NOT use with real funds.');
      console.log('         Use --encrypt to protect with a password.');
    }

    if (!safeHarborAddress) {
      console.log('');
      console.log('WARNING: No safe harbor address set. Run `golem safe-harbor --set <address>`');
      console.log('         before depositing significant funds.');
    }

    console.log('');
    console.log('Next steps:');
    console.log('  golem balance          — Check your balance');
    console.log('  golem gateway --help   — Start an L402 gateway');
  });

async function getInitPassword(): Promise<string | null> {
  // Check env var first
  const envPassword = process.env.GOLEM_PASSWORD;
  if (envPassword) {
    if (envPassword.length < 8) {
      console.error('Error: GOLEM_PASSWORD must be at least 8 characters.');
      return null;
    }
    return envPassword;
  }

  // Interactive prompt
  if (!process.stdin.isTTY) {
    console.error('Error: --encrypt requires GOLEM_PASSWORD env var in non-interactive mode.');
    return null;
  }

  const password = await promptSecret('Enter wallet password (min 8 chars): ');
  if (password.length < 8) {
    console.error('Error: Password must be at least 8 characters.');
    return null;
  }

  const confirm = await promptSecret('Confirm password: ');
  if (password !== confirm) {
    console.error('Error: Passwords do not match.');
    return null;
  }

  return password;
}

/**
 * Remove swap collection files from the data directory.
 *
 * SwapManager persists pending swap IDs in collection_reverseSwaps and
 * collection_submarineSwaps. These are NOT scoped by network, so reiniting
 * from mutinynet to mainnet (or vice versa) causes the SwapManager to poll
 * stale swap IDs that 404 on the new network's Boltz API.
 */
function purgeSwapState(): void {
  const dataDir = getDataDir();
  if (!fs.existsSync(dataDir)) return;

  const swapFiles = ['collection_reverseSwaps', 'collection_submarineSwaps'];
  for (const name of swapFiles) {
    const filePath = `${dataDir}/${name}`;
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`Purged stale swap state: ${name}`);
    }
  }
}
