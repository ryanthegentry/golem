/**
 * vhtlc-detection tests — covenant claim leaf detection in incoming VHTLC taproot trees.
 *
 * Detects the NonInteractiveClaim covenant leaf shape introduced in ArkLabsHQ/fulmine
 * PR #411. Match is byte-exact: we reconstruct the expected leaf from the recipe and
 * compare against the candidate. This is robust precisely because three independent
 * implementations (Fulmine PR #411, ts-sdk PR #396, Golem's own primitives) converge
 * on the same script topology.
 */

import { describe, it, expect } from 'vitest';
import { ConditionMultisigTapscript } from '@arkade-os/sdk';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { arkadeScriptHash, computeTweakedKey } from './crypto.js';
import {
  buildNonInteractiveClaimArkadeScript,
  buildCovenantClaimLeaf,
  findCovenantClaimLeaf,
} from './vhtlc-detection.js';

function detPattern(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = ((i + 1) * (seed + 7)) & 0xff;
  return out;
}

/** Derive a valid 32-byte x-only secp256k1 pubkey from a fixed scalar seed. */
function xOnlyPubkey(seed: number): Uint8Array {
  const sk = detPattern(32, seed);
  sk[0] = (sk[0] | 0x01) & 0x7f; // keep scalar < n and non-zero
  const compressed = secp256k1.getPublicKey(sk, true);
  return compressed.slice(1);
}

function p2tr(wp: Uint8Array): Uint8Array {
  if (wp.length !== 32) throw new Error('test bug');
  return new Uint8Array([0x51, 0x20, ...wp]);
}

const SERVER_PK = xOnlyPubkey(1);
const INTROSPECTOR_PK = xOnlyPubkey(2);
const RECEIVER_WP = xOnlyPubkey(3);
const RECEIVER_PKSCRIPT = p2tr(RECEIVER_WP);
const PREIMAGE_HASH = detPattern(20, 41);

describe('buildNonInteractiveClaimArkadeScript', () => {
  it('matches PR #411 enforcePayTo byte-for-byte', () => {
    // PR #411 noninteractive.go enforcePayTo:
    //   OP_PUSHCURRENTINPUTINDEX 0xcd
    //   OP_DUP                   0x76
    //   OP_INSPECTOUTPUTSCRIPTPUBKEY 0xd1
    //   OP_1                     0x51
    //   OP_EQUALVERIFY           0x88
    //   AddData(32-byte WP)      0x20 ...
    //   OP_EQUALVERIFY           0x88
    //   OP_INSPECTOUTPUTVALUE    0xcf
    //   OP_PUSHCURRENTINPUTINDEX 0xcd
    //   OP_INSPECTINPUTVALUE     0xc9
    //   OP_GREATERTHANOREQUAL    0xa2
    const script = buildNonInteractiveClaimArkadeScript(RECEIVER_PKSCRIPT);
    expect(Array.from(script)).toEqual([
      0xcd, 0x76, 0xd1, 0x51, 0x88,
      0x20, ...Array.from(RECEIVER_WP),
      0x88,
      0xcf, 0xcd, 0xc9, 0xa2,
    ]);
    // Total length = 5 + 33 + 1 + 4 = 43 bytes.
    expect(script.length).toBe(43);
  });

  it('rejects pkScript with wrong length', () => {
    expect(() => buildNonInteractiveClaimArkadeScript(new Uint8Array(33))).toThrow(/34-byte/);
    expect(() => buildNonInteractiveClaimArkadeScript(new Uint8Array(35))).toThrow(/34-byte/);
  });

  it('rejects pkScript with wrong prefix (non-P2TR)', () => {
    const bad = new Uint8Array(34);
    bad[0] = 0x52; // OP_2 instead of OP_1
    bad[1] = 0x20;
    expect(() => buildNonInteractiveClaimArkadeScript(bad)).toThrow(/P2TR/);
  });

  it('rejects pkScript with wrong push length byte', () => {
    const bad = new Uint8Array(34);
    bad[0] = 0x51;
    bad[1] = 0x21; // 33-byte push instead of 32
    expect(() => buildNonInteractiveClaimArkadeScript(bad)).toThrow(/P2TR/);
  });
});

describe('buildCovenantClaimLeaf', () => {
  it('produces tweaked key = computeTweakedKey(introspectorPK, arkadeScriptHash(enforcePayTo))', () => {
    const desc = buildCovenantClaimLeaf({
      serverPubKey: SERVER_PK,
      introspectorPubKey: INTROSPECTOR_PK,
      receiverPkScript: RECEIVER_PKSCRIPT,
      preimageHash: PREIMAGE_HASH,
    });

    const enforce = buildNonInteractiveClaimArkadeScript(RECEIVER_PKSCRIPT);
    const expectedTweak = computeTweakedKey(INTROSPECTOR_PK, arkadeScriptHash(enforce));

    expect(Array.from(desc.introspectorTweakedKey)).toEqual(Array.from(expectedTweak));
    expect(Array.from(desc.enforcePayToScript)).toEqual(Array.from(enforce));
  });

  it('conditionScript is HASH160 <preimageHash> EQUAL (no VERIFY)', () => {
    const desc = buildCovenantClaimLeaf({
      serverPubKey: SERVER_PK,
      introspectorPubKey: INTROSPECTOR_PK,
      receiverPkScript: RECEIVER_PKSCRIPT,
      preimageHash: PREIMAGE_HASH,
    });
    expect(Array.from(desc.conditionScript)).toEqual([
      0xa9, 0x14, ...Array.from(PREIMAGE_HASH), 0x87,
    ]);
  });

  it('leafScript equals ConditionMultisigTapscript.encode([server, tweakedIntrospector], conditionScript)', () => {
    const desc = buildCovenantClaimLeaf({
      serverPubKey: SERVER_PK,
      introspectorPubKey: INTROSPECTOR_PK,
      receiverPkScript: RECEIVER_PKSCRIPT,
      preimageHash: PREIMAGE_HASH,
    });
    const reference = ConditionMultisigTapscript.encode({
      conditionScript: desc.conditionScript,
      pubkeys: [SERVER_PK, desc.introspectorTweakedKey],
    }).script;
    expect(Array.from(desc.leafScript)).toEqual(Array.from(reference));
  });

  it('rejects invalid recipe (wrong server pubkey length)', () => {
    expect(() =>
      buildCovenantClaimLeaf({
        serverPubKey: new Uint8Array(33),
        introspectorPubKey: INTROSPECTOR_PK,
        receiverPkScript: RECEIVER_PKSCRIPT,
        preimageHash: PREIMAGE_HASH,
      }),
    ).toThrow(/serverPubKey/);
  });

  it('rejects invalid recipe (wrong preimage hash length)', () => {
    expect(() =>
      buildCovenantClaimLeaf({
        serverPubKey: SERVER_PK,
        introspectorPubKey: INTROSPECTOR_PK,
        receiverPkScript: RECEIVER_PKSCRIPT,
        preimageHash: new Uint8Array(32),
      }),
    ).toThrow(/preimageHash/);
  });
});

describe('findCovenantClaimLeaf', () => {
  function makeRecipe() {
    return {
      serverPubKey: SERVER_PK,
      introspectorPubKey: INTROSPECTOR_PK,
      receiverPkScript: RECEIVER_PKSCRIPT,
      preimageHash: PREIMAGE_HASH,
    };
  }

  it('finds the leaf when present in the tree', () => {
    const expected = buildCovenantClaimLeaf(makeRecipe()).leafScript;
    const tree = [
      detPattern(30, 99),    // unrelated bytes
      expected,              // our target
      detPattern(50, 88),    // unrelated bytes
    ];
    const found = findCovenantClaimLeaf(tree, makeRecipe());
    expect(found).not.toBeNull();
    expect(Array.from(found!.leafScript)).toEqual(Array.from(expected));
  });

  it('returns null when no candidate matches', () => {
    const tree = [detPattern(43, 1), detPattern(43, 2), detPattern(60, 3)];
    expect(findCovenantClaimLeaf(tree, makeRecipe())).toBeNull();
  });

  it('rejects when introspector pubkey differs', () => {
    const fakeLeaf = buildCovenantClaimLeaf({
      ...makeRecipe(),
      introspectorPubKey: xOnlyPubkey(42),
    }).leafScript;
    expect(findCovenantClaimLeaf([fakeLeaf], makeRecipe())).toBeNull();
  });

  it('rejects when receiver pkScript differs', () => {
    const fakeLeaf = buildCovenantClaimLeaf({
      ...makeRecipe(),
      receiverPkScript: p2tr(xOnlyPubkey(43)),
    }).leafScript;
    expect(findCovenantClaimLeaf([fakeLeaf], makeRecipe())).toBeNull();
  });

  it('rejects when preimage hash differs', () => {
    const otherHash = detPattern(20, 99);
    const fakeLeaf = buildCovenantClaimLeaf({
      ...makeRecipe(),
      preimageHash: otherHash,
    }).leafScript;
    expect(findCovenantClaimLeaf([fakeLeaf], makeRecipe())).toBeNull();
  });

  it('rejects when server pubkey differs', () => {
    const fakeLeaf = buildCovenantClaimLeaf({
      ...makeRecipe(),
      serverPubKey: xOnlyPubkey(44),
    }).leafScript;
    expect(findCovenantClaimLeaf([fakeLeaf], makeRecipe())).toBeNull();
  });

  it('finds the leaf via the SDK decode path (ConditionMultisigTapscript.is)', () => {
    const desc = buildCovenantClaimLeaf(makeRecipe());
    // Round-trip through SDK to ensure the bytes we produce are valid ConditionMultisig.
    const decoded = ConditionMultisigTapscript.decode(desc.leafScript);
    expect(ConditionMultisigTapscript.is(decoded)).toBe(true);
    expect(decoded.params.pubkeys.length).toBe(2);
    expect(Array.from(decoded.params.pubkeys[0])).toEqual(Array.from(SERVER_PK));
    expect(Array.from(decoded.params.pubkeys[1])).toEqual(Array.from(desc.introspectorTweakedKey));
    expect(Array.from(decoded.params.conditionScript)).toEqual(Array.from(desc.conditionScript));
  });
});
