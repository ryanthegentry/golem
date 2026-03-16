/**
 * L402 Macaroon Interop Tests — validates V2 binary format for cross-language compatibility.
 *
 * Verifies that Golem-minted macaroons are wire-compatible with lnget (Go) and
 * Aperture's DecodeIdentifier. Exports a fixture file for Go-side interop testing.
 */

import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  mintL402Macaroon,
  MemoryRootKeyStore,
} from './macaroon.js';

function makePreimage(): { preimage: string; paymentHash: string } {
  const preimage = randomBytes(32).toString('hex');
  const paymentHash = createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest('hex');
  return { preimage, paymentHash };
}

describe('L402 Macaroon Interop — V2 binary format', () => {
  it('mints a macaroon and exports valid base64', () => {
    const store = new MemoryRootKeyStore();
    const { paymentHash } = makePreimage();
    const result = mintL402Macaroon(store, { paymentHash, location: 'golem', ttlSeconds: 300 });

    expect(result.macaroonBase64).toBeTruthy();
    expect(result.paymentHash).toBe(paymentHash);

    // Should be valid base64
    const binary = Buffer.from(result.macaroonBase64, 'base64');
    expect(binary.length).toBeGreaterThan(0);
    // Re-encoding should match
    expect(binary.toString('base64')).toBe(result.macaroonBase64);
  });

  it('V2 binary starts with 0x02 version byte', () => {
    const store = new MemoryRootKeyStore();
    const { paymentHash } = makePreimage();
    const result = mintL402Macaroon(store, { paymentHash });

    const binary = Buffer.from(result.macaroonBase64, 'base64');
    // V2 binary macaroons start with 0x02
    expect(binary[0]).toBe(0x02);
  });

  it('V2 TLV structure contains LOCATION, IDENTIFIER, and SIGNATURE fields', () => {
    const store = new MemoryRootKeyStore();
    const { paymentHash } = makePreimage();
    const result = mintL402Macaroon(store, { paymentHash, location: 'golem' });

    const binary = Buffer.from(result.macaroonBase64, 'base64');

    // Parse V2 TLV: version byte (0x02), then sections separated by EOS (0x00 0x00).
    // Top-level section has: 1=LOCATION, 2=IDENTIFIER
    // Caveat sections have: 2=CAVEAT_ID (repeats per caveat)
    // Tail has: 0x00 0x00 (final EOS), 6=SIGNATURE
    // Field types: 1=LOCATION, 2=IDENTIFIER/CAVEAT_ID, 6=SIGNATURE
    let offset = 1; // skip version byte 0x02
    const fields = new Map<number, Buffer>();

    while (offset < binary.length) {
      const fieldType = binary[offset++];
      if (fieldType === 0) {
        // EOS marker is a single 0x00 byte — no varint follows
        continue;
      }

      // Read varint length
      let length = 0;
      let shift = 0;
      while (offset < binary.length) {
        const b = binary[offset++];
        length |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }

      const data = binary.subarray(offset, offset + length);
      // Store first occurrence of each field type
      if (!fields.has(fieldType)) {
        fields.set(fieldType, Buffer.from(data));
      }
      offset += length;
    }

    // LOCATION field (type 1) = "golem"
    expect(fields.has(1)).toBe(true);
    expect(fields.get(1)!.toString('utf-8')).toBe('golem');

    // IDENTIFIER field (type 2) should be exactly 66 bytes
    expect(fields.has(2)).toBe(true);
    expect(fields.get(2)!.length).toBe(66);

    // SIGNATURE field (type 6) should be present (32 bytes HMAC)
    expect(fields.has(6)).toBe(true);
    expect(fields.get(6)!.length).toBe(32);
  });

  it('66-byte identifier matches Aperture format: version(2) + payment_hash(32) + token_id(32)', () => {
    const store = new MemoryRootKeyStore();
    const { paymentHash } = makePreimage();
    const result = mintL402Macaroon(store, { paymentHash, location: 'golem' });

    const binary = Buffer.from(result.macaroonBase64, 'base64');

    // Extract identifier from TLV (first field type 2 in the top-level section)
    let offset = 1;
    let identifier: Buffer | null = null;
    while (offset < binary.length) {
      const fieldType = binary[offset++];
      if (fieldType === 0) {
        // EOS marker is a single 0x00 byte — no varint follows
        continue;
      }
      let length = 0;
      let shift = 0;
      while (offset < binary.length) {
        const b = binary[offset++];
        length |= (b & 0x7f) << shift;
        if ((b & 0x80) === 0) break;
        shift += 7;
      }
      if (fieldType === 2 && !identifier) {
        identifier = Buffer.from(binary.subarray(offset, offset + length));
      }
      offset += length;
    }

    expect(identifier).not.toBeNull();
    expect(identifier!.length).toBe(66);

    // Version: uint16 BE = 0 (Golem uses version 0)
    const version = identifier!.readUInt16BE(0);
    expect(version).toBe(0);

    // Payment hash: bytes 2-33 (32 bytes)
    const extractedHash = identifier!.subarray(2, 34).toString('hex');
    expect(extractedHash).toBe(paymentHash);

    // Token ID: bytes 34-65 (32 bytes) — first 4 bytes are root_key_id
    const rootKeyIdFromIdentifier = identifier!.subarray(34, 38).toString('hex');
    expect(rootKeyIdFromIdentifier).toBe(result.rootKeyId);

    // Remaining 28 bytes should be zero-padded
    const padding = identifier!.subarray(38, 66);
    expect(padding.every(b => b === 0)).toBe(true);
  });

  it('exports fixture file for Go interop testing', () => {
    const store = new MemoryRootKeyStore();
    const preimage = randomBytes(32).toString('hex');
    const paymentHash = createHash('sha256')
      .update(Buffer.from(preimage, 'hex'))
      .digest('hex');

    const result = mintL402Macaroon(store, {
      paymentHash,
      location: 'golem',
      ttlSeconds: 86400, // 24h for stable fixture
      caveats: [],
    });

    const fixture = {
      description: 'Golem-minted L402 V2 binary macaroon for Go interop testing',
      macaroon_base64: result.macaroonBase64,
      payment_hash: result.paymentHash,
      root_key_id: result.rootKeyId,
      preimage,
      location: 'golem',
      identifier_length: 66,
      format: 'V2 binary (TLV)',
      identifier_layout: {
        version: { offset: 0, length: 2, value: 0 },
        payment_hash: { offset: 2, length: 32 },
        token_id: { offset: 34, length: 32, note: 'first 4 bytes = root_key_id, rest zero-padded' },
      },
    };

    const fixtureDir = path.join(process.cwd(), 'test-fixtures');
    fs.mkdirSync(fixtureDir, { recursive: true });
    const fixturePath = path.join(fixtureDir, 'golem-macaroon-interop.json');
    fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2) + '\n');

    // Verify fixture was written
    expect(fs.existsSync(fixturePath)).toBe(true);
    const loaded = JSON.parse(fs.readFileSync(fixturePath, 'utf-8'));
    expect(loaded.macaroon_base64).toBe(result.macaroonBase64);
    expect(loaded.payment_hash).toBe(paymentHash);
    expect(loaded.preimage).toBe(preimage);
  });
});
