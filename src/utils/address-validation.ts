/**
 * Bitcoin address validation using @scure/btc-signer.
 *
 * Validates checksum (bech32/bech32m BCH, base58check double-SHA256),
 * detects address type (P2PKH, P2SH, P2WPKH, P2WSH, P2TR), and
 * enforces network match (mainnet, testnet, mutinynet/regtest).
 *
 * No new dependencies — @scure/btc-signer is already installed.
 */

import { Address, NETWORK, TEST_NETWORK } from '@scure/btc-signer';

/** Regtest/mutinynet: same key prefixes as testnet, but bech32 prefix is 'bcrt' */
const REGTEST_NETWORK = {
  bech32: 'bcrt',
  pubKeyHash: 0x6f,
  scriptHash: 0xc4,
  wif: 0xef,
} as const;

type BitcoinAddressType = 'pkh' | 'sh' | 'wpkh' | 'wsh' | 'tr';
export type BitcoinNetwork = 'mainnet' | 'testnet' | 'mutinynet';

interface ValidatedAddress {
  address: string;
  type: BitcoinAddressType;
  network: BitcoinNetwork;
  warnings: string[];
}

/**
 * Map Golem network names to @scure/btc-signer network configs.
 *
 * Mutinynet uses regtest-style bcrt1... addresses. Testnet uses tb1...
 * Both share the same base58 prefixes (0x6f for P2PKH, 0xc4 for P2SH).
 */
function getNetworkConfig(network: BitcoinNetwork) {
  switch (network) {
    case 'mainnet': return NETWORK;
    case 'testnet': return TEST_NETWORK;
    case 'mutinynet': return REGTEST_NETWORK;
    default: throw new Error(`Unknown network: ${network satisfies never}`);
  }
}

/**
 * Detect which network an address belongs to by trying each codec.
 * Returns null if the address is invalid on all networks.
 */
function detectNetwork(address: string): BitcoinNetwork | null {
  const networks: BitcoinNetwork[] = ['mainnet', 'testnet', 'mutinynet'];
  for (const net of networks) {
    try {
      Address(getNetworkConfig(net)).decode(address);
      return net;
    } catch {
      // try next
    }
  }
  return null;
}

/**
 * Validate a Bitcoin address for use as a safe harbor destination.
 *
 * Checks:
 * 1. Valid checksum (bech32/bech32m or base58check)
 * 2. Network matches the expected Golem network
 * 3. Not an Ark address (tark1... fails automatically — wrong bech32 prefix)
 * 4. Warns on legacy P2PKH (higher receive fees)
 *
 * @throws Error with descriptive message on invalid address
 */
export function validateBitcoinAddress(
  address: string,
  expectedNetwork: BitcoinNetwork,
): ValidatedAddress {
  if (!address || address.trim().length === 0) {
    throw new Error('Address cannot be empty');
  }

  const trimmed = address.trim();

  // Detect which network the address belongs to
  const detectedNetwork = detectNetwork(trimmed);
  if (detectedNetwork === null) {
    throw new Error(
      `Invalid Bitcoin address: checksum validation failed. ` +
      `Make sure this is a valid on-chain Bitcoin address (not an Ark address).`
    );
  }

  // Enforce network match
  if (detectedNetwork !== expectedNetwork) {
    throw new Error(
      `Network mismatch: address belongs to ${detectedNetwork}, ` +
      `but wallet is configured for ${expectedNetwork}. ` +
      `Use a ${expectedNetwork} address.`
    );
  }

  // Decode with the matched network to get type info
  const codec = Address(getNetworkConfig(detectedNetwork));
  const decoded = codec.decode(trimmed);

  const type = decoded.type as BitcoinAddressType;
  const warnings: string[] = [];

  // Warn on legacy P2PKH — higher receive fees
  if (type === 'pkh') {
    warnings.push(
      'Legacy P2PKH address detected. Segwit (bc1... / tb1... / bcrt1...) ' +
      'is recommended for lower fees.'
    );
  }

  return { address: trimmed, type, network: detectedNetwork, warnings };
}

/**
 * Check if a string is a valid Bitcoin address (no throw).
 */
export function isBitcoinAddress(address: string, network: BitcoinNetwork): boolean {
  try {
    validateBitcoinAddress(address, network);
    return true;
  } catch {
    return false;
  }
}
