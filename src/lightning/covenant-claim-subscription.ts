/**
 * subscribeCovenantClaims — wires Golem's CovenantClaimHandler into ArkadeSwaps'
 * lifecycle events. When a reverse swap reaches `transaction.confirmed` (the VHTLC
 * is observable on the wire), the recipeProvider resolves the swap into
 * ProcessVHTLCParams; if it returns non-null, the handler self-solves the claim.
 *
 * Today this path is dead-on-arrival in production because Boltz does not yet
 * create covenant-restricted VHTLCs on `/v2/swap/reverse` — the recipeProvider
 * will return null. When Boltz ships Path B, the recipeProvider implementation
 * is the single integration point that activates the production path.
 *
 * Documented as a known limit in docs/PHASE-1.5-LIMITS.md (auto-claim conflict).
 */

import type { CovenantClaimHandler, ProcessVHTLCParams, ProcessVHTLCResult } from '../covenant/claim-handler.js';

/**
 * Resolves a swap event into a complete ProcessVHTLCParams when the swap is
 * Path-B-eligible, else null. Errors thrown here are caught by the subscription
 * and surfaced via the optional `onResult` callback so observability is preserved.
 */
export type CovenantRecipeProvider = (swap: any) => Promise<ProcessVHTLCParams | null>;

export interface SubscribeCovenantClaimsOptions {
  /** Observability hook fired for every claim attempt (covenant-eligible swaps only). */
  onResult?: (swap: any, result: ProcessVHTLCResult) => void;
}

/**
 * Subscribe to ArkadeSwaps' onSwapUpdate event. Returns an unsubscribe function.
 *
 * Throws if `arkadeSwaps.swapManager` is null — start the SwapManager before
 * calling this (matches the SDK's lifecycle: SwapManager must be running for
 * events to fire).
 */
export async function subscribeCovenantClaims(
  arkadeSwaps: { swapManager: { onSwapUpdate(listener: (swap: any, oldStatus: any) => void): Promise<() => void> } | null },
  handler: CovenantClaimHandler,
  recipeProvider: CovenantRecipeProvider,
  options?: SubscribeCovenantClaimsOptions,
): Promise<() => void> {
  if (!arkadeSwaps.swapManager) {
    throw new Error('subscribeCovenantClaims: arkadeSwaps.swapManager is null — start the manager first');
  }

  const unsubscribe = await arkadeSwaps.swapManager.onSwapUpdate(async (swap, _oldStatus) => {
    if (swap?.type !== 'reverse') return;
    if (swap?.status !== 'transaction.confirmed') return;

    let params: ProcessVHTLCParams | null;
    try {
      params = await recipeProvider(swap);
    } catch (e: any) {
      options?.onResult?.(swap, {
        status: 'error',
        error: e instanceof Error ? e : new Error(String(e)),
      });
      return;
    }
    if (!params) return;

    let result: ProcessVHTLCResult;
    try {
      result = await handler.processVHTLC(params);
    } catch (e: any) {
      result = {
        status: 'error',
        error: e instanceof Error ? e : new Error(String(e)),
      };
    }
    options?.onResult?.(swap, result);
  });

  return unsubscribe;
}
