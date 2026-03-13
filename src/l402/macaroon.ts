/**
 * L402 Macaroon module — V2 binary format via the `macaroon` npm package.
 *
 * Replaces the custom JSON-based implementation with the official JS port
 * of the Go macaroon library (same as LND/Aperture). Adds:
 * - V2 binary serialization (lnget-compatible)
 * - Per-macaroon root keys via RootKeyStore
 * - Time-before caveats for replay protection
 * - Constant-time preimage verification via crypto.timingSafeEqual
 */

import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { newMacaroon, importMacaroon } from 'macaroon';

// --- Types ---

interface MintResult {
  /** Base64-encoded V2 binary macaroon */
  macaroonBase64: string;
  /** Payment hash hex (from the identifier) */
  paymentHash: string;
  /** Root key ID (hex) — used to look up the root key later */
  rootKeyId: string;
}

interface VerifyResult {
  valid: boolean;
  paymentHash?: string;
  expiresAt?: number;
  error?: string;
}

export interface RootKeyStore {
  getKey(id: string): Buffer | null;
  putKey(id: string, key: Buffer, expiresAt?: number): void;
  deleteKey(id: string): void;
  /** Remove expired keys. Returns count deleted. */
  cleanup?(): number;
}

interface MintOptions {
  /** Payment hash hex (32 bytes / 64 chars) */
  paymentHash: string;
  /** Macaroon location (default: "golem") */
  location?: string;
  /** TTL in seconds (default: 300). Added as time-before caveat. */
  ttlSeconds?: number;
  /** Additional first-party caveats */
  caveats?: string[];
}

// --- Root Key Store ---

/**
 * In-memory root key store. Keys are lost on restart.
 * For PoC/testing use.
 */
export class MemoryRootKeyStore implements RootKeyStore {
  private keys = new Map<string, Buffer>();
  private expiry = new Map<string, number>();

  getKey(id: string): Buffer | null {
    return this.keys.get(id) ?? null;
  }

  putKey(id: string, key: Buffer, expiresAt?: number): void {
    this.keys.set(id, key);
    if (expiresAt) this.expiry.set(id, expiresAt);
  }

  deleteKey(id: string): void {
    this.keys.delete(id);
    this.expiry.delete(id);
  }

  cleanup(): number {
    const now = Math.floor(Date.now() / 1000);
    const BUFFER = 3600; // 1 hour grace period after expiry
    let deleted = 0;
    for (const [id, exp] of this.expiry) {
      if (now > exp + BUFFER) {
        this.keys.delete(id);
        this.expiry.delete(id);
        deleted++;
      }
    }
    return deleted;
  }
}

/**
 * File-backed root key store. Persists keys to a JSON file with 0600 permissions.
 * Keys are stored separately from config.json.
 */
export class FileRootKeyStore implements RootKeyStore {
  private keys = new Map<string, Buffer>();
  private expiry = new Map<string, number>();
  private readonly filePath: string;

  constructor(dir: string) {
    this.filePath = path.join(dir, 'root-keys.json');
    this.load();
  }

  getKey(id: string): Buffer | null {
    return this.keys.get(id) ?? null;
  }

  putKey(id: string, key: Buffer, expiresAt?: number): void {
    this.keys.set(id, key);
    if (expiresAt) this.expiry.set(id, expiresAt);
    this.save();
  }

  deleteKey(id: string): void {
    this.keys.delete(id);
    this.expiry.delete(id);
    this.save();
  }

  getFilePath(): string {
    return this.filePath;
  }

  /** Remove root keys whose macaroon has expired (with 1-hour buffer). Returns count deleted. */
  cleanup(): number {
    const now = Math.floor(Date.now() / 1000);
    const BUFFER = 3600; // 1 hour grace period
    let deleted = 0;
    for (const [id, exp] of this.expiry) {
      if (now > exp + BUFFER) {
        this.keys.delete(id);
        this.expiry.delete(id);
        deleted++;
      }
    }
    if (deleted > 0) this.save();
    return deleted;
  }

  private load(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        for (const [id, val] of Object.entries(raw)) {
          if (typeof val === 'string') {
            // Legacy format: just hex key
            this.keys.set(id, Buffer.from(val, 'hex'));
          } else if (val && typeof val === 'object') {
            // New format: { key, expiresAt }
            const entry = val as { key: string; expiresAt?: number };
            this.keys.set(id, Buffer.from(entry.key, 'hex'));
            if (entry.expiresAt) this.expiry.set(id, entry.expiresAt);
          }
        }
      }
    } catch (err) {
      console.warn('Corrupt root key file, starting fresh:', err instanceof Error ? err.message : err);
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    fs.mkdirSync(dir, { recursive: true });
    const obj: Record<string, unknown> = {};
    for (const [id, key] of this.keys) {
      const exp = this.expiry.get(id);
      if (exp) {
        obj[id] = { key: key.toString('hex'), expiresAt: exp };
      } else {
        obj[id] = key.toString('hex');
      }
    }
    fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2) + '\n', {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }
}

// --- Identifier encoding ---

/**
 * L402 identifier: version (uint16 BE) + payment_hash (32 bytes) + token_id (32 bytes)
 * Total: 66 bytes — matches Aperture/lnget format exactly.
 *
 * The root_key_id (4 bytes) is stored in the first 4 bytes of the 32-byte token_id
 * field, with the remaining 28 bytes zero-padded. This maintains Golem's per-macaroon
 * root key scheme while being wire-compatible with lnget/Aperture's DecodeIdentifier.
 */
function buildIdentifier(paymentHash: string, rootKeyId: string): Uint8Array {
  const buf = Buffer.alloc(66);
  buf.writeUInt16BE(0, 0); // version = 0
  Buffer.from(paymentHash, 'hex').copy(buf, 2);
  Buffer.from(rootKeyId, 'hex').copy(buf, 34, 0, 4); // first 4 bytes of token_id
  // bytes 38-66 remain zero (padding)
  return new Uint8Array(buf);
}

function parseIdentifier(id: Uint8Array): { paymentHash: string; rootKeyId: string } | null {
  if (id.length < 38) return null;
  const buf = Buffer.from(id);
  const paymentHash = buf.subarray(2, 34).toString('hex');
  const rootKeyId = buf.subarray(34, 38).toString('hex');
  return { paymentHash, rootKeyId };
}

// --- Public API ---

/**
 * Mint an L402 macaroon with per-macaroon root key and time-before caveat.
 */
export function mintL402Macaroon(
  store: RootKeyStore,
  opts: MintOptions,
): MintResult {
  const { paymentHash, location = 'golem', ttlSeconds = 300, caveats = [] } = opts;

  // Generate unique root key for this macaroon
  const rootKey = randomBytes(32);
  const rootKeyId = randomBytes(4).toString('hex');

  // Store the root key with expiry for TTL-based cleanup
  const expiresAtUnix = Math.floor(Date.now() / 1000) + ttlSeconds;
  store.putKey(rootKeyId, rootKey, expiresAtUnix);

  // Build L402 identifier
  const identifier = buildIdentifier(paymentHash, rootKeyId);

  // Create macaroon via the library
  const mac = newMacaroon({
    rootKey: new Uint8Array(rootKey),
    identifier,
    location,
  });

  // Add time-before caveat
  const expiry = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  mac.addFirstPartyCaveat(`time-before ${expiry}`);

  // Add additional caveats
  for (const caveat of caveats) {
    mac.addFirstPartyCaveat(caveat);
  }

  // Export as V2 binary, then base64
  const binary = mac.exportBinary();
  const macaroonBase64 = Buffer.from(binary).toString('base64');

  return { macaroonBase64, paymentHash, rootKeyId };
}

/**
 * Verify an L402 token (macaroon + preimage).
 *
 * 1. Decode base64 → V2 binary → import macaroon
 * 2. Extract payment_hash and root_key_id from identifier
 * 3. Look up root key from store
 * 4. Verify macaroon signature (library handles HMAC chain)
 * 5. Check time-before caveat
 * 6. Verify sha256(preimage) === payment_hash (constant-time)
 */
export function verifyL402Token(
  store: RootKeyStore,
  macaroonBase64: string,
  preimageHex: string,
): VerifyResult {
  // Step 1: Import macaroon
  let mac: ReturnType<typeof importMacaroon>;
  try {
    const binary = Buffer.from(macaroonBase64, 'base64');
    mac = importMacaroon(new Uint8Array(binary));
  } catch {
    return { valid: false, error: 'failed to deserialize macaroon' };
  }

  // Step 2: Extract identifier
  const json = mac.exportJSON();
  let idBytes: Uint8Array;
  if (json.i64) {
    idBytes = new Uint8Array(Buffer.from(json.i64 as string, 'base64'));
  } else if (json.i) {
    idBytes = new Uint8Array(Buffer.from(json.i as string, 'utf-8'));
  } else {
    return { valid: false, error: 'missing identifier in macaroon' };
  }

  const parsed = parseIdentifier(idBytes);
  if (!parsed) {
    return { valid: false, error: 'invalid identifier format' };
  }

  // Step 3: Look up root key
  const rootKey = store.getKey(parsed.rootKeyId);
  if (!rootKey) {
    return { valid: false, error: 'unknown root key' };
  }

  // Step 4: Verify macaroon signature via library, extract expires_at
  let expiresAtMs: number | undefined;
  try {
    mac.verify(new Uint8Array(rootKey), (caveat: string) => {
      // Check time-before caveat
      if (caveat.startsWith('time-before ')) {
        const expiry = new Date(caveat.slice('time-before '.length));
        if (isNaN(expiry.getTime())) return 'invalid time-before format';
        if (Date.now() > expiry.getTime()) return 'macaroon expired';
        expiresAtMs = expiry.getTime();
        return null; // OK
      }
      // Check expires_at caveat (unix timestamp)
      if (caveat.startsWith('expires_at = ')) {
        const ts = parseInt(caveat.slice('expires_at = '.length), 10);
        if (isNaN(ts)) return 'invalid expires_at format';
        if (Math.floor(Date.now() / 1000) >= ts) return 'macaroon expired';
        expiresAtMs = ts * 1000;
        return null; // OK
      }
      // Allow all other first-party caveats (service=, tier=, etc.).
      // Functional enforcement of service/tier caveats is deferred to Phase 2 —
      // for now we verify the HMAC chain (caveats can't be tampered with) but
      // don't restrict access based on caveat values.
      return null;
    }, []);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('expired')) {
      return { valid: false, error: 'macaroon expired' };
    }
    return { valid: false, error: `macaroon verification failed: ${msg}` };
  }

  // Step 5: Verify preimage (constant-time comparison)
  const computedHash = createHash('sha256')
    .update(Buffer.from(preimageHex, 'hex'))
    .digest();
  const expectedHash = Buffer.from(parsed.paymentHash, 'hex');

  if (computedHash.length !== expectedHash.length ||
      !timingSafeEqual(computedHash, expectedHash)) {
    return { valid: false, error: 'preimage does not match payment hash' };
  }

  return {
    valid: true,
    paymentHash: parsed.paymentHash,
    expiresAt: expiresAtMs ? Math.floor(expiresAtMs / 1000) : undefined,
  };
}

/**
 * Mint a time-based L402 macaroon (one payment = N hours of access).
 *
 * Unlike mintL402Macaroon which uses a short-lived time-before caveat for replay protection,
 * this adds an expires_at caveat with a Unix timestamp for long-lived access tokens.
 * The HMAC chain guarantees the expires_at value cannot be tampered with.
 */
export function mintTimedL402Macaroon(
  store: RootKeyStore,
  opts: MintOptions & { durationHours: number },
): MintResult & { expiresAt: number } {
  const { durationHours, ...mintOpts } = opts;
  const expiresAt = Math.floor(Date.now() / 1000) + durationHours * 3600;

  // Use a long TTL for the time-before caveat (matches durationHours)
  // The expires_at caveat is the authoritative expiry for time-based tokens
  const result = mintL402Macaroon(store, {
    ...mintOpts,
    ttlSeconds: durationHours * 3600,
    caveats: [...(mintOpts.caveats || []), `expires_at = ${expiresAt}`],
  });

  return { ...result, expiresAt };
}

// --- Header formatting ---

/**
 * Format a 402 WWW-Authenticate header value.
 * Format: L402 macaroon="<base64_v2_binary>", invoice="<bolt11>"
 */
export function formatL402Challenge(
  macaroonBase64: string,
  invoice: string,
): string {
  return `L402 macaroon="${macaroonBase64}", invoice="${invoice}"`;
}

/**
 * Parse an L402 Authorization header.
 * Accepts both "L402 <macaroon_base64>:<preimage_hex>" and legacy
 * "LSAT <macaroon_base64>:<preimage_hex>" (Aperture sends both).
 */
export function parseL402Header(
  authHeader: string,
): { macaroon: string; preimage: string } | null {
  let token: string;
  if (authHeader.startsWith('L402 ')) {
    token = authHeader.slice(5);
  } else if (authHeader.startsWith('LSAT ')) {
    token = authHeader.slice(5);
  } else {
    return null;
  }

  const colonIdx = token.indexOf(':');
  if (colonIdx === -1) return null;

  const macaroon = token.slice(0, colonIdx);
  const preimage = token.slice(colonIdx + 1);

  if (!macaroon || !preimage) return null;

  return { macaroon, preimage };
}
