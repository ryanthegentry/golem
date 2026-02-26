# Golem Live Demo — Ark Labs

**Audience:** Ark Labs maintainer + Ark Labs team
**Format:** Screen share, terminal + browser
**Duration:** ~15 minutes
**Network:** mutinynet (testnet)

---

## Pre-Demo Checklist

Run these before the call. Do NOT run them live — they take time and can fail on network flakiness.

**Set the Voltage LND macaroon env var** (base64-encoded admin macaroon):
```bash
export VOLTAGE_MACAROON="<base64-encoded LND macaroon>"
# The macaroon is stored in 1Password / your secrets manager.
# It must NOT be committed to the repo.
```

```bash
# 1. Clean slate
rm -rf ~/.golem

# 2. Ensure Voltage LND is online (requires Node — curl has HTTP/2 issues with LND REST)
node -e "
const mac = Buffer.from(process.env.VOLTAGE_MACAROON, 'base64').toString('hex');
fetch('https://golem-tester.u.voltageapp.io:8080/v1/getinfo', {
  headers: { 'Grpc-Metadata-macaroon': mac }
}).then(r => r.json()).then(d => console.log('LND online:', d.alias, '| Synced:', d.synced_to_chain));
"
# Should print: "LND online: golem-tester | Synced: true"

# 3. Prime liquidity (keysend + submarine swap)
#    Only needed if Boltz has no ARK liquidity or LND has no inbound.
#    Full automated script:
VOLTAGE_MACAROON="$VOLTAGE_MACAROON" npx tsx src/l402/test-live-manual.ts
# Watch for "PASS" at the end. If it passes, liquidity is set.

# 4. Fund the demo wallet with the mutinynet faucet AFTER golem init
#    (do this during the "waiting for faucet" section below)
```

---

## Demo Flow

### Act 1: "Create a wallet in one command"

**Talking point:** *"Golem is a self-custodial Bitcoin wallet that runs as a CLI. One command, you have a wallet on Ark."*

```bash
npm run golem -- init
```

**Expected output:**
```
Generating new wallet...

Wallet initialized successfully!

  Network:  mutinynet
  Server:   https://mutinynet.arkade.sh
  Address:  tark1q...
  Config:   /path/to/workspace/.golem/config.json

WARNING: Private key stored unencrypted. Do NOT use with real funds.

Next steps:
  golem balance          — Check your balance
  golem gateway --help   — Start an L402 gateway
```

**What to say:**
- "That `tark1q...` address is a real Ark address on your mutinynet server."
- "Config lives at `~/.golem/config.json` — network, server URL, wallet address."
- "The key is a MockSigner for testnet. Production swaps in a Tapsigner or phone key behind the same `GolemSigner` interface. The agent never touches the master key."

**Show the config (optional):**
```bash
cat ~/.golem/config.json | jq .
```

---

### Act 2: "Fund from faucet"

**Talking point:** *"Let's put some sats in. Mutinynet faucet sends on-chain, then we board into Ark."*

Open the mutinynet faucet in a browser tab (have this pre-loaded):

```
https://faucet.mutinynet.com
```

1. Copy the boarding address:
   ```bash
   # The Ark address from init is for off-chain receives.
   # For on-chain funding, we need the boarding address.
   # (In the full wallet UI, this is shown automatically.)
   # For now, check balance — the address shown is the Ark address.
   npm run golem -- balance
   ```

2. Paste the Ark address into the faucet. Request 10,000 sats.

3. Wait ~30 seconds for the mutinynet block.

**What to say while waiting:**
- "Boarding is the Ark on-ramp. On-chain funds land at a special address. Once confirmed, they get swept into a VTXO inside Ark."
- "VTXOs expire on ~4 week timelocks. If users don't refresh, they lose their bitcoin. That's the problem Golem solves — an agent that watches and refreshes automatically."

> **Note:** The faucet sends to the Ark address, which goes through boarding. It may take 1-2 minutes for the boarding round to complete. If time is tight, have a pre-funded wallet ready (use Ryan's testnet key with `golem init --force` and then set the key in `~/.golem/config.json`).

---

### Act 3: "Check the balance"

```bash
npm run golem -- balance
```

**Expected output (after funding):**
```
Connecting to Ark server...

  Network:    mutinynet
  Address:    tark1q...

  Total:      10,000 sats
  Available:  10,000 sats
  Settled:    10,000 sats
  Boarding:   0 sats
```

**What to say:**
- "10,000 sats, fully settled inside Ark. No on-chain footprint."
- "This is the same `GolemWallet.getBalance()` that the refresh agent and the web UI use. One wallet, three interfaces."

> **If balance still shows 0:** The boarding round hasn't completed yet. Say "Boarding takes one Ark round — usually under a minute on mutinynet. Let me come back to this." Move to Act 4 and check balance again later.

---

### Act 4: "Monetize an API with one command"

**Talking point:** *"Now the interesting part. Let's say you have an API — air quality data, weather, anything. One command turns it into a paid API using L402 and Lightning. No Stripe. No LND node. Just Ark."*

**Start the mock API backend (in a separate terminal, or pre-start it):**
```bash
BACKEND_PORT=3097 npx tsx src/l402/test-backend.ts
```
```
BreatheLocal mock API running on http://0.0.0.0:3097
```

**Start the gateway:**
```bash
npm run golem -- gateway --upstream http://localhost:3097 --price 1000 --free-paths /health
```

**Expected output:**
```
Connecting to Ark server...
Starting Lightning swap provider...
SwapManager started
[l402] No rootKey provided — generated random key. Tokens will not survive restarts.

L402 gateway running!

  URL:        http://0.0.0.0:8402
  Upstream:   http://localhost:3097
  Price:      1000 sats/request
  Free paths: /health
  Network:    mutinynet

Press Ctrl+C to stop.
```

**What to say:**
- "That's it. Port 8402 is now an L402 reverse proxy. `/health` is free. Everything else costs 1000 sats."
- "Under the hood: Boltz creates Lightning invoices backed by Ark. No LND required on the server side. The gateway wallet IS the Ark wallet."
- "L402 is the HTTP 402 payment protocol. Client gets a macaroon + invoice, pays via Lightning, sends the preimage back. Stateless authentication."

---

### Act 5: "Free path works, paid path challenges"

**In a new terminal:**

```bash
# Free path — no payment needed
curl http://localhost:8402/health
```
```json
{"status":"ok"}
```

```bash
# Paid path — 402 challenge
curl -s http://localhost:8402/v1/aqi | jq .
```
```json
{
  "error": "Payment Required",
  "description": "Payment required: 1000 sats",
  "price": 1000,
  "invoice": "lntbs10u1...",
  "macaroon": "eyJ...",
  "paymentHash": "8f93..."
}
```

**What to say:**
- "Health check goes straight through. The AQI endpoint returns a 402 with a Lightning invoice."
- "That invoice was created by Boltz — a reverse submarine swap. When someone pays it, the sats land in our Ark wallet. No channels, no liquidity management on our side."

**Show the WWW-Authenticate header (optional, for the protocol nerds):**
```bash
curl -sI http://localhost:8402/v1/aqi | grep -i www-authenticate
```
```
www-authenticate: L402 macaroon="eyJ...", invoice="lntbs..."
```

---

### Act 6: "Pay with Lightning, get the data"

**Talking point:** *"Now let's be the client. Pay the invoice from our Voltage LND node and use the preimage to authenticate."*

This is the part that proves real money moves. One script handles the full flow:

```bash
# Pays the 402, gets preimage, retries with L402 token
VOLTAGE_MACAROON="$VOLTAGE_MACAROON" npx tsx scripts/demo-pay.ts http://localhost:8402/v1/aqi
```

**Expected output:**
```
Requesting http://localhost:8402/v1/aqi...

402 Payment Required
  Price:        1000 sats
  Payment hash: 8f93...
  Invoice:      lntbs10u1...

Paying invoice via Voltage LND...
  Preimage: 01010253...

Retrying with L402 token...
  Status: 200
  Response:
{
  "aqi": 42,
  "location": "Portland, OR",
  "lat": 45.52,
  "lng": -122.68,
  "forecast": "Good",
  "timestamp": "2026-02-26T..."
}

Paid 1000 sats. Data received.
```

**What to say:**
- "Voltage LND paid the invoice. Boltz routed it through a reverse submarine swap into our Ark wallet."
- "The preimage proves payment. Combined with the macaroon, it authenticates the request. No cookies, no API keys, no accounts."
- "That round-trip — invoice creation, Lightning payment, verification — takes about 1-3 seconds."

> **If Boltz fails with "onchain coins could not be sent":** Boltz has no ARK liquidity. This means the pre-demo liquidity priming (Step 0b) didn't run or has been depleted. Fall back to: "Boltz needs ARK liquidity for reverse swaps. In production, this is always available. On mutinynet testnet, we prime it with a submarine swap first." Then show the already-recorded output from `test-live-manual.ts`.

---

### Act 7: "Check revenue"

```bash
npm run golem -- stats
```

**Expected output:**
```
L402 Gateway Stats

  Total requests:     3
  Paid requests:      1
  Challenges issued:  2
  Sats earned:        1,000
```

**What to say:**
- "Three total requests: the health check, the 402 challenge, and the paid request."
- "1,000 sats earned. That's real Lightning revenue landing in an Ark wallet."

```bash
npm run golem -- balance
```

**Expected output:**
```
  Total:      11,000 sats
  Available:  11,000 sats
```

**What to say:**
- "Started with 10,000. Earned 1,000 from the API. Balance went up."
- "No invoicing, no settlement delay, no payment processor taking a cut. Lightning in, Ark settles."

> **Note:** The balance increase from the reverse swap may show as `preconfirmed` until the next Ark round settles it. If `available` hasn't increased yet, explain: "The payment is preconfirmed — it'll settle in the next Ark round, usually under a minute."

---

## Key Messages

Weave these into the conversation naturally. Don't read them as a list.

1. **Self-custodial from line one.** The agent holds a delegation credential, not the master key. `GolemSigner` interface enforces this — MockSigner for testnet, Tapsigner for production. Same boundary.

2. **No LND required.** The gateway creates invoices via Boltz reverse swaps backed by Ark. Server operators don't need to run Lightning infrastructure.

3. **VTXO lifecycle management.** VTXOs expire. Golem watches and refreshes them automatically. This is the core product — the CLI and gateway are the first applications on top of it.

4. **L402 is the monetization primitive.** HTTP 402 + macaroons + Lightning. Stateless, machine-to-machine, no accounts. Perfect for APIs, AI agents, IoT.

5. **Built on your SDK.** GolemWallet wraps `@arkade-os/sdk`. GolemIdentity bridges `GolemSigner` to the SDK's `Identity` interface. 93 tests passing. Filed 3 SDK bugs along the way (#310, #311, #312).

---

## Recovery Plays

**Faucet is slow / block not mined:**
Skip to Act 4. Use Ryan's pre-funded testnet key:
```bash
# Set the known funded key in config
npm run golem -- init --force
# Then edit ~/.golem/config.json and set:
#   "privateKey": "fixture"
npm run golem -- balance
```

**Boltz has no ARK liquidity:**
"On mainnet, Boltz always has liquidity. On testnet, we prime it with a submarine swap. Let me show you the recorded output from our last run instead."

**Voltage LND is down:**
Show the recorded output from `test-live-manual.ts` (the PASS result). "Here's the last successful run — full keysend, submarine swap, reverse swap, L402 verification."

**Balance doesn't reflect payment yet:**
"The reverse swap preconfirmed but hasn't settled into an Ark round yet. On mutinynet that's usually under a minute. The sats are there, just not finalized."

---

## Closing

*"Four commands: init, balance, gateway, stats. That's a self-custodial wallet, an L402 payment gateway, and a revenue dashboard — all backed by Ark, no Lightning node required. Next up: Railway template so anyone can deploy this with one click."*
