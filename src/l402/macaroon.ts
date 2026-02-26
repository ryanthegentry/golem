/**
 * L402 Macaroon utilities for Golem Gateway.
 *
 * Manual implementation — the macaroon npm packages have poor TypeScript
 * support and heavyweight dependencies. The L402 macaroon format is simple:
 *
 * Identifier: version (2 bytes, uint16 BE, value 0) + payment_hash (32 bytes)
 * Signature:  HMAC-SHA256 chain starting from root key
 * Caveats:    First-party only, each caveat updates the signature via HMAC
 */

import { createHmac, createHash } from 'node:crypto';

// --- Internal types ---

interface Macaroon {
  location: string;
  identifier: Buffer;   // 2-byte version + 32-byte payment_hash
  caveats: string[];
  signature: Buffer;     // 32-byte HMAC-SHA256
}

// --- Helpers ---

function hmacSha256(key: Buffer, data: Buffer): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function deriveMacaroonKey(rootKey: Buffer): Buffer {
  // Macaroon spec: derive key = HMAC-SHA256(key="macaroons-key-generator", rootKey)
  return hmacSha256(Buffer.from('macaroons-key-generator'), rootKey);
}

function computeSignature(derivedKey: Buffer, identifier: Buffer, caveats: string[]): Buffer {
  // sig = HMAC(derivedKey, identifier)
  let sig = hmacSha256(derivedKey, identifier);
  // For each caveat: sig = HMAC(sig, caveat)
  for (const caveat of caveats) {
    sig = hmacSha256(sig, Buffer.from(caveat, 'utf-8'));
  }
  return sig;
}

function serializeMacaroon(m: Macaroon): string {
  // Simple JSON-based serialization encoded as base64.
  // Production L402 uses libmacaroons binary format, but JSON is fine for PoC
  // and interop testing — the spec doesn't mandate wire format for the token.
  const obj = {
    l: m.location,
    i: m.identifier.toString('hex'),
    c: m.caveats,
    s: m.signature.toString('hex'),
  };
  return Buffer.from(JSON.stringify(obj)).toString('base64');
}

function deserializeMacaroon(base64: string): Macaroon | null {
  try {
    const json = Buffer.from(base64, 'base64').toString('utf-8');
    const obj = JSON.parse(json);
    return {
      location: obj.l,
      identifier: Buffer.from(obj.i, 'hex'),
      caveats: obj.c ?? [],
      signature: Buffer.from(obj.s, 'hex'),
    };
  } catch {
    return null;
  }
}

function buildIdentifier(paymentHash: string): Buffer {
  // L402 identifier: version (uint16 BE, value 0) + payment_hash (32 bytes)
  const buf = Buffer.alloc(34);
  buf.writeUInt16BE(0, 0);  // version = 0
  Buffer.from(paymentHash, 'hex').copy(buf, 2);
  return buf;
}

function extractPaymentHash(identifier: Buffer): string | null {
  if (identifier.length !== 34) return null;
  return identifier.subarray(2, 34).toString('hex');
}

// --- Public API ---

/**
 * Mint a new L402 macaroon for a payment challenge.
 *
 * The identifier encodes: version (0) + payment_hash (32 bytes).
 * Signature is HMAC-SHA256 chain from derived root key.
 *
 * @param rootKey - Server's root key (32 bytes, hex). Keep secret.
 * @param paymentHash - sha256 of the preimage (hex, from createLightningInvoice)
 * @param location - Macaroon location field (default: "golem")
 * @param caveats - Optional first-party caveats, e.g. ["service=api", "tier=standard"]
 * @returns Base64-encoded serialized macaroon
 */
export function mintL402Macaroon(
  rootKey: string,
  paymentHash: string,
  location = 'golem',
  caveats: string[] = [],
): string {
  const identifier = buildIdentifier(paymentHash);
  const derivedKey = deriveMacaroonKey(Buffer.from(rootKey, 'hex'));
  const signature = computeSignature(derivedKey, identifier, caveats);

  return serializeMacaroon({
    location,
    identifier,
    caveats,
    signature,
  });
}

/**
 * Verify an L402 token (macaroon + preimage).
 *
 * 1. Deserialize macaroon
 * 2. Extract payment_hash from identifier
 * 3. Verify sha256(preimage) === payment_hash
 * 4. Recompute and verify HMAC signature
 * 5. Check caveats if provided
 */
export function verifyL402Token(
  rootKey: string,
  macaroonBase64: string,
  preimage: string,
  caveatsToVerify?: string[],
): { valid: boolean; paymentHash?: string; error?: string } {
  const m = deserializeMacaroon(macaroonBase64);
  if (!m) {
    return { valid: false, error: 'failed to deserialize macaroon' };
  }

  // Extract payment hash from identifier
  const paymentHash = extractPaymentHash(m.identifier);
  if (!paymentHash) {
    return { valid: false, error: 'invalid identifier length' };
  }

  // Verify preimage: sha256(preimage) must equal payment_hash
  const computedHash = createHash('sha256')
    .update(Buffer.from(preimage, 'hex'))
    .digest('hex');
  if (computedHash !== paymentHash) {
    return { valid: false, error: 'preimage does not match payment hash' };
  }

  // Verify signature
  const derivedKey = deriveMacaroonKey(Buffer.from(rootKey, 'hex'));
  const expectedSig = computeSignature(derivedKey, m.identifier, m.caveats);
  if (!expectedSig.equals(m.signature)) {
    return { valid: false, error: 'invalid macaroon signature' };
  }

  // Verify caveats — each required caveat must be present in the macaroon
  if (caveatsToVerify) {
    for (const required of caveatsToVerify) {
      if (!m.caveats.includes(required)) {
        return { valid: false, error: `missing caveat: ${required}` };
      }
    }
  }

  return { valid: true, paymentHash };
}

/**
 * Parse an L402 Authorization header.
 * Format: "L402 <macaroon_base64>:<preimage_hex>"
 */
export function parseL402Header(
  authHeader: string,
): { macaroon: string; preimage: string } | null {
  if (!authHeader.startsWith('L402 ')) return null;

  const token = authHeader.slice(5);
  const colonIdx = token.indexOf(':');
  if (colonIdx === -1) return null;

  const macaroon = token.slice(0, colonIdx);
  const preimage = token.slice(colonIdx + 1);

  if (!macaroon || !preimage) return null;

  return { macaroon, preimage };
}

/**
 * Format a 402 WWW-Authenticate header value.
 * Format: L402 macaroon="<base64>", invoice="<bolt11>"
 */
export function formatL402Challenge(
  macaroonBase64: string,
  invoice: string,
): string {
  return `L402 macaroon="${macaroonBase64}", invoice="${invoice}"`;
}
