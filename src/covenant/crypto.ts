import { hex } from '@scure/base';
import { sha256 } from '@noble/hashes/sha2.js';
import { ripemd160 } from '@noble/hashes/legacy.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';

/** Bitcoin HASH160: RIPEMD160(SHA256(x)). 20-byte output. */
export function hash160(data: Uint8Array): Uint8Array {
  return ripemd160(sha256(data));
}

/** BIP-340 tagged hash: SHA256(SHA256(tag) || SHA256(tag) || msg) */
export function taggedHash(tag: string, data: Uint8Array): Uint8Array {
  const tagHash = sha256(new TextEncoder().encode(tag));
  const input = new Uint8Array(tagHash.length * 2 + data.length);
  input.set(tagHash, 0);
  input.set(tagHash, tagHash.length);
  input.set(data, tagHash.length * 2);
  return sha256(input);
}

/** Compute ArkadeScriptHash = TaggedHash("ArkScriptHash", script) */
export function arkadeScriptHash(script: Uint8Array): Uint8Array {
  return taggedHash('ArkScriptHash', script);
}

/** Compute tweaked pubkey = basePubkey + scriptHash * G (x-only output) */
export function computeTweakedKey(basePubkeyXOnly: Uint8Array, scriptHash: Uint8Array): Uint8Array {
  const Point = secp256k1.Point;
  const compressedHex = '02' + hex.encode(basePubkeyXOnly);
  const basePoint = Point.fromHex(compressedHex);
  const tweakScalar = BigInt('0x' + hex.encode(scriptHash));
  const tweakPoint = Point.BASE.multiply(tweakScalar);
  const tweakedPoint = basePoint.add(tweakPoint);
  const compressed = tweakedPoint.toBytes(true);
  return compressed.slice(1); // x-only
}
