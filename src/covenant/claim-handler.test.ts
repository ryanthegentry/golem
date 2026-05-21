/**
 * CovenantClaimHandler tests — self-solver claim path for incoming covenant VHTLCs.
 *
 * Mocks the SDK's `buildOffchainTx` and our `submitCovenantTx` to verify the
 * orchestration logic (detection, claim tx assembly, persistence) without needing
 * a real regtest stack. End-to-end validation against Fulmine lives in T7's
 * regtest E2E.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hex } from '@scure/base';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { VtxoScript } from '@arkade-os/sdk';
import { CovenantClaimsRepo } from '../storage/covenant-claims-repo.js';
import { buildCovenantVtxo } from './vtxo.js';
import { buildCovenantClaimLeaf } from './vhtlc-detection.js';
import { hash160 } from './crypto.js';
import { CovenantClaimHandler } from './claim-handler.js';

// Mock the SDK's buildOffchainTx (we don't have a real arkd here).
vi.mock('@arkade-os/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arkade-os/sdk')>();
  return {
    ...actual,
    buildOffchainTx: vi.fn(),
  };
});

// Mock our submitCovenantTx (would otherwise call out to a real Introspector).
vi.mock('./introspector.js', () => ({
  submitCovenantTx: vi.fn(),
  submitIntrospectorTx: vi.fn(),
}));

function detBytes(n: number, seed: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = ((i + 1) * (seed + 7)) & 0xff;
  return out;
}

function xOnlyPubkey(seed: number): Uint8Array {
  const sk = detBytes(32, seed);
  sk[0] = (sk[0] | 0x01) & 0x7f;
  return secp256k1.getPublicKey(sk, true).slice(1);
}

const SERVER_PK = xOnlyPubkey(1);
const INTROSPECTOR_PK = xOnlyPubkey(2);
const ALICE_PK = xOnlyPubkey(3);
const PREIMAGE = detBytes(32, 11);
const PREIMAGE_HASH = hash160(PREIMAGE);

// Build the receiver's covenant vtxo + recipe. The handler needs:
//   - receiverVtxoScript (where the claim's output should land)
//   - receiverPkScript (what the covenant pins to)
const receiverCovenant = buildCovenantVtxo({
  alicePubkey: ALICE_PK,
  serverPubkey: SERVER_PK,
  introspectorBasePubkey: INTROSPECTOR_PK,
  unilateralExitDelay: 512n,
});

// Build the expected covenant claim leaf the handler should find in a VHTLC.
const expectedClaimLeaf = buildCovenantClaimLeaf({
  serverPubKey: SERVER_PK,
  introspectorPubKey: INTROSPECTOR_PK,
  receiverPkScript: receiverCovenant.vtxoScript.pkScript,
  preimageHash: PREIMAGE_HASH,
});

// A mock arkTx that captures its serialized bytes and accepts get/updateInput.
function makeMockArkTx(label: number) {
  const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef, label & 0xff]);
  const inputs: Array<any> = [];
  return {
    unsignedTx: bytes,
    toPSBT: () => new Uint8Array(10),
    getInput: (i: number) => inputs[i] ?? (inputs[i] = {}),
    updateInput: (i: number, patch: any) => {
      if (!inputs[i]) inputs[i] = {};
      Object.assign(inputs[i], patch);
    },
  };
}

function mkRepo(): { repo: CovenantClaimsRepo; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-cch-'));
  return { repo: new CovenantClaimsRepo(path.join(dir, 'c.db')), dir };
}

// A VHTLC VtxoScript containing the expected covenant claim leaf and a few decoys.
function makeVhtlcWithCovenant(): { tree: VtxoScript; outpoint: { txid: string; vout: number; value: number } } {
  // Tree must satisfy VtxoScript constraints — at minimum a non-empty leaf set.
  // For this unit test we only need the leaf set; the test never actually executes
  // the script, so we can include arbitrary other leaves as decoys.
  const decoy1 = new Uint8Array([0x76, 0x76, 0x76]); // unrelated
  const decoy2 = new Uint8Array([0x51, 0x52, 0x53]); // unrelated
  const tree = new VtxoScript([decoy1, expectedClaimLeaf.leafScript, decoy2]);
  return { tree, outpoint: { txid: 'cafebabe' + 'aa'.repeat(28), vout: 0, value: 50_000 } };
}

const mockServerUnrollScript = {} as any;
const mockArkProvider = {
  submitTx: vi.fn(),
  finalizeTx: vi.fn(),
  getInfo: vi.fn(),
} as any;

describe('CovenantClaimHandler.processVHTLC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns not-covenant when no matching leaf is in the tree', async () => {
    const { repo, dir } = mkRepo();
    try {
      const handler = new CovenantClaimHandler(repo);
      // Build a tree with two covenant leaves for DIFFERENT preimages so detection misses.
      const otherLeaf1 = buildCovenantClaimLeaf({
        serverPubKey: SERVER_PK,
        introspectorPubKey: INTROSPECTOR_PK,
        receiverPkScript: receiverCovenant.vtxoScript.pkScript,
        preimageHash: detBytes(20, 99),
      }).leafScript;
      const otherLeaf2 = buildCovenantClaimLeaf({
        serverPubKey: SERVER_PK,
        introspectorPubKey: INTROSPECTOR_PK,
        receiverPkScript: receiverCovenant.vtxoScript.pkScript,
        preimageHash: detBytes(20, 77),
      }).leafScript;
      const tree = new VtxoScript([otherLeaf1, otherLeaf2]);
      const result = await handler.processVHTLC({
        vhtlc: {
          txid: 'aabb', vout: 0, value: 10_000,
          tree,
        },
        preimage: PREIMAGE,
        serverPubKey: SERVER_PK,
        introspectorPubKey: INTROSPECTOR_PK,
        receiverVtxoScript: receiverCovenant.vtxoScript,
        serverUnrollScript: mockServerUnrollScript,
        introspectorUrl: 'http://localhost:7073',
        arkProvider: mockArkProvider,
      });
      expect(result.status).toBe('not-covenant');
      expect(result.txid).toBeUndefined();
      // Nothing persisted.
      expect(repo.countByStatus('claimed')).toBe(0);
    } finally {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('claims and persists prevTxBytes when covenant leaf is present', async () => {
    const { buildOffchainTx } = await import('@arkade-os/sdk');
    const { submitCovenantTx } = await import('./introspector.js');

    const mockTx = makeMockArkTx(1);
    vi.mocked(buildOffchainTx).mockReturnValue({
      arkTx: mockTx as any,
      checkpoints: [makeMockArkTx(99) as any], // mock checkpoint w/ getInput/updateInput for setConditionWitness
    });
    vi.mocked(submitCovenantTx).mockResolvedValue('claim-txid-abc');

    const { repo, dir } = mkRepo();
    try {
      const handler = new CovenantClaimHandler(repo);
      const { tree, outpoint } = makeVhtlcWithCovenant();
      const result = await handler.processVHTLC({
        vhtlc: { ...outpoint, tree },
        preimage: PREIMAGE,
        serverPubKey: SERVER_PK,
        introspectorPubKey: INTROSPECTOR_PK,
        receiverVtxoScript: receiverCovenant.vtxoScript,
        serverUnrollScript: mockServerUnrollScript,
        introspectorUrl: 'http://localhost:7073',
        arkProvider: mockArkProvider,
      });

      expect(result.status).toBe('claimed');
      expect(result.txid).toBe('claim-txid-abc');
      expect(result.vout).toBe(0);
      expect(result.prevTxBytes).toBeDefined();
      // The prevTxBytes are the arkTx.unsignedTx that we captured.
      expect(Array.from(result.prevTxBytes!)).toEqual([0xde, 0xad, 0xbe, 0xef, 0x01]);

      // Repo should have a row keyed by `${claimTxid}:0`.
      const persisted = repo.get('claim-txid-abc:0');
      expect(persisted).not.toBeNull();
      expect(Array.from(persisted!.prevTxBytes)).toEqual([0xde, 0xad, 0xbe, 0xef, 0x01]);
      expect(persisted!.claimStatus).toBe('claimed');
    } finally {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes proper claim inputs to buildOffchainTx', async () => {
    const { buildOffchainTx } = await import('@arkade-os/sdk');
    const { submitCovenantTx } = await import('./introspector.js');

    vi.mocked(buildOffchainTx).mockReturnValue({
      arkTx: makeMockArkTx(2) as any,
      checkpoints: [makeMockArkTx(99) as any], // mock checkpoint w/ getInput/updateInput for setConditionWitness
    });
    vi.mocked(submitCovenantTx).mockResolvedValue('claim-txid-x');

    const { repo, dir } = mkRepo();
    try {
      const handler = new CovenantClaimHandler(repo);
      const { tree, outpoint } = makeVhtlcWithCovenant();
      await handler.processVHTLC({
        vhtlc: { ...outpoint, tree },
        preimage: PREIMAGE,
        serverPubKey: SERVER_PK,
        introspectorPubKey: INTROSPECTOR_PK,
        receiverVtxoScript: receiverCovenant.vtxoScript,
        serverUnrollScript: mockServerUnrollScript,
        introspectorUrl: 'http://localhost:7073',
        arkProvider: mockArkProvider,
      });

      expect(buildOffchainTx).toHaveBeenCalledOnce();
      const [inputs, outputs, serverUnrollScript] = (buildOffchainTx as any).mock.calls[0];
      // single VHTLC input
      expect(inputs).toHaveLength(1);
      expect(inputs[0].txid).toBe(outpoint.txid);
      expect(inputs[0].vout).toBe(outpoint.vout);
      expect(inputs[0].value).toBe(outpoint.value);
      // outputs[0] = receiver's covenant pkScript with full amount
      expect(outputs[0].amount).toBe(BigInt(outpoint.value));
      expect(Array.from(outputs[0].script)).toEqual(Array.from(receiverCovenant.vtxoScript.pkScript));
      // outputs[1] = OP_RETURN (starts with 0x6a)
      expect(outputs[1].amount).toBe(0n);
      expect(outputs[1].script[0]).toBe(0x6a);
      // server unroll script passed through
      expect(serverUnrollScript).toBe(mockServerUnrollScript);
    } finally {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('submits to the configured Introspector URL with the built arkTx', async () => {
    const { buildOffchainTx } = await import('@arkade-os/sdk');
    const { submitCovenantTx } = await import('./introspector.js');

    const mockTx = makeMockArkTx(3);
    const checkpoints = [makeMockArkTx(98) as any];
    vi.mocked(buildOffchainTx).mockReturnValue({ arkTx: mockTx as any, checkpoints });
    vi.mocked(submitCovenantTx).mockResolvedValue('claim-txid-y');

    const { repo, dir } = mkRepo();
    try {
      const handler = new CovenantClaimHandler(repo);
      const { tree, outpoint } = makeVhtlcWithCovenant();
      await handler.processVHTLC({
        vhtlc: { ...outpoint, tree },
        preimage: PREIMAGE,
        serverPubKey: SERVER_PK,
        introspectorPubKey: INTROSPECTOR_PK,
        receiverVtxoScript: receiverCovenant.vtxoScript,
        serverUnrollScript: mockServerUnrollScript,
        introspectorUrl: 'http://atlas.local:9999',
        arkProvider: mockArkProvider,
      });

      expect(submitCovenantTx).toHaveBeenCalledOnce();
      const callArgs = vi.mocked(submitCovenantTx).mock.calls[0][0];
      expect(callArgs.introspectorUrl).toBe('http://atlas.local:9999');
      expect(callArgs.arkTx).toBe(mockTx);
      expect(callArgs.checkpoints).toBe(checkpoints);
      expect(callArgs.arkProvider).toBe(mockArkProvider);
    } finally {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns error status (and does NOT persist) when submitCovenantTx throws', async () => {
    const { buildOffchainTx } = await import('@arkade-os/sdk');
    const { submitCovenantTx } = await import('./introspector.js');

    vi.mocked(buildOffchainTx).mockReturnValue({
      arkTx: makeMockArkTx(4) as any,
      checkpoints: [makeMockArkTx(99) as any], // mock checkpoint w/ getInput/updateInput for setConditionWitness
    });
    vi.mocked(submitCovenantTx).mockRejectedValue(new Error('introspector down'));

    const { repo, dir } = mkRepo();
    try {
      const handler = new CovenantClaimHandler(repo);
      const { tree, outpoint } = makeVhtlcWithCovenant();
      const result = await handler.processVHTLC({
        vhtlc: { ...outpoint, tree },
        preimage: PREIMAGE,
        serverPubKey: SERVER_PK,
        introspectorPubKey: INTROSPECTOR_PK,
        receiverVtxoScript: receiverCovenant.vtxoScript,
        serverUnrollScript: mockServerUnrollScript,
        introspectorUrl: 'http://localhost:7073',
        arkProvider: mockArkProvider,
      });

      expect(result.status).toBe('error');
      expect(result.error?.message).toBe('introspector down');
      expect(result.txid).toBeUndefined();
      // No row was persisted because the claim failed.
      expect(repo.countByStatus('claimed')).toBe(0);
    } finally {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('OP_RETURN encodes the enforcePayToScript with the preimage witness', async () => {
    const { buildOffchainTx } = await import('@arkade-os/sdk');
    const { submitCovenantTx } = await import('./introspector.js');

    vi.mocked(buildOffchainTx).mockReturnValue({
      arkTx: makeMockArkTx(5) as any,
      checkpoints: [makeMockArkTx(99) as any], // mock checkpoint w/ getInput/updateInput for setConditionWitness
    });
    vi.mocked(submitCovenantTx).mockResolvedValue('claim-txid-op');

    const { repo, dir } = mkRepo();
    try {
      const handler = new CovenantClaimHandler(repo);
      const { tree, outpoint } = makeVhtlcWithCovenant();
      await handler.processVHTLC({
        vhtlc: { ...outpoint, tree },
        preimage: PREIMAGE,
        serverPubKey: SERVER_PK,
        introspectorPubKey: INTROSPECTOR_PK,
        receiverVtxoScript: receiverCovenant.vtxoScript,
        serverUnrollScript: mockServerUnrollScript,
        introspectorUrl: 'http://localhost:7073',
        arkProvider: mockArkProvider,
      });

      const [, outputs] = (buildOffchainTx as any).mock.calls[0];
      const opReturnScript: Uint8Array = outputs[1].script;
      // ARK tag must appear in the OP_RETURN payload (Introspector Packet format).
      const asHex = hex.encode(opReturnScript);
      expect(asHex).toContain('41524b'); // 'ARK'
      // The enforcePayToScript bytes appear inside the packet.
      expect(asHex).toContain(hex.encode(expectedClaimLeaf.enforcePayToScript));
      // Fulmine-style enforcePayTo consumes no stack inputs — the packet
      // witness is empty. The preimage lives in the tapleaf's conditionScript
      // (not in the Introspector packet), so it must NOT appear here.
      expect(asHex).not.toContain(hex.encode(PREIMAGE));
    } finally {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sets ConditionWitness PSBT field on BOTH arkTx and checkpoint[0]', async () => {
    // arkd's VerifyVtxoTapscriptSigs decodes the ark tx input's leaf as
    // ConditionMultisigClosure (the SDK propagates the wrapped ConditionMultisigTapscript
    // bytes from the VHTLC's covenant leaf into the checkpoint's collaborative spend
    // leaf, so the ark tx that spends the checkpoint inherits the same wrapper).
    // arkd then fetches the ConditionWitness PSBT field on the ark tx input,
    // evaluates the conditionScript with that witness, and rejects the tx if the
    // field is missing — surfaced as `INVALID_SIGNATURE in ark tx`. Mirror bancod's
    // BuildClaim (arkade-os/bancod:pkg/preimage/claim.go) which sets the field on
    // both arkTx and each checkpoint.
    const { buildOffchainTx } = await import('@arkade-os/sdk');
    const { submitCovenantTx } = await import('./introspector.js');

    const arkTx = makeMockArkTx(7);
    const checkpoint = makeMockArkTx(99);
    vi.mocked(buildOffchainTx).mockReturnValue({
      arkTx: arkTx as any,
      checkpoints: [checkpoint as any],
    });
    vi.mocked(submitCovenantTx).mockResolvedValue('claim-txid-cw');

    const { repo, dir } = mkRepo();
    try {
      const handler = new CovenantClaimHandler(repo);
      const { tree, outpoint } = makeVhtlcWithCovenant();
      await handler.processVHTLC({
        vhtlc: { ...outpoint, tree },
        preimage: PREIMAGE,
        serverPubKey: SERVER_PK,
        introspectorPubKey: INTROSPECTOR_PK,
        receiverVtxoScript: receiverCovenant.vtxoScript,
        serverUnrollScript: mockServerUnrollScript,
        introspectorUrl: 'http://localhost:7073',
        arkProvider: mockArkProvider,
      });

      const CONDITION_KEY_TYPE = 222;
      const CONDITION_KEY = 'condition';
      // encodeWitnessStack([preimage]) = varint(1) || varint(32) || preimage
      const expectedWitness = new Uint8Array([0x01, 0x20, ...PREIMAGE]);

      const assertHasConditionWitness = (tx: ReturnType<typeof makeMockArkTx>, label: string) => {
        const input = tx.getInput(0);
        expect(input.unknown, `${label} input 0 is missing the .unknown PSBT field array`).toBeDefined();
        const match = (input.unknown as any[]).find(([k]) =>
          k.type === CONDITION_KEY_TYPE &&
          new TextDecoder().decode(k.key) === CONDITION_KEY,
        );
        expect(match, `${label} input 0 is missing the ConditionWitness PSBT field (key type 222, key "condition")`).toBeDefined();
        expect(Array.from(match[1] as Uint8Array)).toEqual(Array.from(expectedWitness));
      };

      assertHasConditionWitness(checkpoint, 'checkpoint');
      assertHasConditionWitness(arkTx, 'arkTx');
    } finally {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persistence failure does not mask the successful claim — returns claimed with persistError flag', async () => {
    const { buildOffchainTx } = await import('@arkade-os/sdk');
    const { submitCovenantTx } = await import('./introspector.js');

    vi.mocked(buildOffchainTx).mockReturnValue({
      arkTx: makeMockArkTx(6) as any,
      checkpoints: [makeMockArkTx(99) as any], // mock checkpoint w/ getInput/updateInput for setConditionWitness
    });
    vi.mocked(submitCovenantTx).mockResolvedValue('claim-txid-pf');

    const { repo, dir } = mkRepo();
    repo.close(); // close so subsequent writes fail (DB is closed)
    try {
      const handler = new CovenantClaimHandler(repo);
      const { tree, outpoint } = makeVhtlcWithCovenant();
      const result = await handler.processVHTLC({
        vhtlc: { ...outpoint, tree },
        preimage: PREIMAGE,
        serverPubKey: SERVER_PK,
        introspectorPubKey: INTROSPECTOR_PK,
        receiverVtxoScript: receiverCovenant.vtxoScript,
        serverUnrollScript: mockServerUnrollScript,
        introspectorUrl: 'http://localhost:7073',
        arkProvider: mockArkProvider,
      });

      // Claim succeeded but persistence failed — both facts surface.
      expect(result.status).toBe('claimed');
      expect(result.txid).toBe('claim-txid-pf');
      expect(result.persistError).toBeDefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
