/**
 * subscribeCovenantClaims tests — ArkadeSwaps event hook wiring.
 *
 * The subscription gates a covenant claim attempt on:
 *   - swap.type === 'reverse'
 *   - swap.status === 'transaction.confirmed'
 *   - the recipeProvider returns non-null ProcessVHTLCParams
 *
 * Test scope: the routing logic. The handler itself is mocked. Real Fulmine-driven
 * end-to-end exercise lives in T7's regtest E2E.
 */

import { describe, it, expect, vi } from 'vitest';
import { subscribeCovenantClaims } from './covenant-claim-subscription.js';
import type { CovenantClaimHandler, ProcessVHTLCParams, ProcessVHTLCResult } from '../covenant/claim-handler.js';

function makeMockSwapManager() {
  let listener: ((swap: any, oldStatus: any) => void) | null = null;
  const unsubscribe = vi.fn();
  return {
    onSwapUpdate: vi.fn(async (l: any) => {
      listener = l;
      return unsubscribe;
    }),
    fire(swap: any, oldStatus: any) {
      if (!listener) throw new Error('no listener registered');
      listener(swap, oldStatus);
    },
    unsubscribe,
  };
}

function makeArkadeSwaps(swapManager: any): any {
  return { swapManager };
}

function makeHandler(): { handler: CovenantClaimHandler; processVHTLC: ReturnType<typeof vi.fn> } {
  const processVHTLC = vi.fn();
  return { handler: { processVHTLC } as any, processVHTLC };
}

function makeReverseSwap(status: string, id = 's-1'): any {
  return {
    id, type: 'reverse', createdAt: 0, preimage: '00'.repeat(32),
    status, request: {}, response: { lockupAddress: 'tark1foo' },
  };
}

const STUB_PARAMS: ProcessVHTLCParams = {
  vhtlc: { txid: 'aa', vout: 0, value: 5000, tree: {} as any },
  preimage: new Uint8Array(32),
  serverPubKey: new Uint8Array(32),
  introspectorPubKey: new Uint8Array(32),
  receiverVtxoScript: {} as any,
  serverUnrollScript: {} as any,
  introspectorUrl: 'http://localhost:7073',
  arkProvider: {} as any,
};

describe('subscribeCovenantClaims', () => {
  it('throws when arkadeSwaps.swapManager is null', async () => {
    const { handler } = makeHandler();
    const arkadeSwaps = makeArkadeSwaps(null);
    await expect(
      subscribeCovenantClaims(arkadeSwaps, handler, async () => null),
    ).rejects.toThrow(/swapManager is null/);
  });

  it('returns the unsubscribe function from swapManager.onSwapUpdate', async () => {
    const { handler } = makeHandler();
    const sm = makeMockSwapManager();
    const unsub = await subscribeCovenantClaims(makeArkadeSwaps(sm), handler, async () => null);
    expect(unsub).toBe(sm.unsubscribe);
  });

  it('does not call handler when swap.type is "submarine"', async () => {
    const { handler, processVHTLC } = makeHandler();
    const sm = makeMockSwapManager();
    await subscribeCovenantClaims(makeArkadeSwaps(sm), handler, async () => STUB_PARAMS);
    sm.fire({ ...makeReverseSwap('transaction.confirmed'), type: 'submarine' }, 'swap.created');
    await new Promise(r => setImmediate(r));
    expect(processVHTLC).not.toHaveBeenCalled();
  });

  it('does not call handler when swap.status is not "transaction.confirmed"', async () => {
    const { handler, processVHTLC } = makeHandler();
    const sm = makeMockSwapManager();
    await subscribeCovenantClaims(makeArkadeSwaps(sm), handler, async () => STUB_PARAMS);
    sm.fire(makeReverseSwap('invoice.set'), 'swap.created');
    await new Promise(r => setImmediate(r));
    expect(processVHTLC).not.toHaveBeenCalled();
  });

  it('does not call handler when recipeProvider returns null', async () => {
    const { handler, processVHTLC } = makeHandler();
    const sm = makeMockSwapManager();
    const recipeProvider = vi.fn(async () => null);
    await subscribeCovenantClaims(makeArkadeSwaps(sm), handler, recipeProvider);
    sm.fire(makeReverseSwap('transaction.confirmed'), 'swap.created');
    await new Promise(r => setImmediate(r));
    expect(recipeProvider).toHaveBeenCalledOnce();
    expect(processVHTLC).not.toHaveBeenCalled();
  });

  it('calls handler when status is confirmed and recipeProvider returns params', async () => {
    const { handler, processVHTLC } = makeHandler();
    processVHTLC.mockResolvedValue({ status: 'claimed', txid: 'claim-txid', vout: 0 } as ProcessVHTLCResult);
    const sm = makeMockSwapManager();
    await subscribeCovenantClaims(makeArkadeSwaps(sm), handler, async () => STUB_PARAMS);
    sm.fire(makeReverseSwap('transaction.confirmed'), 'swap.created');
    await new Promise(r => setImmediate(r));
    expect(processVHTLC).toHaveBeenCalledOnce();
    expect(processVHTLC).toHaveBeenCalledWith(STUB_PARAMS);
  });

  it('invokes onResult callback with the handler result', async () => {
    const { handler, processVHTLC } = makeHandler();
    const expected: ProcessVHTLCResult = { status: 'claimed', txid: 'tx-x', vout: 0 };
    processVHTLC.mockResolvedValue(expected);
    const onResult = vi.fn();
    const sm = makeMockSwapManager();
    await subscribeCovenantClaims(makeArkadeSwaps(sm), handler, async () => STUB_PARAMS, { onResult });
    const swap = makeReverseSwap('transaction.confirmed');
    sm.fire(swap, 'swap.created');
    await new Promise(r => setImmediate(r));
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith(swap, expected);
  });

  it('swallows handler errors so an exception in one swap does not break the listener', async () => {
    const { handler, processVHTLC } = makeHandler();
    processVHTLC.mockRejectedValue(new Error('boom'));
    const onResult = vi.fn();
    const sm = makeMockSwapManager();
    await subscribeCovenantClaims(makeArkadeSwaps(sm), handler, async () => STUB_PARAMS, { onResult });
    // Should not throw.
    sm.fire(makeReverseSwap('transaction.confirmed'), 'swap.created');
    await new Promise(r => setImmediate(r));
    // onResult is invoked with an error-shaped result so observers see what happened.
    expect(onResult).toHaveBeenCalledOnce();
    const arg = onResult.mock.calls[0][1] as ProcessVHTLCResult;
    expect(arg.status).toBe('error');
    expect(arg.error?.message).toBe('boom');
  });

  it('handles a recipeProvider that itself throws (no listener crash, error surfaced)', async () => {
    const { handler, processVHTLC } = makeHandler();
    const onResult = vi.fn();
    const sm = makeMockSwapManager();
    await subscribeCovenantClaims(
      makeArkadeSwaps(sm),
      handler,
      async () => { throw new Error('rp-boom'); },
      { onResult },
    );
    sm.fire(makeReverseSwap('transaction.confirmed'), 'swap.created');
    await new Promise(r => setImmediate(r));
    expect(processVHTLC).not.toHaveBeenCalled();
    expect(onResult).toHaveBeenCalledOnce();
    const arg = onResult.mock.calls[0][1] as ProcessVHTLCResult;
    expect(arg.status).toBe('error');
    expect(arg.error?.message).toBe('rp-boom');
  });
});
