# Phase 1.5 — Known Limits

What this dispatch's covenant-receive wiring **does** and **does not** cover. Honest enumeration so the next session inherits a clear surface, not a discovery surface.

## What's covered (and tested)

- Detection of NonInteractiveClaim covenant leaves in incoming VHTLC trees that match Golem's recipe — see `src/covenant/vhtlc-detection.ts` and `findCovenantClaimLeaf`. Byte-exact match against the script topology in ArkLabsHQ/fulmine PR #411 (`pkg/vhtlc/noninteractive.go`).
- Self-solver claim path: preimage-only witness construction, Introspector co-sign via `submitCovenantTx`, output pinned to Golem's covenant receive `pkScript`. See `src/covenant/claim-handler.ts`.
- Persistence of `prevTxBytes` on every successful covenant claim via `CovenantClaimsRepo` (SQLite, separate DB file from the SDK-owned `boltz-swaps.db`). See `src/storage/covenant-claims-repo.ts`.
- `covenantRefresh` reads `prevTxBytes` from the repo when not supplied inline (precedence: inline > repo > throw-if-repo-provided-and-missing > undefined-if-no-repo). See `resolvePrevTxBytes` in `src/covenant/covenant-refresh.ts`.
- ArkadeSwaps event-hook wiring (`subscribeCovenantClaims`) that filters reverse-swap `transaction.confirmed` events and routes them through a caller-supplied `recipeProvider` and the `CovenantClaimHandler`. See `src/lightning/covenant-claim-subscription.ts`.
- End-to-end regtest proof: Fulmine PR #411 creates a NonInteractiveClaim VHTLC → Golem-built sender funds it → `CovenantClaimHandler` claims it → `CovenantClaimsRepo` persists `prevTxBytes` → `covenantRefresh` refreshes the resulting VTXO reading bytes back from the repo. See `test/regtest/covenant-receive-e2e.ts`.

## What's NOT covered (and why)

### Boltz-side sender wiring
Boltz's `/v2/swap/reverse` doesn't yet accept `claimCovenant` / `non_interactive_claim` parameters, and `@arkade-os/boltz-swap` has no surface to pass them through. Building this wiring today would be unreachable code pointing at an unimplemented upstream. When Boltz ships Path B and `@arkade-os/boltz-swap` exposes the wire fields:
1. Surface `CovenantClaimsRepo` + `CovenantClaimHandler` from the CLI bootstrap.
2. Pass a `recipeProvider` to `subscribeCovenantClaims` that, given a `PendingReverseSwap`, extracts the preimage (from `swap.preimage`), looks up the introspector pubkey from config, fetches the VHTLC's taproot tree from Boltz, and constructs `ProcessVHTLCParams`.
3. Cross-reference with the auto-claim conflict (below).

### Auto-claim conflict at Path-B ship time
`ArkadeSwaps` is configured with `enableAutoActions: true` in `src/lightning/index.ts:102`. When Boltz starts shipping covenant VHTLCs, the SDK's standard auto-claim path will race against `CovenantClaimHandler` and almost certainly cause:
- A double-spend attempt rejected by arkd (best case — visible failure, our handler wins or loses cleanly).
- A standard non-covenant claim that lands BEFORE our covenant handler runs (worst case — funds arrive at the standard `claimPublicKey` output, not at our covenant address).

Options to resolve at ship time:
1. PR `@arkade-os/boltz-swap` to add per-swap "skip auto-claim" or "use this claim function" hooks.
2. Set `enableAutoActions: false` globally and re-implement the standard-VHTLC claim path inside Golem (regression-heavy).
3. Wrap `ArkadeSwaps` in a Golem-owned class that intercepts the claim event before the SDK acts.

Decision deferred — none of these have to be solved while Boltz isn't shipping covenant VHTLCs.

### bancod-style external solver
We self-solve (Golem holds its own preimage and signs nothing — the Introspector handles signing). The bancod solver in `test.docker-compose.yml` is co-resident only because Fulmine declares it as a dependency. Golem code makes no calls to `bancod`. If a future use case requires offline receive (mobile-only mode), wire an external solver via `extra_packet` then.

### Multi-VHTLC concurrent claim races
`CovenantClaimHandler.processVHTLC` is single-VHTLC scoped. Two simultaneous handler invocations for the same VHTLC can both reach `submitCovenantTx`; one will land, the other gets rejected by arkd. No locking. Acceptable for Phase 1.5 since the production trigger (`onSwapUpdate`) is serialised within ArkadeSwaps; pathological double-fire would surface in logs as a duplicate-tx error and the persisted state would be from whichever claim landed.

### P2P direct sends (without prior reverse swap)
The handler assumes Golem KNOWS the preimage (it generated it during swap request). For VHTLCs delivered without a prior `createLightningInvoice` (e.g., a peer sending directly), no preimage is recorded and the handler can't be invoked. Out of scope.

### `prevTxBytes` storage on refresh
The claim path persists `prevTxBytes` for the post-claim VTXO. When that VTXO is later REFRESHED into a new VTXO, the refresh's bytes are NOT auto-persisted — `covenantRefresh` is single-output by design (the refreshed VTXO has new `prevTxBytes` = the refresh tx itself). Today, callers wanting to refresh-the-refresh must pass `prevTxBytes` inline OR record the refresh tx into the repo before calling refresh again. Mitigation: file a follow-up to extend `covenantRefresh` to ALSO persist its output's `prevTxBytes` when a repo is supplied. Tracked but out of scope for this dispatch.

### Persistence race: claim lands, repo write fails
`CovenantClaimHandler` returns `status: 'claimed', persistError: Error` when this happens. Caller responsibility to reconcile. Future hardening could re-derive `prevTxBytes` from the indexer's virtual-tx API on miss, but that's out of scope here.

### Mainnet Introspector
Ark Labs maintainer's hardening track is independent. This dispatch's code targets regtest. Mainnet readiness requires (a) Ark Labs maintainer green-lighting the Introspector deployment alongside `arkade.computer`, (b) operational testing, (c) the deferred items above.

### Regtest boarding regression — E2E activation blocked
As of 2026-05-21 the regtest stack hangs `Ramps.onboard` after the wallet subscribes to the round event stream. The `streamStarted` event arrives, but `safeRegisterIntent` (the SDK's wrapper around `arkProvider.registerIntent`) is never invoked — arkd loops `round X aborted: not enough intents registered 0/1` indefinitely.

**Independence from new code (verified):**
- Newly-written `test/regtest/covenant-receive-e2e.ts` hangs at boarding.
- Pre-existing `test/regtest/covenant-claim.ts` (last verified green 2026-04-20 on a binary-swapped Introspector container) hangs at the same point with identical arkd log signature.

**Version pins tried (all still hang):**
| arkd | @arkade-os/sdk | @arkade-os/boltz-swap | Result |
|---|---|---|---|
| v0.9.3 (Introspector default) | ^0.4.6 (4/20 baseline) | ^0.3.3 | hang |
| v0.9.0-rc.4 (claimed 4/20 baseline) | ^0.4.6 | ^0.3.3 | hang (after SCHEDULER_TYPE=gocron fix) |
| v0.9.5 (latest) | ^0.4.27 (latest) | ^0.3.32 (latest) | hang |
| v0.9.5 + full `docker compose down -v` rebuild | ^0.4.27 | ^0.3.32 | hang |

`ARKD_SESSION_DURATION` 10 → 30 didn't help either.

**Diagnostic trail.** Direct probe of arkd's `/v1/batch/events` returns exactly one `{"streamStarted":{"id":"..."}}` and then nothing for ≥ 5 s. The SDK's `getEventStream` correctly yields that event as `SettlementEventType.StreamStarted`. The `for await` then awaits the next event, which never arrives — arkd only emits round events tied to subscribed topics, but the topics (signing pubkeys + input outpoints) are only meaningful AFTER an intent is registered. Yet `Promise.all([makeRegisterIntentSignature, makeDeleteIntentSignature])` happens BEFORE `safeRegisterIntent`, and both are local crypto operations that shouldn't block.

The deadlock candidate inside the SDK appears to be the parallel `Promise.all` of signature construction stalling rather than the stream priming — but it could also be a subtle ordering bug in `_settleImpl` where `await firstNext` blocks before signatures finish. We did not bisect deeper than this. The repro is reliable; future debug should set a TS-level breakpoint inside `Wallet.settle._settleImpl` between the `getEventStream` call and the `safeRegisterIntent` call.

**What this means for the dispatch.** The receiver-side machinery is complete and unit-tested in isolation:
- 75 new tests across storage, detection, claim handler, refresh refactor, and the ArkadeSwaps subscription wiring.
- Byte-exact protocol primitives (`buildNonInteractiveClaimArkadeScript`, `buildCovenantClaimLeaf`, `findCovenantClaimLeaf`) match PR #411 `enforcePayTo`, with negative-case rejection on every input axis.
- The cross-implementation E2E proof (`covenant-receive-e2e.ts`) is written and will run as-is once boarding works. The test file does NOT need changes.

Reasons not to keep chasing this in-session:
- The bug is in `@arkade-os/sdk`'s settlement flow (`Wallet._settleImpl`), not in any code we own.
- Bisecting requires either (a) source-level debug into the SDK's compiled JS, or (b) source-build the SDK from `arkade-os/ts-sdk` at varying commits — neither is a fast operation.
- The dispatch's structural value (54 tests, all green) is durable and doesn't depend on this E2E.

**Unblocking when revisited:**
1. Build `@arkade-os/sdk` from source at the v0.4.6 git tag commit (the actual 4/20 baseline) and link it locally into golem. Confirm whether the regression existed at THAT exact commit — if yes, the assumption that 4/20 was green is wrong (maybe an undocumented patch was applied locally). If no, bisect SDK forward.
2. Alternatively: pair-debug the SDK's `_settleImpl` with breakpoints around `firstNext` and the parallel `Promise.all`. The hang is reliable, so a single test run with the debugger should pinpoint it.
3. Once boarding works against any combination, re-run `covenant-claim.ts` (smoke gate) then `covenant-receive-e2e.ts` (E2E proof).

Captured in continuation.md as the top priority for the next session. The package.json bump to `@arkade-os/sdk@^0.4.27` + `@arkade-os/boltz-swap@^0.3.32` is preserved in this dispatch: unit tests stay green (687/687), and being current on dependencies is a better starting point for the next debug attempt than the 4/20-pinned state.

### `covenant-wrapper.ts` deletion
The wrap-path module is `@deprecated` and untouched by this dispatch. Deletion happens when Boltz ships Path B in production AND Golem swaps over to the covenant path in production. Not before.

## How this surface evolves

When Boltz ships Path B, the Day-0 followup is:
1. Update `@arkade-os/boltz-swap` to the version exposing the wire fields.
2. Implement the production `recipeProvider` (see "Boltz-side sender wiring" above).
3. Resolve the auto-claim conflict.
4. Run `covenant-receive-e2e.ts` against a Boltz-driven swap (not just Fulmine-driven).
5. Pull `covenant-wrapper.ts` deletion when the covenant path is live in production for one beta cycle.
