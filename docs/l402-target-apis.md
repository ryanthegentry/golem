# L402 Target APIs — What's Worth Paywalling?

Analysis of the top API categories that make sense for Golem's L402 gateway to protect. Ordered by technical fit.

---

## 1. LLM Inference APIs

**Why it's #1:** This is the killer app for L402. AI agents already need to pay for compute, and per-request pricing is the natural model.

- Per-token or per-request pricing maps perfectly to L402's pay-per-call model
- AI agents are the primary consumers — they can auto-pay 402 challenges without human intervention
- No accounts, no API keys, no rate limit tiers — just pay and use
- Enables a marketplace of fine-tuned models, RAG endpoints, and specialized inference
- Example: `golem gateway --upstream http://localhost:11434/api/generate --price 100` to paywall a local Ollama instance

**L402 fit:** Perfect. Stateless, per-request, machine-to-machine. The canonical use case.

**First demo target:** Wrap a local LLM (Ollama, llama.cpp) behind a Golem L402 gateway. Proves the concept with zero external dependencies.

---

## 2. Real-Time Data Feeds

**Why it matters:** Financial data, weather, geolocation, sports scores — anything where freshness has value and stale data is free.

- Market data (crypto prices, order books, trades) — already available via Crypto.com MCP
- Weather and air quality (the current demo uses AQI)
- Geolocation and mapping APIs
- Sports scores and live event data
- IoT sensor data streams

**L402 fit:** Strong. Real-time data is inherently per-request. Consumers want current data, not subscriptions to stale feeds. Pay for freshness.

**Golem angle:** API providers can monetize without Stripe, without accounts, without KYC. Spin up a data feed, add `golem gateway`, start earning sats.

---

## 3. Privacy-Preserving Services

**Why it matters:** L402's pseudonymous payment model is a feature, not a bug. No email, no account, no tracking.

- VPN/proxy endpoints (pay-per-session)
- Email relay and forwarding services
- DNS resolution (encrypted, paid)
- Search APIs that don't track queries
- Document conversion/processing (upload, pay, get result, no account)

**L402 fit:** Excellent. The privacy properties of Bitcoin + L402 (no identity required) align perfectly with privacy-focused services. Users who care about privacy will pay in Bitcoin.

**Golem angle:** Strongest philosophical alignment with self-custodial ethos. Privacy services + self-custodial payments = no third party ever sees who paid for what.

---

## 4. Compute-on-Demand

**Why it matters:** GPU time, rendering, compilation, transcription — bursty compute that doesn't justify a subscription.

- GPU inference (overlaps with #1 but broader — image generation, video processing)
- Code compilation and CI/CD runs
- Audio/video transcription
- PDF processing, OCR, document parsing
- Scientific computation (simulations, data analysis)

**L402 fit:** Good. Per-job pricing is natural. Pay 500 sats to transcribe an audio file. Pay 1000 sats to render a 3D scene. No monthly subscription for occasional use.

**Golem angle:** Particularly strong for AI agents that need occasional compute — an agent can autonomously pay for a GPU job, wait for the result, and continue its workflow.

---

## 5. Specialized Knowledge APIs

**Why it matters:** Expert knowledge behind APIs — legal databases, medical references, academic papers, patent searches.

- Academic paper access (pay-per-paper instead of $30/article)
- Legal case law databases
- Patent search and analysis
- Technical standards documents (ISO, RFC analysis)
- Specialized datasets (genomics, materials science, financial modeling)

**L402 fit:** Good. Micropayments make individual access economically viable where subscriptions don't. A researcher who needs one paper shouldn't pay $200/month for a database subscription.

**Golem angle:** Democratizes access to knowledge. Anyone with sats can query specialized databases. Particularly powerful for AI agents doing research — they can autonomously pay for and access authoritative sources.

---

## Recommendation

**Start with LLM inference for the demo.** It's:
1. Self-contained (Ollama runs locally, no external API dependency)
2. The most compelling narrative (AI agents paying AI agents)
3. A fast-growing developer use case
4. The easiest to price (per-token or per-request)
5. What developers and investors immediately understand

**Second priority: real-time data feeds.** The AQI demo already works. Expanding to crypto price feeds, weather APIs, etc. broadens the story.

**Long-term fit: privacy services.** This is where self-custodial L402 has a strong technical advantage over custodial payment rails: pseudonymous API access with self-custodial payments.

---

## Pricing Intuition

At current Bitcoin prices and Boltz's 500-sat minimum:

| Use Case | Price Range | Sats Equivalent |
|----------|------------|-----------------|
| LLM query (short) | $0.001-0.01 | 1-10 sats |
| LLM query (long/GPT-4 class) | $0.01-0.10 | 10-100 sats |
| Real-time data point | $0.001-0.005 | 1-5 sats |
| Document processing | $0.01-0.50 | 10-500 sats |
| GPU compute (per minute) | $0.10-1.00 | 100-1000 sats |
| Academic paper | $0.50-5.00 | 500-5000 sats |

The Arkade-Boltz gateway's 500-sat minimum makes individual micro-requests challenging via Lightning, but batching (buy 100 requests for 1000 sats) or using Ark OOR (no minimum) solves this. Ark OOR's ~1.2s latency is fast enough for all these use cases.
