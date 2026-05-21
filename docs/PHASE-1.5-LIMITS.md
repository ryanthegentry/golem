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
As of 2026-05-21 the regtest stack (arkd v0.9.3 + `/tmp/introspector` master + the SDK versions pinned in golem's `package.json`) **hangs in `Ramps.onboard` after the wallet subscribes to the round event stream**. The boarding gRPC stream opens but `RegisterIntent` is never called — arkd loops "round X aborted: not enough intents registered 0/1" indefinitely.

Verified this is independent of any new code in this dispatch:
- Newly-written `test/regtest/covenant-receive-e2e.ts` hangs at boarding.
- Pre-existing `test/regtest/covenant-claim.ts` (last verified green 2026-04-20 on a binary-swapped Introspector container) hangs at the same point with identical arkd log signature.
- Restarting arkd + arkd-wallet + introspector + bancod + fulmine into a fresh state does not change the behavior.
- Increasing `ARKD_SESSION_DURATION` from 10 to 30 seconds does not change the behavior.

Likely root cause is a SDK ↔ arkd version mismatch between `@arkade-os/sdk` and arkd v0.9.3 (or master Introspector expectations), introduced upstream sometime after the 2026-04-20 binary-swap baseline. Out of scope for this dispatch to chase — the regression is in third-party code we don't own.

**What this means for the dispatch:**
- Unit tests prove the receiver-side correctness in isolation: 75 tests across storage, detection, claim handler, refresh refactor, and the ArkadeSwaps subscription wiring (`covenant-claims-repo.test.ts`, `vhtlc-detection.test.ts`, `claim-handler.test.ts`, `covenant-refresh.test.ts`, `covenant-claim-subscription.test.ts`). All green.
- The byte-exact protocol primitives (`buildNonInteractiveClaimArkadeScript`, `buildCovenantClaimLeaf`, `findCovenantClaimLeaf`) match PR #411's `enforcePayTo` byte-for-byte under test, with negative-case rejection on every input axis.
- The cross-implementation E2E proof (Fulmine sender → Golem self-solver) is written (`covenant-receive-e2e.ts`) but cannot execute past boarding on the current upstream stack. It will run as-is the moment boarding works again (no change to the test file needed — only to the surrounding stack versions).

**Unblocking when revisited:**
1. Diagnose the arkd-vs-SDK mismatch — likely a wire-format or stream-protocol drift. Check `arkade-os/arkd` and `arkade-os/ts-sdk` recent commits for boarding-flow changes.
2. Pin arkd to a known-good commit (the v0.9.0-rc.4 build that worked on 4/20 — see the journal) OR upgrade `@arkade-os/sdk` to a version compatible with arkd v0.9.3.
3. Re-run `covenant-claim.ts` first as a smoke test; if green, re-run `covenant-receive-e2e.ts`.

This blocker is captured in continuation.md as the top priority for the next session.

### `covenant-wrapper.ts` deletion
The wrap-path module is `@deprecated` and untouched by this dispatch. Deletion happens when Boltz ships Path B in production AND Golem swaps over to the covenant path in production. Not before.

## How this surface evolves

When Boltz ships Path B, the Day-0 followup is:
1. Update `@arkade-os/boltz-swap` to the version exposing the wire fields.
2. Implement the production `recipeProvider` (see "Boltz-side sender wiring" above).
3. Resolve the auto-claim conflict.
4. Run `covenant-receive-e2e.ts` against a Boltz-driven swap (not just Fulmine-driven).
5. Pull `covenant-wrapper.ts` deletion when the covenant path is live in production for one beta cycle.
