# Golem L402 Storyboard (v2)
## "From Side Project to Paid API in 15 Minutes"

*Updated March 1, 2026 — Incorporates covenant architecture, 402index.io live distribution, Pika agent messaging, and Ark stablecoin timeline*

---

## The Provider: Marcus Chen

**Who he is:** 28-year-old full-stack developer in Portland. Works at a mid-size SaaS company by day. On nights and weekends, he maintains an open-source hyperlocal air quality API called **BreatheLocal**. He runs 14 PurpleAir sensors across the Portland metro area, ingests NWS data, and blends it with his own ML model that predicts neighborhood-level AQI 6 hours out. His model outperforms EPA AirNow for Portland by a meaningful margin because of the sensor density.

**Why he's the right target:** Marcus has something *differentiated* — not commodity weather data, but proprietary sensor data + a custom model. His API gets ~2,000 calls/day from about 40 developers who found it on GitHub. He's been running it for free on a $12/month Hetzner VPS. His girlfriend keeps asking when it's going to make money. He's looked at Stripe integration three times and abandoned it each time because he doesn't want to deal with account management, pricing tiers, and webhook hell for what amounts to $50-200/month in potential revenue. He just wants: if you call my API, I get paid. That's it.

**Where he hangs out:** Hacker News, r/selfhosted, r/homelab, r/purpleair, Portland tech Slack, various weather/climate Discords, Stacker News, and he browses 402index.io occasionally (he's been following the L402 vs x402 debate).

---

## ACT 1: Marcus Discovers Golem (Provider Onboarding)

### Scene 1: 402index.io

Marcus is on 402index.io browsing the directory. He sees 13,000+ endpoints — mostly x402 (stablecoin-based). Only 24 are L402 (Bitcoin-native). He clicks through to a blog post linked from the site: *"The Bitcoin Case for Agent Payments."*

The post makes the argument: AI agents are going to transact autonomously. The rails they use will determine whether the agent economy runs on self-custodial Bitcoin or custodial stablecoins. The x402 ecosystem has a head start (12K endpoints), but it's built on EVM stablecoins with custodial intermediaries. L402 is the Bitcoin-native alternative — same HTTP-native payment flow, but settling in sats on Lightning/Ark.

At the bottom: *"List your API on 402index. Monetize it with Golem — one command, no Lightning node."*

He clicks through to the Golem README.

### Scene 2: Install and Init (~3 minutes)

Marcus SSHs into his Hetzner box where BreatheLocal runs.

```
$ npm install -g @golem-wallet/cli
```

Then:

```
$ golem init
```

**Golem interaction #1 — Wallet creation:**
```
🔑 Creating new Ark wallet...
Generated wallet ID: gw_m7x2k9...
Your wallet address (Ark VTXO): ark1q8f7...

⚠️  Back up your seed phrase now:
  [witch autumn grape hollow ...]

Your key will be encrypted on this server.
Set a password (min 8 chars): ********
Confirm: ********

🔒 Key encrypted (AES-256-GCM, scrypt N=2^17)

Fund your wallet to start receiving payments.
Minimum balance not required — you can receive first.

Wallet ready. Next: golem gateway --help
```

No Lightning node. No channel management. No inbound liquidity. Just a wallet that can hold VTXOs and receive Lightning payments via Boltz. Marcus writes the seed phrase on a sticky note (he'll move it to his password manager later, he tells himself).

**What's happening under the hood:** Golem creates a secp256k1 keypair, encrypts the private key with AES-256-GCM using a scrypt-derived key, stores only the encrypted key and pubkey on disk. Connects to `arkade.computer` as the Ark Service Provider. The encrypted key is used for VHTLC claiming when Lightning payments arrive via Boltz reverse swaps.

**With covenant mode (Phase 2):** After `golem init`, the server deletes the private key entirely. Shows the seed phrase once, then operates in receive-only mode. The claim daemon handles incoming payments via covenant scripts — no signing key on the server at all. The seed phrase lives only on Marcus's phone.

### Scene 3: Gateway Setup (~2 minutes)

Marcus's BreatheLocal API runs on localhost:3000. He adds Golem as a reverse proxy:

```
$ golem gateway \
    --upstream localhost:3000 \
    --port 8402 \
    --price 10 \
    --currency sats \
    --description "BreatheLocal AQI — hyperlocal Portland air quality" \
    --free-paths "/health,/docs"
```

**Golem interaction #2 — Gateway confirmation:**
```
🌐 Golem Gateway active on :8402
   Upstream: localhost:3000
   Price: 10 sats per request
   Free paths: /health, /docs
   Payment rails: Lightning (Boltz) + Ark-native (OOR)
   
   L402 challenge will be issued for all other paths.
   
   Test it: curl -v http://localhost:8402/v1/aqi?lat=45.52&lng=-122.68
```

Under the hood, Golem is:
- Running an Aperture-equivalent L402 reverse proxy, backed by Ark instead of LND
- Issuing macaroons scoped to his endpoint with per-request caveats
- Accepting payments via both Lightning (Boltz reverse swap → Ark VTXO) and Ark-native OOR
- L402 challenge issued in ~139ms, payment settles in ~1s, token verified in ~9ms

Marcus lists himself on 402index.io and updates his GitHub README:

> **Free tier removed.** BreatheLocal now charges 10 sats/request via L402.
> Any L402-compatible client works. Docs: breathelocal.example.com/docs

### Scene 4: First Payment (~30 seconds later)

A developer in Tokyo who had BreatheLocal in a cron job gets a 402 response. She has Golem installed (she uses it for three other L402 APIs she found on 402index). Her agent automatically pays and gets the data. Marcus sees:

```
$ golem balance
💰 Wallet balance: 30 sats
   Today:  3 requests, 30 sats
   
   ⏱  VTXO refresh: 6 days remaining
       Golem will auto-refresh before expiry.
```

It's not much. But it's the first money BreatheLocal has ever made, and he didn't fill out a single form.

**Monitoring:** Marcus gets a Telegram message from his Golem bot:
```
ℹ️ GOLEM INFO
First payment received: 10 sats from gw_t4k7...
Wallet balance: 30 sats
```

---

## ACT 2: The Agent Wave (Demand Side)

### Scene 5: Jake's Morning Brief Agent

**Who:** Jake Rivera, 34, product manager in Austin. Runs an AI agent on a cloud VM. His agent sends him a morning briefing every day at 6:45am via Telegram: calendar summary, top emails, local weather + AQI (Jake has mild asthma), and relevant Hacker News posts.

Jake's agent has been getting AQI from the free OpenWeatherMap tier. The data is mediocre — city-level, updated every 3 hours. Jake mentioned offhand in Telegram: "I wish the air quality data was more specific to my neighborhood, the reading today felt wrong."

The agent, searching for better AQI sources, finds BreatheLocal on 402index.io (via the MCP server integration — the agent can browse the directory natively). But it's behind L402.

### Scene 6: The 402 Error

Jake's agent tries to call BreatheLocal and gets:

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: L402 macaroon="AGIAJEem...", invoice="lnbc100n1..."
Content-Type: application/json

{
  "error": "payment_required",
  "price_sats": 10,
  "description": "BreatheLocal AQI — hyperlocal Portland air quality",
  "docs": "https://breathelocal.example.com/docs"
}
```

The agent doesn't know how to pay. It reports to Jake via Telegram:

```
🤖 Morning brief partially complete. I found a better AQI source 
(BreatheLocal — hyperlocal, neighborhood-level, 6hr forecast) 
but it requires L402 payment (10 sats/request ≈ 300 sats/month 
at our current usage).

Options:
1. Install Golem wallet so I can pay for L402 APIs
2. Stick with OpenWeatherMap (free, lower quality)
3. Find another free AQI source

[Install Golem] [Keep Current] [Find Alternative]
```

Jake taps "Install Golem."

### Scene 7: Agent Self-Install + Human Funding (~90 seconds of Jake's time)

The agent installs Golem CLI on its VM:

```
$ npm install -g @golem-wallet/cli
$ golem init --agent-mode
```

**Golem interaction #3 — Agent wallet creation:**
```
🤖 Agent wallet created (restricted mode)
   Wallet ID: gw_a3f9...
   
   Agent permissions:
   ✅ Pay L402 invoices up to 1000 sats each
   ✅ Auto-pay services listed on 402index
   ❌ Cannot send to arbitrary addresses
   ❌ Cannot sweep wallet
   
   ⚠️  Wallet is empty. Fund it to enable payments.
   
   Fund via Lightning: lnbc50u1p...
   Fund via Ark: ark1qz7...
```

The agent sends Jake a Telegram message:

```
🤖 Golem wallet ready. I need funds to pay for APIs.

Tap to fund 5,000 sats (~$3.30, covers ~500 API calls ≈ 16 months of AQI):

⚡ [Fund 5,000 sats via Lightning]
```

Jake opens his wallet app, scans the Lightning invoice, confirms. 15 seconds later:

```
🤖 Wallet funded: 5,000 sats ($3.31)
   Estimated API budget: ~500 calls
   
   I've already fetched your neighborhood AQI from BreatheLocal.
   Current AQI at your location: 42 (Good) 🟢
   6hr forecast: Rising to 67 (Moderate) by 2pm — 
   consider morning outdoor exercise.
   
   BreatheLocal added to daily brief. Cost: ~300 sats/month.
```

Jake's total effort: read two messages, tap once, scan a QR code. He now has an agent with a funded wallet that autonomously pays for premium APIs.

### Scene 8: The Network Effect

Over the next month, this pattern repeats across the agent ecosystem. Hundreds of agents hit BreatheLocal's 402 response. Most of them already have Golem installed (from hitting other L402 APIs on 402index). The ones that don't go through the same flow Jake did.

Marcus checks his dashboard:

```
$ golem stats --30d
📊 Last 30 days:
   Total requests:  18,247
   Unique wallets:  312
   Revenue:         182,470 sats ($120.83)
   
   Top consumers:
   gw_a3f9...  (Jake's agent)       892 calls   5,920 sats
   gw_7k2m...  (unknown)          1,247 calls   12,470 sats
   gw_f8n1...  (unknown)            634 calls    6,340 sats
   
   Avg daily revenue: 6,082 sats ($4.03)
   Projected monthly: ~$120
```

Not life-changing money. But it's covering his VPS costs 10x with zero billing infrastructure, zero customer support, zero invoicing. Just an API with a price.

---

## ACT 3: Covenant Mode (The Security Upgrade)

### Scene 9: The Upgrade Notification

Marcus has been accumulating sats for 3 months. His wallet holds ~500,000 sats ($330). He's starting to think about security — that encrypted key on his Hetzner VPS is the only thing between an attacker and his earnings.

Golem releases covenant mode. Marcus sees:

```
$ golem upgrade --covenant
```

**Golem interaction — Covenant upgrade:**
```
🔒 Covenant Mode Available

Your wallet currently uses an encrypted hot key on this server.
Covenant mode eliminates the key entirely:

  ✅ Server receives Lightning payments (no key needed)
  ✅ Server refreshes VTXOs automatically (no key needed)
  ✅ Server consolidates small VTXOs (no key needed)
  ❌ Server CANNOT spend to other addresses (ever)
  
  Spending requires your mobile app or hardware wallet.

This upgrade:
1. Creates a covenant VTXO with your existing funds
2. Transfers your seed phrase to your mobile app
3. Deletes the private key from this server permanently
4. Server continues operating in receive-only mode

Your seed phrase will be shown ONE TIME for mobile import.

Ready? [y/n]
```

Marcus confirms. The server sweeps his 500,000 sats into a covenant VTXO — a four-leaf taptree where Leaf 1 (the recursive covenant) handles all autonomous operations and Leaf 2 (Alice's key) lives only on his phone. The private key is deleted from the server.

His BreatheLocal API keeps earning sats. His gateway keeps issuing 402 challenges and claiming payments. But now if his server is compromised, the attacker gets... nothing. There's no key to steal. The funds can only go to Marcus's own covenant VTXO (enforced by the script) or be spent by his mobile key.

```
$ golem balance
💰 Wallet balance: 500,000 sats ($331)
   Mode: Covenant (receive-only, no key on server)
   
   Spending requires: Golem mobile app or Tapsigner
   
   ⏱  VTXO refresh: 5 days remaining
       Covenant auto-refresh: enabled (no signature needed)
```

---

## ACT 4: Stablecoins + DeFi (The Full Stack)

### Scene 10: Working Capital

Six months in. Marcus's BreatheLocal is now getting 50,000+ calls/day from ~800 agents. Revenue is ~500,000 sats/month ($330). He wants to add more sensors and expand to Seattle.

Arkade stablecoins have shipped. Marcus sees Fuji integration in Golem:

```
$ golem assets
💎 Wallet Assets:
   BTC:  1,500,000 sats ($993)
   USDT: 0

Available actions:
   golem swap --from BTC --to USDT --amount 500000
   golem fuji borrow --collateral 500000 --currency USDT
   golem fuji lend --amount 500000 --currency BTC
```

Marcus swaps some sats to USDT to pay for sensors. His API keeps earning. His covenant wallet keeps auto-refreshing. His agent is operating a small business on Bitcoin-native rails.

---

## ACT 5: Agent-to-Agent (The Pika Layer)

### Scene 11: Autonomous Agent Commerce

*This scene is aspirational and depends on Pika integration architecture decisions.*

Jake's morning brief agent has gotten more sophisticated. It now uses three paid APIs (BreatheLocal, a transit delay API, and a local news summarizer) all paid via Golem. But the transit API wants to negotiate bulk pricing — 5,000 sats for 1,000 requests instead of 10 sats each.

The transit API's agent and Jake's agent negotiate directly via Pika — the encrypted Nostr-based messaging layer for AI agents. They agree on terms. Jake's agent sends a bulk payment via its Golem wallet. The transit API's agent issues a macaroon with 1,000 request caveats.

No human was involved. Two agents communicated securely (Pika), negotiated terms, and settled payment (Golem). This is the full vision: agent-to-agent commerce with self-custodial Bitcoin payments and end-to-end encrypted coordination.

---

## Feature Set Implications (Prioritized)

### Must Have for Provider Story (Marcus) — Phase 1
1. **`golem init`** — Wallet creation with Ark VTXOs, seed backup, encrypted key storage ✅
2. **`golem gateway`** — L402 reverse proxy backed by Ark (not LND) ✅
3. **L402 challenge/response** — Standard macaroon + invoice, settles on Ark ✅
4. **`golem balance` / `golem stats`** — Revenue tracking, consumer analytics ✅
5. **VTXO auto-refresh** — Agent handles round participation automatically ✅
6. **Telegram monitoring** — Alert on payments, balance, VTXO expiry ✅
7. **Mainnet deployment** — Network switching, encrypted config, safe harbor ✅

### Must Have for Consumer Story (Jake's Agent) — Phase 1
8. **`golem init --agent-mode`** — Restricted wallet with spending caps ✅
9. **L402 client** — Transparent challenge-response: see 402, pay, retry with token ✅
10. **402index.io integration** — Agent discovers paid APIs via directory / MCP server ✅ (mostly)

### Phase 2 — Covenant Mode
11. **Covenant VTXO creation** — Four-leaf taptree with recursive covenant
12. **Claim daemon** — Keyless VHTLC claiming via introspection opcodes
13. **`golem upgrade --covenant`** — Migration from hot key to covenant mode
14. **Mobile app** — Import seed phrase, authorize spending (Leaf 2)

### Phase 3 — Infrastructure Platform
15. **SDK** — For wallet developers to integrate agent-managed receive-only mode
16. **Stablecoin support** — Fuji, USDT0, via Arkade Assets
17. **Open covenant VTXO standard** — Published specification for ecosystem

### Phase 4 — Agent Commerce (Pika Integration)
18. **Agent-to-agent negotiation** — Bulk pricing, SLAs, via Pika messaging
19. **Autonomous payments** — Golem wallets paying each other without human intervention
20. **DeFi primitives** — Swap, lend, borrow via Arkade protocols

### Critical Dependencies (Not in Golem's Control)
- Arkade introspection opcodes shipping (gates Phase 2)
- Ark Labs ASP reliability (7-day VTXO expiry is tight)
- Boltz gateway support for covenant VHTLCs (gates keyless receive)
- Arkade stablecoin launch — Fuji (weeks), USDT0/USDC (months)
- Pika maturity (gates Phase 4 agent-to-agent scenarios)

---

## What Makes This Story Believable

1. **Marcus is a real archetype.** Thousands of developers run free APIs that they wish made money. The x402 ecosystem (12K+ endpoints) proves demand exists.

2. **The agent-side adoption is plausible.** AI agents already manage API calls and costs. The 402index MCP server puts 13K+ services into any MCP-enabled agent's tool palette. Adding "pay for L402 APIs" is a natural extension.

3. **The security upgrade story is compelling.** Going from "encrypted key on server" to "no key on server, ever" is a genuine step function in security. No other wallet architecture offers this for autonomous receive operations.

4. **The revenue scale is honest.** Marcus makes $120/month after 30 days, not $120K. This is a side-project monetization tool that becomes infrastructure. That's more believable — nobody is buying the "$1M ARR from your weather API" pitch.

5. **The stablecoin scene is real, not aspirational.** Arkade stablecoins (Fuji) are shipping in weeks, not years. USDT0 integration is on the near-term horizon. This isn't "if DeFi primitives ever ship" — it's "when these specific, funded, in-development features launch."

6. **The Pika scene IS aspirational.** Agent-to-agent autonomous commerce is the long-term vision. It depends on Pika's development and the Pika/Golem integration architecture that hasn't been designed yet. This scene is included to show the full potential, not to promise near-term delivery.

## What Would Kill This Story

- Covenant + round/forfeit incompatibility (core architecture breaks)
- Ark VTXO refresh fails silently and Marcus loses funds
- Lightning → Ark swap via Boltz takes 10+ minutes instead of ~1 second
- Arkade introspection opcodes slip past Q2 2026
- No one builds MCP/agent integrations, so adoption requires manual CLI work
- `arkade.computer` goes down for >5 days (within VTXO expiry window)
- Regulatory action classifies L402 gateways as money transmission
