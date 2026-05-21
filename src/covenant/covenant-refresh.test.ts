import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { hex } from '@scure/base';
import { VtxoScript } from '@arkade-os/sdk';
import { buildCovenantVtxo } from './vtxo.js';
import { covenantRefresh, resolvePrevTxBytes } from './covenant-refresh.js';
import { CovenantClaimsRepo } from '../storage/covenant-claims-repo.js';

// Mock arkTx that captures updateInput/getInput calls so we can assert what
// PrevArkTx fields were set by covenantRefresh's per-input resolution.
function makeMockArkTx() {
  const inputs: Array<{ unknown?: Array<[{ type: number; key: Uint8Array }, Uint8Array]> }> = [];
  return {
    toPSBT: () => new Uint8Array(10),
    getInput(i: number) {
      if (!inputs[i]) inputs[i] = {};
      return inputs[i];
    },
    updateInput(i: number, patch: any) {
      if (!inputs[i]) inputs[i] = {};
      Object.assign(inputs[i], patch);
    },
    _capturedInputs: inputs,
  };
}

// We mock the SDK's buildOffchainTx and our submitCovenantTx
vi.mock('@arkade-os/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arkade-os/sdk')>();
  return {
    ...actual,
    buildOffchainTx: vi.fn().mockReturnValue({
      arkTx: { toPSBT: () => new Uint8Array(10) },
      checkpoints: [{ toPSBT: () => new Uint8Array(5) }],
    }),
  };
});

vi.mock('./introspector.js', () => ({
  submitCovenantTx: vi.fn().mockResolvedValue('mock-covenant-txid'),
  submitIntrospectorTx: vi.fn(),
}));

// Valid secp256k1 x-only pubkeys (generator point multiples: privkey = 1, 2, 3)
const alicePubkey = hex.decode('79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798');
const serverPubkey = hex.decode('c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5');
const introspectorPubkey = hex.decode('f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9');

const covenantResult = buildCovenantVtxo({
  alicePubkey,
  serverPubkey,
  introspectorBasePubkey: introspectorPubkey,
  unilateralExitDelay: 512n,
});

const mockArkProvider = {
  submitTx: vi.fn(),
  finalizeTx: vi.fn(),
  getInfo: vi.fn(),
} as any;

const mockServerUnrollScript = {} as any;

describe('covenantRefresh', () => {
  it('builds correct inputs for single VTXO (refresh)', async () => {
    const { buildOffchainTx } = await import('@arkade-os/sdk');
    const { submitCovenantTx } = await import('./introspector.js');

    const txid = await covenantRefresh({
      vtxos: [{ txid: 'aabb', vout: 0, value: 10_000 }],
      vtxoScript: covenantResult.vtxoScript,
      refreshLeafScript: covenantResult.refreshLeafScript,
      refreshArkadeScript: covenantResult.refreshArkadeScript,
      serverUnrollScript: mockServerUnrollScript,
      introspectorUrl: 'http://localhost:7073',
      arkProvider: mockArkProvider,
    });

    expect(buildOffchainTx).toHaveBeenCalledOnce();
    const [inputs, outputs] = (buildOffchainTx as any).mock.calls[0];
    expect(inputs).toHaveLength(1);
    expect(inputs[0].txid).toBe('aabb');
    expect(inputs[0].vout).toBe(0);
    expect(inputs[0].value).toBe(10_000);
    // Output has same pkScript (recursive covenant)
    expect(outputs[0].script).toEqual(covenantResult.vtxoScript.pkScript);
    expect(outputs[0].amount).toBe(10_000n);
    expect(txid).toBe('mock-covenant-txid');
  });

  it('builds correct inputs for multiple VTXOs (consolidation)', async () => {
    const { buildOffchainTx } = await import('@arkade-os/sdk');
    vi.mocked(buildOffchainTx).mockClear();

    await covenantRefresh({
      vtxos: [
        { txid: 'aa', vout: 0, value: 5_000 },
        { txid: 'bb', vout: 1, value: 3_000 },
      ],
      vtxoScript: covenantResult.vtxoScript,
      refreshLeafScript: covenantResult.refreshLeafScript,
      refreshArkadeScript: covenantResult.refreshArkadeScript,
      serverUnrollScript: mockServerUnrollScript,
      introspectorUrl: 'http://localhost:7073',
      arkProvider: mockArkProvider,
    });

    const [inputs, outputs] = (buildOffchainTx as any).mock.calls[0];
    expect(inputs).toHaveLength(2);
    // Combined value
    expect(outputs[0].amount).toBe(8_000n);
    expect(outputs[0].script).toEqual(covenantResult.vtxoScript.pkScript);
  });

  it('OP_RETURN has one entry per vin', async () => {
    const { buildOffchainTx } = await import('@arkade-os/sdk');
    vi.mocked(buildOffchainTx).mockClear();

    await covenantRefresh({
      vtxos: [
        { txid: 'aa', vout: 0, value: 5_000 },
        { txid: 'bb', vout: 1, value: 3_000 },
      ],
      vtxoScript: covenantResult.vtxoScript,
      refreshLeafScript: covenantResult.refreshLeafScript,
      refreshArkadeScript: covenantResult.refreshArkadeScript,
      serverUnrollScript: mockServerUnrollScript,
      introspectorUrl: 'http://localhost:7073',
      arkProvider: mockArkProvider,
    });

    const [, outputs] = (buildOffchainTx as any).mock.calls[0];
    // Second output is OP_RETURN
    const opReturn = outputs[1];
    expect(opReturn.amount).toBe(0n);
    // OP_RETURN script starts with 0x6a
    expect(opReturn.script[0]).toBe(0x6a);
  });

  it('calls submitCovenantTx with correct params', async () => {
    const { submitCovenantTx } = await import('./introspector.js');
    vi.mocked(submitCovenantTx).mockClear();

    await covenantRefresh({
      vtxos: [{ txid: 'cc', vout: 0, value: 7_000 }],
      vtxoScript: covenantResult.vtxoScript,
      refreshLeafScript: covenantResult.refreshLeafScript,
      refreshArkadeScript: covenantResult.refreshArkadeScript,
      serverUnrollScript: mockServerUnrollScript,
      introspectorUrl: 'http://test:7073',
      arkProvider: mockArkProvider,
    });

    expect(submitCovenantTx).toHaveBeenCalledOnce();
    const params = vi.mocked(submitCovenantTx).mock.calls[0][0];
    expect(params.introspectorUrl).toBe('http://test:7073');
    expect(params.arkProvider).toBe(mockArkProvider);
  });

  it('returns txid from submitCovenantTx', async () => {
    const txid = await covenantRefresh({
      vtxos: [{ txid: 'dd', vout: 0, value: 1_000 }],
      vtxoScript: covenantResult.vtxoScript,
      refreshLeafScript: covenantResult.refreshLeafScript,
      refreshArkadeScript: covenantResult.refreshArkadeScript,
      serverUnrollScript: mockServerUnrollScript,
      introspectorUrl: 'http://localhost:7073',
      arkProvider: mockArkProvider,
    });

    expect(txid).toBe('mock-covenant-txid');
  });
});

describe('resolvePrevTxBytes', () => {
  function mkRepo(): { repo: CovenantClaimsRepo; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-cr-'));
    return { repo: new CovenantClaimsRepo(path.join(dir, 'c.db')), dir };
  }

  const OP = 'aa'.repeat(32) + ':0';

  it('inline bytes win over repo bytes', () => {
    const { repo, dir } = mkRepo();
    try {
      repo.recordClaim(OP, new Uint8Array([0xbb]));
      const got = resolvePrevTxBytes(new Uint8Array([0xaa]), OP, repo);
      expect(Array.from(got!)).toEqual([0xaa]);
    } finally {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns inline bytes when no repo provided', () => {
    const got = resolvePrevTxBytes(new Uint8Array([0xaa]), OP, undefined);
    expect(Array.from(got!)).toEqual([0xaa]);
  });

  it('falls back to repo bytes when inline is absent', () => {
    const { repo, dir } = mkRepo();
    try {
      repo.recordClaim(OP, new Uint8Array([0xcc, 0xdd]));
      const got = resolvePrevTxBytes(undefined, OP, repo);
      expect(Array.from(got!)).toEqual([0xcc, 0xdd]);
    } finally {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns undefined when inline absent + no repo (legacy behavior preserved)', () => {
    const got = resolvePrevTxBytes(undefined, OP, undefined);
    expect(got).toBeUndefined();
  });

  it('throws when repo provided but neither inline nor repo has the outpoint', () => {
    const { repo, dir } = mkRepo();
    try {
      expect(() => resolvePrevTxBytes(undefined, OP, repo)).toThrow(/prevTxBytes/i);
      expect(() => resolvePrevTxBytes(undefined, OP, repo)).toThrow(new RegExp(OP));
    } finally {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('covenantRefresh with claimsRepo', () => {
  it('uses repo prevTxBytes when inline is absent', async () => {
    // Replace the buildOffchainTx mock so we can capture which arkTx fields get set.
    const { buildOffchainTx } = await import('@arkade-os/sdk');
    const mockTx = makeMockArkTx();
    vi.mocked(buildOffchainTx).mockReturnValueOnce({
      arkTx: mockTx as any,
      checkpoints: [{ toPSBT: () => new Uint8Array(5) } as any],
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-cr-'));
    const repo = new CovenantClaimsRepo(path.join(dir, 'c.db'));
    try {
      const outpoint = 'cafe' + ':0';
      const prev = new Uint8Array([0xfa, 0xce]);
      repo.recordClaim(outpoint, prev);

      await covenantRefresh({
        vtxos: [{ txid: 'cafe', vout: 0, value: 5_000 }],
        vtxoScript: covenantResult.vtxoScript,
        refreshLeafScript: covenantResult.refreshLeafScript,
        refreshArkadeScript: covenantResult.refreshArkadeScript,
        serverUnrollScript: mockServerUnrollScript,
        introspectorUrl: 'http://localhost:7073',
        arkProvider: mockArkProvider,
        claimsRepo: repo,
      });

      const captured = mockTx._capturedInputs[0];
      expect(captured?.unknown).toBeDefined();
      const tlv = captured!.unknown!.find(
        ([k]) => k.type === 0xde && new TextDecoder().decode(k.key) === 'prevarktx',
      );
      expect(tlv).toBeDefined();
      expect(Array.from(tlv![1])).toEqual([0xfa, 0xce]);
    } finally {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('inline prevTxBytes still wins when claimsRepo is also provided', async () => {
    const { buildOffchainTx } = await import('@arkade-os/sdk');
    const mockTx = makeMockArkTx();
    vi.mocked(buildOffchainTx).mockReturnValueOnce({
      arkTx: mockTx as any,
      checkpoints: [{ toPSBT: () => new Uint8Array(5) } as any],
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-cr-'));
    const repo = new CovenantClaimsRepo(path.join(dir, 'c.db'));
    try {
      const outpoint = 'beef' + ':0';
      repo.recordClaim(outpoint, new Uint8Array([0xaa])); // repo has 0xaa

      await covenantRefresh({
        vtxos: [{
          txid: 'beef',
          vout: 0,
          value: 5_000,
          prevTxBytes: new Uint8Array([0xbb]), // inline has 0xbb — should win
        }],
        vtxoScript: covenantResult.vtxoScript,
        refreshLeafScript: covenantResult.refreshLeafScript,
        refreshArkadeScript: covenantResult.refreshArkadeScript,
        serverUnrollScript: mockServerUnrollScript,
        introspectorUrl: 'http://localhost:7073',
        arkProvider: mockArkProvider,
        claimsRepo: repo,
      });

      const tlv = mockTx._capturedInputs[0]!.unknown!.find(
        ([k]) => k.type === 0xde && new TextDecoder().decode(k.key) === 'prevarktx',
      );
      expect(Array.from(tlv![1])).toEqual([0xbb]); // inline wins
    } finally {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when claimsRepo provided but vtxo lookup misses', async () => {
    const { buildOffchainTx } = await import('@arkade-os/sdk');
    const mockTx = makeMockArkTx();
    vi.mocked(buildOffchainTx).mockReturnValueOnce({
      arkTx: mockTx as any,
      checkpoints: [{ toPSBT: () => new Uint8Array(5) } as any],
    });

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'golem-cr-'));
    const repo = new CovenantClaimsRepo(path.join(dir, 'c.db'));
    try {
      await expect(
        covenantRefresh({
          vtxos: [{ txid: 'deed', vout: 0, value: 5_000 }],
          vtxoScript: covenantResult.vtxoScript,
          refreshLeafScript: covenantResult.refreshLeafScript,
          refreshArkadeScript: covenantResult.refreshArkadeScript,
          serverUnrollScript: mockServerUnrollScript,
          introspectorUrl: 'http://localhost:7073',
          arkProvider: mockArkProvider,
          claimsRepo: repo,
        }),
      ).rejects.toThrow(/prevTxBytes/i);
    } finally {
      repo.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
