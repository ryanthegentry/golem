# Mainnet Smoke Test Procedure

**DO NOT automate this.** Each step involves real bitcoin.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GOLEM_NETWORK` | Yes (mainnet) | `mutinynet` | Network to connect to: `mainnet`, `mutinynet`, or `regtest`. Controls ASP URL, Boltz API URL, mempool URL, and all address validation. |
| `GOLEM_PASSWORD` | Yes (mainnet) | — | Encryption password for the ServerSigner key file. On mainnet, `golem init --encrypt` is enforced — init will reject a missing password. |
| `GOLEM_SIGNER_KEY` | No | — | Hex-encoded private key for development/testnet. **Rejected on mainnet** — `golem init` will refuse to start if this is set with `GOLEM_NETWORK=mainnet`. |
| `TELEGRAM_BOT_TOKEN` | No | — | Telegram bot token (from BotFather) for VTXO expiry and balance alerts. Without this, alerts go to console only. |
| `TELEGRAM_CHAT_ID` | No | — | Telegram chat ID for alert delivery. Required alongside `TELEGRAM_BOT_TOKEN`. |
| `VOLTAGE_MACAROON` | No | — | Base64-encoded LND macaroon for Voltage node (used by `golem pay` Lightning path). Not needed for Ark-native payments or `golem serve`. |
| `PORT` | No | `8402` | Port for `golem serve` (internal L402 API). Railway sets this automatically. |
| `HOST` | No | `127.0.0.1` | Bind address for `golem serve`. Use `0.0.0.0` in containers (Railway). Defaults to localhost for security. |

### Network config resolution

`GOLEM_NETWORK` selects from the centralized network config map in `src/config/networks.ts`:

| Network | ASP URL | Boltz API URL | VTXO Expiry | Encryption Required |
|---------|---------|---------------|-------------|---------------------|
| `mainnet` | `https://arkade.computer` | `https://api.ark.boltz.exchange` | ~7 days (605184s) | Yes |
| `mutinynet` | `https://mutinynet.arkade.computer` | `https://api.mutinynet.boltz.exchange` | ~4 weeks | No |
| `regtest` | `http://localhost:7070` | `http://localhost:9001` | ~4 weeks | No |

### Mainnet enforcement rules

When `GOLEM_NETWORK=mainnet`:
- `golem init` requires `--encrypt` and `GOLEM_PASSWORD`
- `golem init` requires `--safe-harbor <bc1-address>`
- `golem init` rejects `GOLEM_SIGNER_KEY` (no plaintext keys on mainnet)
- Address validation requires `bc1` prefix (rejects `tb1`, `bcrt1`, `tark1`)

## Prerequisites

- Telegram bot created (BotFather), `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` set
- 50,000 sats available in a Lightning wallet (Phoenix, Zeus, etc.)
- A hardware wallet bc1 address for safe harbor

## Steps

### 1. Initialize mainnet wallet

```bash
GOLEM_NETWORK=mainnet GOLEM_PASSWORD=<strong-password> golem init --encrypt --safe-harbor <your-hardware-wallet-bc1-address>
```

Expected: Creates wallet, shows boarding address (`bc1p...`).

### 2. Verify safe harbor

```bash
golem safe-harbor
```

Expected: Shows the bc1 address you provided.

### 3. Fund the wallet

Send 50,000 sats to the boarding address from your on-chain wallet. Wait for 1 confirmation + round inclusion (~1-2 minutes after confirmation).

### 4. Check balance

```bash
golem balance
```

Expected: ~50,000 sats (minus boarding fee of ~200 sats + dust).

### 5. Verify VTXO expiry

```bash
golem balance --verbose
```

Expected: VTXO expiry is ~7 days from now (NOT 4 weeks). The mainnet ASP (`arkade.computer`) uses `unilateralExitDelay: 605184` seconds = 7.0 days.

### 6. Test Lightning receive

From Phoenix, pay 1,000 sats to a Boltz reverse swap invoice:

```bash
GOLEM_NETWORK=mainnet golem gateway --upstream http://httpbin.org --price 500 --port 8402
```

Then from another terminal:

```bash
curl -s http://localhost:8402/get
```

This should return a 402 with an invoice. Pay it from Phoenix.

### 7. Test OOR send

```bash
golem pay <another-ark-address> 500
```

Expected: OOR payment completes.

### 8. Verify RefreshAgent

Check server logs for VTXO detection and correct expiry reporting. The RefreshAgent should report VTXO expiry of ~7 days, with alert thresholds at 48h (CRITICAL) and 72h (WARNING).

### 9. Backup encrypted config

```bash
cp ~/.golem/config.json ~/golem-mainnet-backup.json
```

Store this file securely. It's AES-256 encrypted but backup is belt-and-suspenders.

### 10. Verify Telegram alerts

Temporarily set alert threshold to 1 hour, confirm message arrives. Then reset to production thresholds.

## Rollback

If anything goes wrong:

```bash
golem exit
```

This triggers emergency exit to the safe harbor address (cooperative offboard if ASP is online, unilateral unroll otherwise).
