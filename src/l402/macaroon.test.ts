import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  mintL402Macaroon,
  verifyL402Token,
  parseL402Header,
  formatL402Challenge,
} from './macaroon.js';

// Deterministic test fixtures
const ROOT_KEY = 'a'.repeat(64); // 32 bytes of 0xaa
const PREIMAGE = 'b'.repeat(64); // 32 bytes of 0xbb
const PAYMENT_HASH = createHash('sha256')
  .update(Buffer.from(PREIMAGE, 'hex'))
  .digest('hex');

describe('L402 Macaroons', () => {
  describe('mintL402Macaroon', () => {
    it('mints a macaroon that round-trips through serialize/deserialize', () => {
      const mac = mintL402Macaroon(ROOT_KEY, PAYMENT_HASH);

      expect(mac).toBeTruthy();
      // Should be valid base64
      expect(() => Buffer.from(mac, 'base64')).not.toThrow();

      // Should verify with correct preimage
      const result = verifyL402Token(ROOT_KEY, mac, PREIMAGE);
      expect(result.valid).toBe(true);
      expect(result.paymentHash).toBe(PAYMENT_HASH);
    });

    it('mints with custom location', () => {
      const mac = mintL402Macaroon(ROOT_KEY, PAYMENT_HASH, 'breathelocal');
      const result = verifyL402Token(ROOT_KEY, mac, PREIMAGE);
      expect(result.valid).toBe(true);
    });

    it('produces different macaroons for different payment hashes', () => {
      const otherPreimage = 'c'.repeat(64);
      const otherHash = createHash('sha256')
        .update(Buffer.from(otherPreimage, 'hex'))
        .digest('hex');

      const mac1 = mintL402Macaroon(ROOT_KEY, PAYMENT_HASH);
      const mac2 = mintL402Macaroon(ROOT_KEY, otherHash);

      expect(mac1).not.toBe(mac2);
    });
  });

  describe('verifyL402Token', () => {
    it('returns valid for correct preimage and root key', () => {
      const mac = mintL402Macaroon(ROOT_KEY, PAYMENT_HASH);
      const result = verifyL402Token(ROOT_KEY, mac, PREIMAGE);

      expect(result.valid).toBe(true);
      expect(result.paymentHash).toBe(PAYMENT_HASH);
      expect(result.error).toBeUndefined();
    });

    it('returns invalid for wrong preimage', () => {
      const mac = mintL402Macaroon(ROOT_KEY, PAYMENT_HASH);
      const wrongPreimage = 'd'.repeat(64);
      const result = verifyL402Token(ROOT_KEY, mac, wrongPreimage);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('preimage does not match payment hash');
    });

    it('returns invalid for wrong root key', () => {
      const mac = mintL402Macaroon(ROOT_KEY, PAYMENT_HASH);
      const wrongKey = 'e'.repeat(64);
      const result = verifyL402Token(wrongKey, mac, PREIMAGE);

      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid macaroon signature');
    });

    it('returns invalid for garbage macaroon', () => {
      const result = verifyL402Token(ROOT_KEY, 'not-valid-base64!!!', PREIMAGE);
      expect(result.valid).toBe(false);
    });

    it('returns invalid for tampered macaroon', () => {
      const mac = mintL402Macaroon(ROOT_KEY, PAYMENT_HASH);
      // Decode, tamper with signature, re-encode
      const json = JSON.parse(Buffer.from(mac, 'base64').toString());
      json.s = 'f'.repeat(64); // bogus signature
      const tampered = Buffer.from(JSON.stringify(json)).toString('base64');

      const result = verifyL402Token(ROOT_KEY, tampered, PREIMAGE);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid macaroon signature');
    });
  });

  describe('caveats', () => {
    it('mints with caveats and verifies them', () => {
      const caveats = ['service=breathelocal', 'tier=standard'];
      const mac = mintL402Macaroon(ROOT_KEY, PAYMENT_HASH, 'golem', caveats);

      const result = verifyL402Token(ROOT_KEY, mac, PREIMAGE, caveats);
      expect(result.valid).toBe(true);
    });

    it('fails when required caveat is missing from macaroon', () => {
      const mac = mintL402Macaroon(ROOT_KEY, PAYMENT_HASH, 'golem', ['service=api']);

      const result = verifyL402Token(ROOT_KEY, mac, PREIMAGE, [
        'service=api',
        'tier=premium', // not in the macaroon
      ]);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('missing caveat: tier=premium');
    });

    it('verification without caveat check passes even if macaroon has caveats', () => {
      const mac = mintL402Macaroon(ROOT_KEY, PAYMENT_HASH, 'golem', [
        'service=api',
        'tier=standard',
      ]);

      // Don't pass caveatsToVerify — should still pass (preimage + sig are correct)
      const result = verifyL402Token(ROOT_KEY, mac, PREIMAGE);
      expect(result.valid).toBe(true);
    });

    it('caveats change the signature', () => {
      const mac1 = mintL402Macaroon(ROOT_KEY, PAYMENT_HASH, 'golem', []);
      const mac2 = mintL402Macaroon(ROOT_KEY, PAYMENT_HASH, 'golem', ['service=api']);

      expect(mac1).not.toBe(mac2);

      // mac2 should NOT verify with mac1's (no-caveat) signature
      // Tamper test: add caveat to mac1's deserialized form without updating sig
      const json1 = JSON.parse(Buffer.from(mac1, 'base64').toString());
      json1.c = ['service=api'];
      const franken = Buffer.from(JSON.stringify(json1)).toString('base64');

      const result = verifyL402Token(ROOT_KEY, franken, PREIMAGE, ['service=api']);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('invalid macaroon signature');
    });
  });

  describe('parseL402Header', () => {
    it('parses a valid L402 header', () => {
      const mac = mintL402Macaroon(ROOT_KEY, PAYMENT_HASH);
      const header = `L402 ${mac}:${PREIMAGE}`;

      const result = parseL402Header(header);
      expect(result).not.toBeNull();
      expect(result!.macaroon).toBe(mac);
      expect(result!.preimage).toBe(PREIMAGE);
    });

    it('returns null for missing L402 prefix', () => {
      expect(parseL402Header('Bearer token123')).toBeNull();
    });

    it('returns null for missing colon separator', () => {
      expect(parseL402Header('L402 macaroononly')).toBeNull();
    });

    it('returns null for empty macaroon part', () => {
      expect(parseL402Header('L402 :preimage')).toBeNull();
    });

    it('returns null for empty preimage part', () => {
      expect(parseL402Header('L402 macaroon:')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(parseL402Header('')).toBeNull();
    });
  });

  describe('formatL402Challenge', () => {
    it('formats a valid WWW-Authenticate header', () => {
      const mac = mintL402Macaroon(ROOT_KEY, PAYMENT_HASH);
      const invoice = 'lntbs10u1ptest...';

      const challenge = formatL402Challenge(mac, invoice);

      expect(challenge).toBe(`L402 macaroon="${mac}", invoice="${invoice}"`);
      expect(challenge.startsWith('L402 ')).toBe(true);
      expect(challenge).toContain('macaroon="');
      expect(challenge).toContain('invoice="');
    });
  });

  describe('end-to-end L402 flow', () => {
    it('simulates full challenge → pay → verify cycle', () => {
      // 1. Server generates preimage and payment hash (normally from Boltz)
      const preimage = randomBytes(32).toString('hex');
      const paymentHash = createHash('sha256')
        .update(Buffer.from(preimage, 'hex'))
        .digest('hex');

      // 2. Server mints macaroon with payment hash
      const serverKey = randomBytes(32).toString('hex');
      const mac = mintL402Macaroon(serverKey, paymentHash, 'golem', [
        'service=breathelocal',
      ]);

      // 3. Server sends 402 with challenge
      const challenge = formatL402Challenge(mac, 'lntbs10u1p...');
      expect(challenge).toContain(mac);

      // 4. Consumer pays invoice, gets preimage via HTLC settlement
      // (simulated — consumer now has preimage)

      // 5. Consumer sends Authorization header
      const authHeader = `L402 ${mac}:${preimage}`;
      const parsed = parseL402Header(authHeader);
      expect(parsed).not.toBeNull();

      // 6. Server verifies
      const result = verifyL402Token(
        serverKey,
        parsed!.macaroon,
        parsed!.preimage,
        ['service=breathelocal'],
      );
      expect(result.valid).toBe(true);
      expect(result.paymentHash).toBe(paymentHash);
    });
  });
});
