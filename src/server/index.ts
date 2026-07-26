// EventSource polyfill — MUST be set before any SDK imports
import '../polyfills.js';

// Long-running daemon — transient upstream errors must not kill the process
import { installProcessGuard } from '../resilience/process-guard.js';
const processGuard = installProcessGuard();

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { GolemWallet } from '../wallet/golem-wallet.js';
import { walletConfigFromNetwork } from '../wallet/config.js';
import { getNetworkConfig } from '../config/networks.js';
import { OorLimitExceededError } from '../wallet/errors.js';
import { RefreshAgent, DEFAULT_REFRESH_CONFIG } from '../agent/refresh-agent.js';
import { resolveRefreshSafetyMarginMs, DEFAULT_SAFETY_MARGIN_MS } from '../agent/refresh-config.js';
import { oorLimitFor } from '../wallet/spendable-balance.js';
import type { RefreshEvent } from '../agent/refresh-agent.js';
import { EventLog } from './event-log.js';
import { resolveServerSigner } from '../signer/resolve-signer.js';
import { validateBearerToken } from '../auth/safe-compare.js';
import { secureHeaders } from 'hono/secure-headers';
import { createInternalApi } from '../l402/internal-api.js';
import { FileRootKeyStore } from '../l402/macaroon.js';
import { MacaroonStore } from '../l402/macaroon-store.js';
import { createLightning, ensureSwapManagerHealthy, getPollMonitor, runSwapCleanup } from '../lightning/index.js';
import { initWalletWithRetry } from './init-retry.js';
import { resolveWalletDataDir, resolveL402DataDir } from './data-dir.js';
import { checkDataDirDurability, formatDurabilityLog } from './data-durability.js';

// --- Startup ---

const port = parseInt(process.env.PORT || '3000', 10);

console.log('Initializing Golem wallet...');

const signer = await resolveServerSigner().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});

const netConfig = getNetworkConfig();

// Wallet state goes on the mounted volume, not the container overlay. Until 2026-07-25 this
// was a literal './data' — /app/data inside the container — and every deploy destroyed
// ark-sdk.db with it: the contract repository, the transaction history, and the pre-signed
// tx-tree data unilateral exit depends on. The wallet then came back reporting a zero
// balance with the coins untouched at the ASP.
const l402DataDir = resolveL402DataDir();
const walletDataDir = resolveWalletDataDir();

// Checked before the wallet opens its database, so an operator sees the warning ahead of any
// write. Reports and continues — a gateway that refuses to boot serves no 402 challenges,
// which is worse than one that serves them while shouting about its storage.
const durability = checkDataDirDurability(walletDataDir);
formatDurabilityLog(durability);

const walletConfig = walletConfigFromNetwork(netConfig, walletDataDir);
const wallet = await initWalletWithRetry(
  () => GolemWallet.create(signer, walletConfig),
).catch((err) => {
  console.error(`Wallet init failed after retries: ${(err as Error).message}`);
  process.exit(1);
});

const eventLog = new EventLog<RefreshEvent>(100);
const sseClients = new Set<(event: RefreshEvent) => void>();

// The safety margin is overridable so an operator can make the agent act on a VTXO that is
// outside the steady-state 3-day window — the shape of the 2026-07-26 recovery, where the
// alternative was hand-rolling a settle against mainnet funds. Bounded in resolveRefresh…().
const refreshSafetyMarginMs = resolveRefreshSafetyMarginMs();
if (refreshSafetyMarginMs !== DEFAULT_SAFETY_MARGIN_MS) {
  console.warn(
    `[refresh] safety margin overridden to ${refreshSafetyMarginMs}ms ` +
      `(${(refreshSafetyMarginMs / 3600_000).toFixed(1)}h) via GOLEM_REFRESH_SAFETY_MARGIN_MS`,
  );
}

const agent = new RefreshAgent(wallet, { ...DEFAULT_REFRESH_CONFIG, safetyMarginMs: refreshSafetyMarginMs, esploraUrl: netConfig.mempoolUrl }, (event) => {
  eventLog.push(event);
  for (const send of sseClients) {
    send(event);
  }
});

agent.start();
console.log('RefreshAgent started');

// --- API Key ---

const apiKey = process.env.GOLEM_API_KEY;

// --- L402 Internal API ---

const rootKeyStore = new FileRootKeyStore(l402DataDir);
const macaroonStore = new MacaroonStore(`${l402DataDir}/macaroons.db`);

let lightning: Awaited<ReturnType<typeof createLightning>> | null = null;
try {
  lightning = await createLightning(wallet.sdkWallet, netConfig, l402DataDir);
  // Verify the manager is genuinely bound before declaring it started. The SDK's own guard
  // reports success whenever the instance exists, which is how a process can sit "running"
  // for two days against a dead subscription (golem#2).
  const report = await ensureSwapManagerHealthy(lightning, { allowRebind: false });
  console.log(
    `Lightning (SwapManager) started for L402 — init=${report.action} ` +
      `ws_connected=${report.stats?.websocketConnected ?? 'unknown'} ` +
      `monitored_swaps=${report.stats?.monitoredSwaps ?? 0}`,
  );
} catch (err) {
  console.warn('Lightning init failed — L402 challenge/verify will be unavailable:', err instanceof Error ? err.message : err);
}

// Hourly cleanup of expired root keys, macaroons, and swap records.
//
// Swap cleanup used to run only inside createLightning, i.e. once per process. Production
// reached 58 days of uptime and 533 pending swap rows, and the fan-out over that set is what
// provoked the Boltz rate limiting behind golem#2 — which is why a redeploy was always the
// fix. On the interval it never accumulates (RC3).
const cleanupInterval = setInterval(() => {
  rootKeyStore.cleanup();
  macaroonStore.cleanup();
  runSwapCleanup();
}, 3600_000);

const l402Api = lightning
  ? createInternalApi({
      lightning,
      wallet,
      rootKeyStore,
      macaroonStore,
      networkConfig: netConfig,
      startTime: Date.now(),
      refreshAgentRunning: () => agent.isRunning,
      apiKey,
      pollMonitor: getPollMonitor,
      durability: () => durability,
    })
  : null;

// --- App ---

const app = new Hono();

// Security headers on all responses
app.use('*', secureHeaders());

// Free: health check (no auth required — used by Railway health checks and UptimeRobot)
app.get('/health', (c) => c.json({ status: 'ok', uptime: process.uptime() }));

// Auth middleware — require GOLEM_API_KEY for ALL /api routes (fail-closed)
app.use('/api/*', async (c, next) => {
  if (!apiKey) {
    return c.json({ error: 'GOLEM_API_KEY required. Set env var to enable API.' }, 403);
  }
  if (!validateBearerToken(c.req.header('Authorization'), apiKey)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
});

// API routes

app.get('/api/balance', async (c) => {
  try {
    const balance = await wallet.getBalance();
    return c.json(balance);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/address', async (c) => {
  try {
    const [ark, boarding] = await Promise.all([
      wallet.getAddress(),
      wallet.getBoardingAddress(),
    ]);
    return c.json({ ark, boarding });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/transactions', async (c) => {
  try {
    const txs = await wallet.getTransactionHistory();
    return c.json(txs);
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Rate limiters
const sendRateLimit = { timestamps: [] as number[], max: 10, windowMs: 60_000 };
const receiveRateLimit = { timestamps: [] as number[], max: 3, windowMs: 60_000 };

app.post('/api/send', async (c) => {
  // Rate limit check
  const now = Date.now();
  sendRateLimit.timestamps = sendRateLimit.timestamps.filter(t => now - t < sendRateLimit.windowMs);
  if (sendRateLimit.timestamps.length >= sendRateLimit.max) {
    return c.json({ error: 'Rate limit exceeded: max 10 sends per minute' }, 429);
  }
  sendRateLimit.timestamps.push(now);

  try {
    const body = await c.req.json<{ address: string; amount: number }>();
    if (!body.address || !body.amount) {
      return c.json({ error: 'address and amount required' }, 400);
    }
    const txid = await wallet.sendBitcoin({
      address: body.address,
      amount: body.amount,
    });
    return c.json({ txid });
  } catch (err) {
    if (err instanceof OorLimitExceededError) {
      return c.json({
        error: err.message,
        requestedSats: err.requestedSats,
        limitSats: err.limitSats,
        totalBalance: err.totalBalance,
      }, 400);
    }
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post('/api/receive', async (c) => {
  if (!lightning) {
    return c.json({ error: 'Lightning unavailable — swap manager failed to start' }, 503);
  }

  // Rate limit check
  const now = Date.now();
  receiveRateLimit.timestamps = receiveRateLimit.timestamps.filter(t => now - t < receiveRateLimit.windowMs);
  if (receiveRateLimit.timestamps.length >= receiveRateLimit.max) {
    return c.json({ error: 'Rate limit exceeded: max 3 receives per minute' }, 429);
  }
  receiveRateLimit.timestamps.push(now);

  try {
    const body = await c.req.json<{ amount: number }>();
    if (!body.amount || typeof body.amount !== 'number' || !Number.isInteger(body.amount) || body.amount <= 0) {
      return c.json({ error: 'amount must be a positive integer (sats)' }, 400);
    }

    const result = await lightning.createLightningInvoice({ amount: body.amount });
    // Return invoice immediately — SwapManager (enableAutoActions) claims automatically
    return c.json({
      invoice: result.invoice,
      amount: result.amount,
      swapId: result.pendingSwap.id,
      expiry: result.expiry,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.post('/api/onboard', async (c) => {
  try {
    const txid = await wallet.onboard();
    return c.json({ txid });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/agent/status', (c) => {
  return c.json({
    running: agent.isRunning,
    lastEvent: eventLog.getLast() ?? null,
    eventLog: eventLog.getAll(),
  });
});

app.get('/api/agent/events', (c) => {
  return streamSSE(c, async (stream) => {
    const send = (event: RefreshEvent) => {
      stream.writeSSE({
        data: JSON.stringify(event),
        event: event.type,
      }).catch(() => {
        // Stream closed — cleanup happens in onAbort
      });
    };

    sseClients.add(send);
    stream.onAbort(() => {
      sseClients.delete(send);
    });

    // Keep stream alive until client disconnects
    while (true) {
      await new Promise((r) => setTimeout(r, 30_000));
      // Send keepalive comment
      await stream.writeSSE({ data: '', event: 'keepalive' }).catch(() => {});
    }
  });
});

app.get('/api/info', async (c) => {
  try {
    const [signerInfo, pubkey, balance] = await Promise.all([
      wallet.getSignerInfo(),
      wallet.getPublicKey(),
      wallet.getBalance(),
    ]);
    // Sized from spendable funds, not `total`. Since sdk 0.4.51 `total` also carries
    // `pendingRecovery` and `recoverable`, neither of which can be spent — sizing a spend
    // control from them inflates it in the unsafe direction.
    const oorLimit = oorLimitFor(balance, walletConfig);
    return c.json({
      signerType: signerInfo.type,
      publicKey: Buffer.from(pubkey).toString('hex'),
      oorLimit,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// L402 internal API routes — mounted alongside wallet dashboard
if (l402Api) {
  app.route('/', l402Api);
  console.log('L402 internal API mounted at /l402/*');
} else {
  app.all('/l402/*', (c) => c.json({ error: 'L402 service unavailable — Lightning init failed' }, 503));
}

// Static files (PWA) — serve from src/server/public relative to cwd
app.use('/*', serveStatic({ root: './src/server/public' }));

// --- Start ---

// Secure default: bind to 127.0.0.1 when no API key (local-only access)
const hostname = process.env.GOLEM_HOST || (apiKey ? '0.0.0.0' : '127.0.0.1');
serve({ fetch: app.fetch, port, hostname }, () => {
  console.log(`Golem server running on http://${hostname}:${port}`);
  if (!apiKey) {
    console.warn('WARNING: No GOLEM_API_KEY set — bound to 127.0.0.1 (local only). All /api/* endpoints blocked.');
    console.warn('         Set GOLEM_API_KEY env var to enable remote access and API endpoints.');
  }
});

// Graceful shutdown: zero signer key material on exit
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`Received ${signal} — zeroing signer key and shutting down`);
    signer.dispose();
    processGuard.dispose();
    clearInterval(cleanupInterval);
    getPollMonitor()?.stop();
    process.exit(0);
  });
}
