import { describe, it, expect, vi } from 'vitest';
import { hex } from '@scure/base';
import { VtxoScript } from '@arkade-os/sdk';
import { buildCovenantVtxo } from './vtxo.js';
import { covenantRefresh } from './covenant-refresh.js';

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

// Deterministic test keys
const alicePubkey = new Uint8Array(32).fill(0x01);
const serverPubkey = new Uint8Array(32).fill(0x02);
const introspectorPubkey = new Uint8Array(32).fill(0x03);

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
