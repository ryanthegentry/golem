# Spec 20: golem-liquid Pattern Appendix

## Purpose
Documents patterns validated by the golem-liquid reference implementation on Liquid mainnet that inform the Golem Rust rewrite. golem-liquid is NOT a separate codebase to port — it's a proof-of-concept that validated specific patterns before applying them to Ark.

## Validated Pattern: MuSig2 Cooperative Claims

**Mainnet tx:** `f686839d7bc049e5e146a75536d7ad240c2428fbe90b89472d846fff37926d38`

### Tier 0.5 Security Model

```
Claim Path (per-swap):          VTXO Lifecycle (persistent):
┌─────────────────────┐         ┌─────────────────────┐
│ Ephemeral keypair   │         │ ServerSigner key     │
│ Random 32 bytes     │         │ Encrypted on disk    │
│ Lives for seconds   │         │ Full VTXO control    │
│ Blast: 1 swap amt   │         │ Refresh, consolidate │
└─────────────────────┘         └─────────────────────┘
```

- **Ephemeral per-swap keypair:** Generated fresh for each Lightning → VTXO claim
- **Nonce exchange:** Via Boltz `/v2/swap/reverse/{id}/claim` endpoint
- **Partial signature aggregation:** MuSig2 cooperative with Boltz
- **Key discarded after use:** Never persists to disk
- **Blast radius:** Only the in-flight swap amount, not total wallet balance

### Rust SDK Coverage

In the Rust SDK, MuSig2 cooperative claims are handled **internally** by `client.claim_vhtlc(swap_id, preimage)`. Golem does NOT manage MuSig2 sessions directly. The SDK:
1. Generates ephemeral nonce internally
2. Exchanges nonces with Boltz via API
3. Computes partial signatures
4. Aggregates and broadcasts

**No Golem code needed for MuSig2.**

## Validated Pattern: Swap Status Monitoring

### golem-liquid Approach
- WebSocket streaming via Boltz `/v2/ws` for real-time payment detection
- Latency: sub-second notification of VHTLC funding

### Rust SDK Approach
- **Polling** via `wait_for_vhtlc()` and `wait_for_invoice_paid()`
- Polling interval: SDK-internal (~1-5 seconds)
- Acceptable latency for AI agent use case (L402 payments)

**Decision:** Use SDK polling. WebSocket complexity not justified for agent wallet latency requirements.

## Validated Pattern: Boltz Chain Agnosticism

Boltz API supports BTC, L-BTC, RBTC with the same endpoints:
- `POST /v2/swap/reverse/{id}/claim` — chain-agnostic MuSig2
- Minimum swap: 500 sats (Arkade-Boltz gateway)
- Fees: 0.01% submarine (LN→chain), 0.4% reverse (chain→LN)

**Implication for Rust:** SDK wraps Boltz for Bitcoin. Same patterns apply if Liquid support is ever added.

## Pattern NOT Applicable to Rust Rewrite

### Covenant Claim (Liquid-Specific)
golem-liquid validated a covenant claim fallback (`POST http://127.0.0.1:1234/covenant`) for keyless script-path claims using Liquid's introspection opcodes.

On Ark/Bitcoin, the equivalent is the **Introspector-based covenant** (spec 09) which uses a different mechanism:
- Arkade Script with `OP_INSPECTOUTPUTSCRIPTPUBKEY` / `OP_INSPECTOUTPUTVALUE`
- Introspector service signs with tweaked key
- 4-step submission flow (Introspector → arkd → Introspector → finalize)

**The Liquid covenant pattern does NOT transfer directly.** Spec 09 is authoritative for Ark covenant implementation.

## Summary of Applicable Patterns

| Pattern | golem-liquid | Rust SDK | Action |
|---|---|---|---|
| MuSig2 cooperative claim | Manual nonce/sig mgmt | `claim_vhtlc()` internal | Use SDK |
| Swap monitoring | WebSocket real-time | Polling (1-5s) | Use SDK polling |
| Ephemeral keypair | Explicit generation | SDK-internal | No Golem code |
| Boltz API | Direct HTTP | SDK wraps Boltz | Use SDK |
| Covenant claim | Liquid introspection | Ark Introspector (spec 09) | Different mechanism |
| Two-layer security | Claim vs. lifecycle keys | Phase 1: single key | Deferred to Phase 1.5 |
