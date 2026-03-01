# Claw Cash Architecture Audit

**Date:** 2026-02-26
**Repo:** https://github.com/tiero/claw-cash
**Commit:** HEAD of main at time of audit
**Auditor:** Golem project (automated source code audit)

---

## 1. Architecture Diagram

```
                              HUMANS / AGENTS
                                    |
                                    v
                          +------------------+
                          |   cash CLI       |  npm i -g clw-cash
                          |   (minimist)     |  JSON stdout/stderr
                          +--------+---------+
                                   |
                   +---------------+---------------+
                   |               |               |
                   v               v               v
          +--------+---+  +-------+------+  +-----+-------+
          | ArkadeBtc  |  | ArkadeLN     |  | LendaSwap   |
          | Skill      |  | Skill        |  | Skill        |
          | (Ark SDK)  |  | (Boltz swap) |  | (stablecoin) |
          +--------+---+  +-------+------+  +-----+-------+
                   |               |               |
                   +-------+-------+               |
                           |                       |
                           v                       v
                   +-------+-------+    +---------+----------+
                   | Arkade SDK    |    | LendaSat API       |
                   | Wallet.create |    | (LendaSwap SDK)    |
                   +-------+-------+    +--------------------+
                           |
                           |  Identity interface
                           v
                +----------+-----------+
                | RemoteSignerIdentity |  holds only pubkey
                | (SDK package)        |  delegates all signing
                +----------+-----------+
                           |
                           |  HTTPS (JWT + ticket)
                           v
               +-----------+-----------+
               |   clw.cash API        |  Cloudflare Worker
               |   (Hono + D1 + KV)   |  api.clw.cash
               +-----------+-----------+
                           |
                           |  HTTPS (internal API key)
                           v
               +-----------+-----------+
               |   Enclave Signer     |  Evervault Enclave
               |   (Express + noble)  |  clw-cash-signer.*.evervault.com
               |   secp256k1 schnorr  |
               |   in-memory keys     |
               +-----------+-----------+
                           |
                           |  port 9999 (enclave-only)
                           v
               +-----------+-----------+
               | Evervault Encrypt API |
               | (seal/unseal keys)    |
               +-----------------------+

    BACKGROUND DAEMON (cash start):
    +----------------------------------------------+
    |  SwapMonitor     polls LendaSwap every 30s   |
    |  SwapManager     auto-claims Boltz HTLCs     |
    |  AuthMonitor     polls Telegram auth          |
    |  WebhookRegistry dispatches swap events       |
    |  HTTP server     :3457 (balance/send/receive) |
    +----------------------------------------------+

    WEB PAYMENT UI:
    +-----------------------------+
    |  pay.clw.cash               |  Cloudflare Pages
    |  Vite + viem                |  MetaMask EVM funding
    |  LendaSwap SDK (browser)    |  for stablecoin->BTC
    +-----------------------------+
```

---

## 2. Key Custody Model (Q1)

### How Keys Work

**Generation:** Private keys are generated inside the Evervault Enclave via
`@noble/secp256k1` (`randomBytes(32)` -> `getPublicKey()`). The enclave runs an
Express server on port 7000 with an in-memory `Map<string, KeyRecord>` storing
private keys.

**Signing:** Schnorr signatures only (`schnorr.sign()`). No ECDSA support in
the remote signer. The CLI/agent never touches private keys -- it holds only
the compressed public key and calls the API for each signature.

**Signing flow (3-step):**
1. CLI -> API: `POST /v1/identities/:id/sign-intent` (digest hash) -> returns JWT ticket
2. CLI -> API: `POST /v1/identities/:id/sign` (digest + ticket) -> API validates ticket, forwards to enclave
3. API -> Enclave: `POST /internal/sign` (identity_id + digest + ticket) -> enclave verifies JWT, checks replay nonce, signs, returns signature

**Backup/Restore:** On identity creation, the API immediately exports the sealed
(encrypted) private key via the enclave's `/internal/backup/export` endpoint and
stores the opaque ciphertext in Cloudflare D1. On enclave restart (keys lost from
memory), the API auto-restores via `/internal/backup/import`.

**Encryption:**
- **Production:** Evervault internal API on port 9999 (only reachable inside the enclave). Platform-managed keys. No human can provision or see the encryption key.
- **Dev fallback:** AES-256-GCM with a configurable `SEALING_KEY` env var.

### Evervault vs. AWS Nitro

**Important finding:** The landing page markets "AWS Nitro Enclave" but the actual
implementation uses **Evervault Enclaves** (which run on top of AWS Nitro under the
hood). The code has zero direct Nitro SDK usage -- the only Nitro reference is a
`nitro-cli-image.Dockerfile` that installs the Nitro CLI (likely for Evervault's
build process). The `enclave.toml` specifies an Evervault app UUID and PCR attestation
values.

**Communication:** HTTPS (TLS terminated by Evervault's data plane at the enclave
boundary). Not vsock -- Evervault abstracts that away. The API talks to the enclave
via a standard HTTPS URL (`clw-cash-signer.app-*.enclave.evervault.com`).

**Latency:** Each signature requires two HTTP round-trips (sign-intent -> sign ->
enclave). Plus JWT verification at each layer. For batch signing, `sign-batch`
endpoint does all ticket creation + signing in one API call.

### Who Operates the Enclave?

**Tiero-operated.** The enclave is deployed to Evervault under Tiero's team UUID
(`team_e48a089e94da`). The API at `api.clw.cash` is a Cloudflare Worker. Users
authenticate via Telegram 2FA and get a JWT session. Their keys live in the shared
enclave.

This is **fundamentally custodial** in the traditional sense -- Tiero's team controls
the enclave deployment, and key backups sit in Tiero's Cloudflare D1 database
(encrypted by Evervault). The attestation model provides cryptographic proof that
specific code is running, but the operator still controls deployments.

---

## 3. VHTLC Claim Daemon (Q2)

### The Daemon

`cash start` spawns a background Node.js process (`--daemon-internal` flag) that
runs:

1. **Lightning SwapManager** (`ArkadeLightning.startSwapManager()`) -- from
   `@arkade-os/boltz-swap`. Configured with `{ enableAutoActions: true, autoStart: true }`.
   This uses the Boltz SDK's built-in swap manager that automatically monitors
   WebSocket events for reverse swap status changes and auto-claims when HTLCs settle.

2. **LendaSwap SwapMonitor** -- polls `getPendingSwaps()` every 30 seconds. For swaps
   in "processing" status (server has funded the HTLC), calls `claimSwap(swapId)`.
   For expired swaps, calls `refundSwap(swapId)`.

### What Key Signs the Claim?

The claim is signed by the **same enclave key** used for all operations. The flow:
- SwapManager detects HTLC settlement -> calls `wallet.sendBitcoin()` or internal
  claim logic -> Ark SDK calls `identity.sign(tx)` -> `RemoteSignerIdentity.sign()`
  extracts sighash digests -> batch-signs via clw.cash API -> enclave signs with the
  private key.

There is no separate claim key or hot key. The daemon uses the full `RemoteSignerIdentity`
with the same session token, calling back to the enclave for every signature.

### waitAndClaim() -- Sync vs. Async?

The `ArkadeLightningSkill` exposes `waitAndClaim()` but it is **not called during
request handling**. The daemon's SwapManager runs in the background and auto-claims
asynchronously. For Lightning receives, `createLightningInvoice()` returns immediately
with the invoice; the SwapManager handles the claim lifecycle separately.

For LendaSwap stablecoins, the `SwapMonitor.poll()` runs every 30s and processes
claims asynchronously, emitting webhook events on success/failure.

### "Claim Now, Move to Safer Wallet Later" Pattern?

**Not present.** Claims go directly to the Ark wallet (same identity). There is no
intermediate hot wallet or "claim to temporary, then sweep to safe" pattern. The
enclave IS the "safe" signer in this architecture.

---

## 4. Agent-to-Agent Payments (Q3)

Direct OOR (out-of-round) via `wallet.sendBitcoin()`:

```typescript
// skills/src/skills/arkadeBitcoin.ts
async send(params: SendParams): Promise<SendResult> {
  const txid = await this.wallet.sendBitcoin({
    address: params.address,
    amount: params.amount,
    feeRate: params.feeRate,
    memo: params.memo,
  });
  return { txid, type: "ark", amount: params.amount };
}
```

This is the Ark SDK's `sendBitcoin()` which performs an OOR (out-of-round) send
to any Ark address. Agent A -> Agent B is simply:
```bash
cash send --amount 100000 --currency sats --where arkade --to <agent-b-ark-address>
```

No custom protocol. No channels. Standard Ark OOR payments. The Ark SDK handles
the VTXO spending and round participation internally.

---

## 5. Onboarding Flow (Q4)

### `cash init` Step by Step

1. **Load config** from `~/.clw-cash/config.json`, env vars, and CLI flags
   (priority: flags > env > file > defaults).

2. **Authenticate** if no token or token expired:
   - `POST /v1/auth/challenge` -> returns `challenge_id` + Telegram `deep_link`
   - User opens deep link in Telegram, taps Start
   - Telegram webhook at `/telegram-webhook` resolves the challenge
   - CLI polls `POST /v1/auth/verify` every 2s (120s timeout) -> returns JWT
   - **Test mode:** If `TELEGRAM_BOT_TOKEN` not set, challenge auto-resolves

3. **Identity recovery/creation:**
   - Check server for existing identities: `GET /v1/identities`
   - If found: recover the most recent active one, restore in enclave
   - If none: `POST /v1/identities` -> enclave generates key -> API stores sealed backup
   - Save `identityId` + `publicKey` to config

4. **Save config** to `~/.clw-cash/config.json` (mode 0600, dir mode 0700)

5. **Auto-start daemon** (`startDaemonInBackground()`) for swap monitoring.
   Spawns detached child process, polls `/health` until ready (30s timeout).

### Onboarding Friction Assessment

**Low friction for developers:** `npm i -g clw-cash && cash init` is two commands.
The Telegram 2FA is clever -- it verifies human identity without passwords or email.

**High friction for true self-custody:** Users do not control their own keys. The
enclave is Tiero-operated. To "deploy your own," you'd need an Evervault account,
deploy the enclave yourself, run your own Cloudflare Worker, and set up Telegram
bot auth. This is significantly harder than Golem's "one Docker container" model.

**Bot mode** (`POST /v1/auth/bot-session`) enables headless auth for Telegram bots
serving many users -- no human interaction needed. This is a nice pattern for
B2B2C.

---

## 6. Stablecoin Integration (Q5)

### LendaSwap

Integrated via `@lendasat/lendaswap-sdk-pure`. Supports:
- **BTC -> Stablecoin** (`swapBtcToStablecoin`): Agent sends sats to HTLC address
  on Ark, LendaSwap releases stablecoins on EVM chain.
- **Stablecoin -> BTC** (`swapStablecoinToBtc`): Sender funds EVM HTLC, LendaSwap
  releases sats to Ark address.

Supported tokens: `usdc_pol`, `usdc_eth`, `usdc_arb`, `usdt0_pol`, `usdt_eth`, `usdt_arb`.
All 6 decimal precision.

### Boltz (Lightning)

Integrated via `@arkade-os/boltz-swap` (`ArkadeLightning` class). Standard submarine
swaps (pay LN invoice with Ark sats) and reverse swaps (receive LN payment into Ark).

### Vision

"Stablecoins In, Bitcoin Out" -- agents hold BTC as treasury, swap to stablecoins
on the fly when they need to pay for something. The philosophy is identical to
Golem's "BTC is base money, stablecoins are payment rails" thesis but with a
different execution path (LendaSwap instead of direct Boltz submarine swaps).

---

## 7. Multisig (Q6)

**No multisig implementation found.** Zero results for `multisig`, `2of2`,
`MultisigTapscript`, `VtxoScript`, or any multi-key tapscript patterns.

The enclave holds single keys. There is no 2-of-2 between user and enclave, no
spending policy enforcement at the script level, and no delegation keypair pattern.

---

## 8. Claim Covenant (Q7)

**No covenant implementation found.** Zero results for `covenant`, `introspection`,
or `OP_` opcodes. There is no prototype of "HTLC enforces user script as
destination." Claims go to whatever address the Ark SDK resolves (the user's Ark
address).

---

## 9. MCP Server (Q8)

**Not yet implemented.** The README roadmap lists:
> `[ ] MCP server -- Claude Code / Claude Desktop tool-use integration`

The current agent integration is the **CLI subprocess model**: agents call `cash`
as a subprocess and parse JSON stdout. The `SKILL.md` file provides detailed
instructions for AI agents on how to use the CLI, including:
- All commands with expected JSON output shapes
- Reactive behavior guidelines (polling, status updates)
- Error handling patterns
- Webhook registration for swap events

The `skills/` package exports TypeScript classes (`ArkadeBitcoinSkill`,
`ArkadeLightningSkill`, `LendaSwapSkill`) that could be wrapped as MCP tools,
but this hasn't been done yet.

---

## 10. What Golem Should Adopt

### 1. SKILL.md as Agent Instruction Protocol
Claw Cash's `SKILL.md` is a brilliant pattern -- a machine-readable instruction
file that teaches AI agents how to use the wallet. It covers every command,
expected output, polling behavior, error handling, and reactive guidelines. Golem
should adopt this for our CLI.

### 2. Background Daemon Pattern
The `cash start` daemon that auto-claims Boltz HTLCs and monitors LendaSwap swaps
is well-architected. It uses:
- Detached child process (survives CLI exit)
- PID file + health check polling for lifecycle management
- Webhook registry for event push (swap.claimed, swap.refunded, swap.failed)
- Auto-start on `init`

Golem should consider a similar daemon for VTXO refresh monitoring, especially for
the Railway deployment where the agent needs to run continuously.

### 3. Stablecoin Payment Rail
The LendaSwap integration gives Claw Cash "BTC treasury, stablecoin payment" out
of the box. For Golem's L402 gateway, this is less relevant (we use Lightning
directly), but for future x402 support or stablecoin payments, LendaSwap is worth
evaluating.

### 4. Factory Bot Pattern
The `POST /v1/auth/bot-session` pattern -- where a trusted Telegram bot can get
per-user sessions without user-facing auth -- is elegant for B2B2C. Could be
relevant if Golem ever supports multi-user deployments.

### 5. JSON Output Convention
All CLI output as `{"ok": true, "data": {...}}` or `{"ok": false, "error": "..."}`.
Clean, parseable, agent-friendly. Golem's CLI should adopt this consistently.

---

## 11. What Golem Should Differentiate On

### 1. True Self-Custody (Non-Negotiable)
Claw Cash is **effectively custodial**: Tiero's team operates the enclave, stores
encrypted key backups in their D1 database, and controls deployments. The attestation
model is interesting but doesn't change the trust assumption for non-technical users.

Golem's architecture is fundamentally different:
- **Phase 1:** User holds their own key (`GOLEM_SIGNER_KEY` in their own environment)
- **Phase 2:** Delegation with pre-signed artifacts (user retains master key)
- **Each user deploys their own agent** -- no shared cloud service

This is the primary differentiator and should be loudly marketed.

### 2. L402 Lightning Gateway (Shipped, Not Roadmapped)
Golem has a working L402 reverse proxy with V2 binary macaroons. Claw Cash has
neither L402 nor x402 implemented (both are roadmap items). This is a concrete
competitive advantage.

### 3. VTXO Lifecycle Management
Golem's core value prop -- automated VTXO refresh to prevent timelock expiry --
has no equivalent in Claw Cash. Claw Cash doesn't mention VTXO management at all.

### 4. No Mandatory Cloud Services
Claw Cash requires Evervault (enclave), Cloudflare Workers (API), Cloudflare D1
(database), Cloudflare KV (tickets/rate limiting), and a Telegram bot. That's five
external services.

Golem requires: an Ark server (which exists anyway as the ASP) and the user's own
deployment environment. That's it.

### 5. MCP Server (Ship First)
Claw Cash has MCP on the roadmap. Golem should ship an MCP server before they do.
The skills pattern in Claw Cash's `skills/` package is exactly what MCP tools
should look like -- Golem can learn from the interface design and ship first.

---

## 12. Claim Covenant Notes

No claim covenant implementation exists in Claw Cash. The `vhtlc_refund_locktime`
field appears in LendaSwap swap responses but is a standard HTLC timelock, not
a covenant.

The LendaSwap HTLC structure uses:
- `htlc_address_arkade` -- Ark-side HTLC for BTC->stablecoin swaps
- `htlc_address_evm` -- EVM-side HTLC for stablecoin->BTC swaps
- Standard hash/timelock pattern with preimage reveal for claiming

No introspection opcodes, no output covenants, no script-enforced destinations.
This is pure vanilla HTLC atomics.

---

## 13. MoneyDevKit Quick Summary

### Overview
MoneyDevKit (https://github.com/moneydevkit) is a payment infrastructure company
building serverless Lightning checkout for merchants. **Completely different market
segment from Golem or Claw Cash.**

### Repos (10 public)
| Repo | Language | Description |
|------|----------|-------------|
| `lightning-js` | Rust (napi) | LDK bindings for Node.js |
| `ldk-node` | Fork | Modified LDK-node |
| `api-contract` | TypeScript | API contract definitions |
| `rust-lightning` | Fork | Modified rust-lightning |
| `vss-server` | - | Versioned Storage Service |
| `mdk-checkout` | TypeScript | Next.js checkout components |
| `mdk-examples` | TypeScript | Demo apps |
| `bitcoin-payment-instructions` | - | BIP21/BOLT11 resolver |
| `lnurl-rs` | Fork | LNURL library |
| `Baileys` | Fork | WhatsApp Web API (for notifications?) |

### Architecture
- **Serverless Lightning nodes** that spin up per checkout, create invoice, receive
  payment, then spin down
- Built on **LDK (Lightning Dev Kit)** via Rust NAPI bindings
- Keys managed via `MDK_MNEMONIC` -- user holds the mnemonic, node runs on their
  infra
- LSP-like behavior: MoneyDevKit opens channels and manages liquidity behind the
  scenes
- **Self-custodial**: "At no point do we have access to your keys or money"

### Relevance to Golem
- **No L402/x402 support** -- purely merchant checkout
- **No Ark integration** -- pure Lightning
- **No agent wallet** -- designed for human merchants, not AI agents
- **Interesting LDK pattern**: Their serverless Lightning node approach could be
  relevant if Golem ever needs ephemeral Lightning nodes for specific operations
- **Not a competitor** -- different market (merchant checkout vs. agent wallet)

### Lightning Agent Tools (from Lightning Labs)
More relevant than MoneyDevKit: Lightning Labs has shipped
[`lightning-agent-tools`](https://github.com/lightninglabs/lightning-agent-tools)
with 7 composable skills including L402 client/server, remote signer, MCP server,
and node management. This is closer to Golem's space but requires running an LND
node (much heavier than Ark + Boltz).

---

## 14. Summary: Claw Cash vs. Golem Positioning

| Dimension | Claw Cash | Golem |
|-----------|-----------|-------|
| **Custody** | Custodial (Tiero-operated enclave) | Self-custodial (user-deployed) |
| **Signing** | Remote (enclave over HTTPS) | Local (GolemSigner interface) |
| **Protocol** | Ark SDK + Boltz + LendaSwap | Ark SDK + Boltz |
| **Auth** | Telegram 2FA | N/A (user's own deployment) |
| **Agent integration** | CLI subprocess + SKILL.md | CLI + API server + PWA |
| **L402** | Roadmap (x402 also roadmap) | **Shipped** (V2 macaroons) |
| **Stablecoins** | Shipped (LendaSwap) | Not yet |
| **MCP** | Roadmap | Not yet (ship first!) |
| **VTXO refresh** | Not mentioned | **Core feature** |
| **Infra deps** | 5+ cloud services | 1 (Ark server) |
| **Target** | Multi-tenant (many users, one service) | Single-tenant (one user, one agent) |
| **Maturity** | CLI + daemon + web payment UI + production Evervault deploy | CLI + API + PWA + testnet validated |
