import { describe, it, expect } from 'vitest';
import { hex } from '@scure/base';
import {
  MultisigTapscript,
  CSVMultisigTapscript,
  VtxoScript,
  DefaultVtxo,
} from '@arkade-os/sdk';
import { buildCovenantVtxo } from './vtxo.js';
import {
  isCovenantVtxo,
  partitionVtxos,
  isCovenantVtxoExpiring,
} from './vtxo-detection.js';

// Deterministic test keys (32-byte x-only)
const alicePubkey = new Uint8Array(32).fill(0x01);
const serverPubkey = new Uint8Array(32).fill(0x02);
const introspectorPubkey = new Uint8Array(32).fill(0x03);

// Build the covenant VtxoScript to get its pkScript
const covenantResult = buildCovenantVtxo({
  alicePubkey,
  serverPubkey,
  introspectorBasePubkey: introspectorPubkey,
  unilateralExitDelay: 512n,
});
const covenantPkScript = covenantResult.vtxoScript.pkScript;
const covenantTapTree = covenantResult.vtxoScript.encode();

// Build a standard 2-leaf VtxoScript (DefaultVtxo-like) for comparison
const standardVtxoScript = new VtxoScript([
  MultisigTapscript.encode({ pubkeys: [alicePubkey, serverPubkey] }).script,
  CSVMultisigTapscript.encode({ timelock: { type: 'seconds', value: 512n }, pubkeys: [alicePubkey] }).script,
]);
const standardTapTree = standardVtxoScript.encode();

/** Build a fake VTXO-like object with the needed fields */
function fakeVtxo(tapTree: Uint8Array, opts?: { batchExpiry?: number; state?: string }) {
  return {
    txid: 'deadbeef',
    vout: 0,
    value: 10_000,
    tapTree,
    virtualStatus: {
      state: opts?.state ?? 'settled',
      batchExpiry: opts?.batchExpiry ?? 0,
    },
    status: { confirmed: true },
    createdAt: new Date(),
    isUnrolled: false,
    forfeitTapLeafScript: new Uint8Array(0),
    intentTapLeafScript: new Uint8Array(0),
  };
}

describe('isCovenantVtxo', () => {
  it('returns true for VTXO with matching covenant pkScript', () => {
    const vtxo = fakeVtxo(covenantTapTree);
    expect(isCovenantVtxo(vtxo as any, covenantPkScript)).toBe(true);
  });

  it('returns false for VTXO with non-matching pkScript', () => {
    const vtxo = fakeVtxo(standardTapTree);
    expect(isCovenantVtxo(vtxo as any, covenantPkScript)).toBe(false);
  });
});

describe('partitionVtxos', () => {
  it('correctly separates mixed array', () => {
    const cov1 = fakeVtxo(covenantTapTree);
    const cov2 = { ...fakeVtxo(covenantTapTree), txid: 'cov2', value: 5_000 };
    const std1 = fakeVtxo(standardTapTree);
    const mixed = [cov1, std1, cov2] as any[];
    const result = partitionVtxos(mixed, covenantPkScript);
    expect(result.covenant).toHaveLength(2);
    expect(result.standard).toHaveLength(1);
  });

  it('returns all standard when no covenant VTXOs', () => {
    const vtxos = [fakeVtxo(standardTapTree), fakeVtxo(standardTapTree)] as any[];
    const result = partitionVtxos(vtxos, covenantPkScript);
    expect(result.covenant).toHaveLength(0);
    expect(result.standard).toHaveLength(2);
  });

  it('returns all covenant when all are covenant VTXOs', () => {
    const vtxos = [fakeVtxo(covenantTapTree), fakeVtxo(covenantTapTree)] as any[];
    const result = partitionVtxos(vtxos, covenantPkScript);
    expect(result.covenant).toHaveLength(2);
    expect(result.standard).toHaveLength(0);
  });
});

describe('isCovenantVtxoExpiring', () => {
  it('returns true when batchExpiry is within margin (timestamp)', () => {
    // Expiry in 1 hour, margin is 2 hours
    const expiry = Date.now() + 60 * 60 * 1000;
    const margin = 2 * 60 * 60 * 1000;
    expect(isCovenantVtxoExpiring({ virtualStatus: { batchExpiry: expiry } } as any, margin)).toBe(true);
  });

  it('returns false when batchExpiry is far out (timestamp)', () => {
    // Expiry in 5 hours, margin is 2 hours
    const expiry = Date.now() + 5 * 60 * 60 * 1000;
    const margin = 2 * 60 * 60 * 1000;
    expect(isCovenantVtxoExpiring({ virtualStatus: { batchExpiry: expiry } } as any, margin)).toBe(false);
  });

  it('returns false when batchExpiry is 0 or undefined', () => {
    expect(isCovenantVtxoExpiring({ virtualStatus: { batchExpiry: 0 } } as any, 1000)).toBe(false);
    expect(isCovenantVtxoExpiring({ virtualStatus: {} } as any, 1000)).toBe(false);
  });

  it('returns true when block-height expiry is within threshold', () => {
    // Block height 1050, current height 1000, margin 3 days (~432 blocks at 10min)
    const marginMs = 3 * 24 * 60 * 60 * 1000;
    expect(isCovenantVtxoExpiring(
      { virtualStatus: { batchExpiry: 1050 } } as any,
      marginMs,
      1000,
    )).toBe(true);
  });

  it('returns false when block-height expiry is far out', () => {
    const marginMs = 3 * 24 * 60 * 60 * 1000; // ~432 blocks
    expect(isCovenantVtxoExpiring(
      { virtualStatus: { batchExpiry: 2000 } } as any,
      marginMs,
      1000,
    )).toBe(false);
  });
});
