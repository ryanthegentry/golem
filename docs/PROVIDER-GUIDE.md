# Monetize Any API with Golem

Put a Bitcoin paywall in front of any HTTP endpoint. At the end of this guide, you'll have a paid API listed on [402index.io](https://402index.io), collecting satoshis for every request — no Lightning node required. Works with AI models, data APIs, SaaS tools, or anything that speaks HTTP.

This guide is designed for humans and AI coding agents. Every command is copy-pasteable. Every expected output is shown.

## What You'll Need

- **Node.js 20+** — check: `node --version`
- **An HTTP endpoint** — any service running on a URL (see Step 0 if you don't have one yet)
- **A Bitcoin address** for emergency fund recovery — any BTC address you control (Cash App, Coinbase, River, hardware wallet, etc.)
- **Optional:** a Lightning Address for auto-withdrawals (e.g., `you@getalby.com`, `you@walletofsatoshi.com`)

## Step 0: Expose an HTTP Endpoint

> Skip to [Step 1](#step-1-install-golem) if you already have an API running on a URL (e.g., `http://localhost:3000`).

If you have a service, model, or workflow that isn't HTTP-accessible yet, here are three common patterns.

### Pattern A: Local AI Model (Ollama)

Ollama exposes an OpenAI-compatible API automatically.

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull a model
ollama pull llama3.2

# Start the server (runs on http://localhost:11434)
ollama serve
```

Test it:

```bash
curl http://localhost:11434/api/generate -d '{"model": "llama3.2", "prompt": "hello", "stream": false}'
```

Expected output: a JSON response with a `"response"` field containing model output.

Your upstream URL is `http://localhost:11434`.

### Pattern B: Wrap a Script as an API

Turn any Python or Node.js function into an HTTP endpoint.

**Python (Flask):**

```python
# server.py
from flask import Flask, request, jsonify
app = Flask(__name__)

@app.route("/api/run", methods=["POST"])
def run():
    data = request.json
    # Replace with your actual logic
    result = {"output": f"Processed: {data}"}
    return jsonify(result)

if __name__ == "__main__":
    app.run(port=3000)
```

```bash
pip install flask
python server.py
```

**Node.js (Express):**

```javascript
// server.js
const express = require('express');
const app = express();
app.use(express.json());

app.post('/api/run', (req, res) => {
  // Replace with your actual logic
  res.json({ output: `Processed: ${JSON.stringify(req.body)}` });
});

app.listen(3000, () => console.log('Running on http://localhost:3000'));
```

```bash
npm install express
node server.js
```

Your upstream URL is `http://localhost:3000`.

### Pattern C: Static Data or File Serving

Serve a directory of files over HTTP:

```bash
npx serve ./my-data-directory -l 3000
```

Your upstream URL is `http://localhost:3000`.

---

## Step 1: Install Golem

```bash
git clone https://github.com/ArkLabsHQ/golem.git
cd golem
npm install
```

Verify:

```bash
npm run golem -- --version
```

Expected output:

```
0.1.0
```

## Step 2: Create Your Wallet

### Testnet (recommended first)

```bash
npm run golem -- init
```

Expected output:

```
Wallet initialized successfully!
  Network:  mutinynet
  Ark addr: ark1q...
  Boarding: tb1p...  <-- send BTC here to fund wallet
```

### Mainnet

```bash
npm run golem -- init --encrypt --safe-harbor YOUR_BTC_ADDRESS
```

Replace `YOUR_BTC_ADDRESS` with any Bitcoin address you control (Cash App, Coinbase, River, hardware wallet). This is your emergency recovery address — if anything goes wrong, funds route here.

You'll be prompted for a password. This encrypts your signing key on disk.

Verify the wallet:

```bash
npm run golem -- balance
```

Expected output for a new wallet:

```
  Balance:    0 sats
```

## Step 3: Configure Your Gateway

### Option A: Auto-Discovery (Ollama)

If you're running Ollama locally:

```bash
npm run golem -- gateway init
```

Golem auto-detects Ollama and writes `~/.golem/golem.yaml`.

### Option B: Manual Config (Any Upstream)

```bash
npm run golem -- gateway init \
  --upstream http://localhost:3000 \
  --price 100 \
  --public-url https://your-domain.com \
  --service-name "Your API Name"
```

Expected output:

```
  Upstream:   http://localhost:3000
  Price:      100 sats/request
```

### Option C: Full Control (Edit golem.yaml Directly)

Create or edit `~/.golem/golem.yaml`:

```yaml
gateway:
  # REQUIRED
  upstream: "http://localhost:3000"       # URL of the service Golem proxies to
  price: 100                              # Satoshis charged per request

  # RECOMMENDED
  port: 8402                              # Port the Golem gateway listens on
  description: "My API description"       # Shown in 402 payment challenges
  publicUrl: "https://your-domain.com"    # Internet-accessible URL (required for 402index listing)
  serviceName: "My API"                   # Name shown on 402index.io
  category: "ai/inference"                # Category: ai/inference, data/weather, tools/search, etc.
  contactEmail: "you@example.com"         # Contact for 402index admin
  autoRegister: true                      # Auto-list on 402index.io when gateway starts

  # OPTIONAL — paths that don't require payment
  freePaths:
    - /health
    - /docs

  # OPTIONAL — response caching (resell cached responses at a discount)
  cacheEnabled: true                      # Enable response caching
  cacheDefaultTtl: 3600                   # Cache TTL in seconds (1 hour)
  cachePricePercent: 20                   # Cached responses cost 20% of full price
  cacheMaxSize: 10000                     # Max number of cached entries

  # OPTIONAL — auto-sweep earnings to Lightning
  sweep:
    enabled: true                         # Turn on auto-sweep
    address: "you@walletofsatoshi.com"    # Lightning Address, LNURL, or bolt11 invoice
    threshold: 100000                     # Sweep when balance exceeds 100,000 sats
    keep: 10000                           # Keep 10,000 sats in wallet after sweep
    minSweep: 5000                        # Don't sweep less than 5,000 sats
```

### Key Fields Explained

| Field | What It Does |
|-------|-------------|
| `upstream` | The URL of your actual service. Golem sits in front of it and charges for access. |
| `price` | Satoshis charged per request. 1 sat ≈ $0.001 at current prices. Start low (10–100 sats). |
| `publicUrl` | The internet-accessible URL of your **gateway** (not your upstream). 402index.io uses this to verify your endpoint. |
| `sweep.address` | Where to send earnings. Lightning Address (`you@domain.com`) recommended — reusable and doesn't expire. |
| `freePaths` | URL paths that bypass payment (e.g., health checks, docs). |

## Step 4: Test Locally

Start the gateway:

```bash
npm run golem -- gateway
```

Expected output:

```
  URL:        http://0.0.0.0:8402
  Upstream:   http://localhost:3000
  Price:      100 sats/request
  Free paths: /health, /docs
  Network:    mutinynet
  Lightning:  enabled (Boltz reverse swap, invoice generated per-request)
  Sweep:      enabled → you@walletofsatoshi.com at 100,000 sats
```

In another terminal, test the payment challenge:

```bash
curl -si http://localhost:8402/api/run
```

Expected: HTTP 402 with payment headers:

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."
```

If you see this, your gateway is working. Clients pay the Lightning invoice, then re-send the request with payment proof to reach your upstream.

Test a free path:

```bash
curl -si http://localhost:8402/health
```

Expected: HTTP 200.

## Step 5: Deploy

### Railway (Recommended)

1. Fork or push the golem repo to your GitHub account
2. Create a new Railway project → **Deploy from GitHub repo**
3. Connect your repo
4. Add a persistent volume — mount path: `/app/data` (stores wallet and swap state)
5. Set environment variables:
   - `GOLEM_NETWORK=mainnet`
   - `GOLEM_PASSWORD=your-wallet-password` (from Step 2)
   - `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30` (allows graceful shutdown during deploys)
   - `TELEGRAM_BOT_TOKEN=your-bot-token` (optional, for monitoring — see Step 7)
   - `TELEGRAM_CHAT_ID=your-chat-id` (optional, for monitoring — see Step 7)
6. Deploy. Railway auto-detects the Dockerfile.
7. Copy the Railway-provided URL → set it as `publicUrl` in your `golem.yaml`
8. Redeploy so the gateway picks up the `publicUrl` and registers with 402index

### VPS / Docker

```bash
docker build -t golem .
docker run -d \
  --name golem-gateway \
  -e GOLEM_NETWORK=mainnet \
  -e GOLEM_PASSWORD=your-wallet-password \
  -v golem-data:/app/data \
  -p 8402:8402 \
  golem
```

Point your reverse proxy (nginx, Caddy, etc.) to port 8402 and set `publicUrl` in `golem.yaml` to the public-facing URL.

### Running Alongside an Existing Service

If your API is already deployed:

1. Golem gateway listens on port 8402 by default
2. Set `upstream` to your API's internal URL (e.g., `http://localhost:3000`)
3. Expose port 8402 to the internet
4. Set `publicUrl` to the internet-facing URL of port 8402

## Step 6: Verify on 402index.io

After deploying with `autoRegister: true`, check your gateway logs for:

```
  402index:   registered (id: abc123)
```

or:

```
  402index:   already registered
```

Visit [402index.io](https://402index.io) — your endpoint should appear. Health checks run every 15 minutes; your endpoint will show as healthy within an hour.

Verify manually:

```bash
curl -si https://your-public-url/
```

Expected: HTTP 402 with `WWW-Authenticate: L402 macaroon="...", invoice="lnbc..."`.

## Step 7: Monitor with Telegram (Optional)

1. Message **@BotFather** on Telegram → `/newbot` → follow prompts → copy the bot token
2. Message **@userinfobot** on Telegram → it replies with your numeric chat ID
3. Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` in your environment
4. Restart the gateway

Bot commands:

| Command | What It Shows |
|---------|--------------|
| `/status` | Wallet balance, network, agent state |
| `/txs` | Recent transactions |
| `/gateway` | Payment stats (total sats earned, request count) |
| `/health` | System health check |

You'll receive real-time notifications for L402 payments and auto-sweep events.

## Step 8: Auto-Sweep Earnings to Lightning (Optional)

Auto-sweep withdraws your earnings to a Lightning Address when your wallet balance exceeds a threshold. This keeps funds flowing to your preferred wallet without manual intervention.

Add to your `golem.yaml` (or set during `gateway init` with `--sweep-address` and `--sweep-threshold`):

```yaml
gateway:
  # ... your existing config ...
  sweep:
    enabled: true
    address: "you@walletofsatoshi.com"    # Your Lightning Address
    threshold: 100000                      # Sweep when balance > 100,000 sats
    keep: 10000                            # Keep 10,000 sats for operational liquidity
    minSweep: 5000                         # Don't sweep amounts less than 5,000 sats
```

How it works:

- Every 60 seconds, Golem checks your wallet balance
- If balance exceeds `threshold`, it sweeps `balance - keep` to your Lightning Address
- After a successful sweep, there's a 10-minute cooldown before the next one
- If 3 sweeps fail in a row, sweep pauses for 1 hour (circuit breaker)
- On gateway shutdown (deploy, restart), any in-progress sweep completes before exit

Supported destination formats:

| Format | Example | Reusable? |
|--------|---------|-----------|
| Lightning Address (recommended) | `you@walletofsatoshi.com` | Yes |
| LNURL-pay URL | `https://lnurl.service.com/pay/...` | Yes |
| Bolt11 invoice | `lnbc...` | No — single-use, sweep disables after one payment |

After adding sweep config, restart the gateway. The startup output will include:

```
  Sweep:      enabled → you@walletofsatoshi.com at 100,000 sats
```

## Troubleshooting

### "Port 8402 already in use"

Another process is using that port. Either stop it or use a different port by adding `port: 8403` to your `golem.yaml`.

### 402index registration failed

Your `publicUrl` must be reachable from the public internet and return a 402 response. Test it:

```bash
curl -si https://your-public-url/
```

If this doesn't return HTTP 402, fix your DNS, firewall, or reverse proxy before retrying.

### "No safe harbor address configured"

Mainnet requires a safe harbor address. Set one:

```bash
npm run golem -- safe-harbor --set YOUR_BTC_ADDRESS
```

### Gateway starts but upstream returns errors

Golem proxies requests to your upstream after payment. If your upstream is down, the error passes through. Test your upstream independently:

```bash
curl http://localhost:3000/your-path
```

### Balance shows 0 after payments

Payments settle via Boltz swaps, which take a few seconds. Check balance again after 10–30 seconds. If still 0, check gateway logs for Boltz errors.

### "GOLEM_PASSWORD required"

Mainnet wallets are encrypted. Set the `GOLEM_PASSWORD` environment variable to the password you chose during `golem init --encrypt`.

### Auto-sweep not triggering

- Verify `sweep.enabled: true` in `golem.yaml`
- Check that your balance exceeds `threshold`
- Check that `threshold` > `keep` (otherwise sweep amount would be zero or negative)
- Check gateway logs for `[sweep]` entries — they include skip reasons
- If using a bolt11 invoice, check if it was already consumed (bolt11 is single-use)

### "Sweep: disabled — [error]"

Config validation failed at startup. Common causes: invalid Lightning Address format, `threshold` ≤ `keep`, or `threshold`/`minSweep` ≤ 0.

## How L402 Works (For the Curious)

When a client hits your gateway without a payment token:

1. Gateway returns **HTTP 402** with a macaroon (access token) and a Lightning invoice
2. Client pays the invoice (via any Lightning wallet or programmatically via a Golem agent)
3. Client re-sends the request with `Authorization: L402 macaroon:preimage`
4. Gateway verifies the payment proof, proxies the request to your upstream, returns the response

Your upstream never sees any of this — it receives normal HTTP requests. The gateway handles all payment logic.

## Getting Help

- **GitHub Issues:** [github.com/ArkLabsHQ/golem/issues](https://github.com/ArkLabsHQ/golem/issues)
- **402index.io:** [402index.io](https://402index.io)
