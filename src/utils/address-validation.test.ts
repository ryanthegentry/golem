import { describe, it, expect } from 'vitest';
import { validateBitcoinAddress, isBitcoinAddress } from './address-validation.js';

describe('address-validation', () => {
  // Real addresses for testing (from known test vectors)

  describe('validateBitcoinAddress', () => {
    it('rejects empty address', () => {
      expect(() => validateBitcoinAddress('', 'mutinynet')).toThrow('cannot be empty');
    });

    it('rejects whitespace-only address', () => {
      expect(() => validateBitcoinAddress('   ', 'mutinynet')).toThrow('cannot be empty');
    });

    it('rejects gibberish', () => {
      expect(() => validateBitcoinAddress('notabitcoinaddress', 'mutinynet')).toThrow('checksum validation failed');
    });

    it('rejects Ark addresses (wrong bech32 prefix)', () => {
      expect(() => validateBitcoinAddress(
        'tark1qra883hysahlkt0ujcwhv0x2n278849c3m7t3a08l7fdc40f4f2nm4hpg8npfs59sm265eq7v3hshzvzdch8gdnwr6ulxlhepxnn3lg9jl0nru',
        'mutinynet'
      )).toThrow('checksum validation failed');
    });

    it('validates mainnet P2WPKH (bc1q...)', () => {
      // bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4
      const result = validateBitcoinAddress(
        'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        'mainnet'
      );
      expect(result.network).toBe('mainnet');
      expect(result.type).toBe('wpkh');
      expect(result.warnings).toHaveLength(0);
    });

    it('validates mainnet P2TR (bc1p...)', () => {
      // Taproot test vector
      const result = validateBitcoinAddress(
        'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
        'mainnet'
      );
      expect(result.network).toBe('mainnet');
      expect(result.type).toBe('tr');
      expect(result.warnings).toHaveLength(0);
    });

    it('rejects mainnet address on mutinynet', () => {
      expect(() => validateBitcoinAddress(
        'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
        'mutinynet'
      )).toThrow('Network mismatch');
    });

    it('rejects testnet address on mainnet', () => {
      // tb1 address (testnet) on mainnet should fail with network mismatch
      expect(() => validateBitcoinAddress(
        'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx',
        'mainnet'
      )).toThrow('Network mismatch');
    });

    it('warns on legacy P2PKH', () => {
      // Mainnet P2PKH
      const result = validateBitcoinAddress(
        '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
        'mainnet'
      );
      expect(result.type).toBe('pkh');
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('Legacy P2PKH');
    });

    it('trims whitespace from address', () => {
      const result = validateBitcoinAddress(
        '  bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4  ',
        'mainnet'
      );
      expect(result.address).toBe('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4');
    });
  });

  describe('isBitcoinAddress', () => {
    it('returns true for valid address', () => {
      expect(isBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mainnet')).toBe(true);
    });

    it('returns false for invalid address', () => {
      expect(isBitcoinAddress('notanaddress', 'mainnet')).toBe(false);
    });

    it('returns false for wrong network', () => {
      expect(isBitcoinAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mutinynet')).toBe(false);
    });
  });
});
