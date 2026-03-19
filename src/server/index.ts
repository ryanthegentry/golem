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
import type { RefreshEvent } from '../agent/refresh-agent.js';
import { EventLog } from './event-log.js';
import { resolveServerSigner } from '../signer/resolve-signer.js';
import { validateBearerToken } from '../auth/safe-compare.js';
import { secureHeaders } from 'hono/secure-headers';
import { createInternalApi } from '../l402/internal-api.js';
import { FileRootKeyStore } from '../l402/macaroon.js';
import { MacaroonStore } from '../l402/macaroon-store.js';
import { createLightning } from '../lightning/index.js';
import { initWalletWithRetry } from './init-retry.js';

// --- Startup ---

const port = parseInt(process.env.PORT || '3000', 10);

console.log('Initializing Golem wallet...');

const signer = await resolveServerSigner().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});

const netConfig = getNetworkConfig();
const walletConfig = walletConfigFromNetwork(netConfig, './data');
const wallet = await initWalletWithRetry(
  () => GolemWallet.create(signer, walletConfig),
).catch((err) => {
  console.error(`Wallet init failed after retries: ${(err as Error).message}`);
  process.exit(1);
});

const eventLog = new EventLog<RefreshEvent>(100);
const sseClients = new Set<(event: RefreshEvent) => void>();

const agent = new RefreshAgent(wallet, { ...DEFAULT_REFRESH_CONFIG, esploraUrl: netConfig.mempoolUrl }, (event) => {
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

const l402DataDir = process.env.GOLEM_L402_DATA_DIR || './data-l402';
const rootKeyStore = new FileRootKeyStore(l402DataDir);
const macaroonStore = new MacaroonStore(`${l402DataDir}/macaroons.db`);

let lightning: Awaited<ReturnType<typeof createLightning>> | null = null;
try {
  lightning = await createLightning(wallet.sdkWallet, netConfig, l402DataDir);
  console.log('Lightning (SwapManager) started for L402');
} catch (err) {
  console.warn('Lightning init failed — L402 challenge/verify will be unavailable:', err instanceof Error ? err.message : err);
}

// Hourly cleanup of expired root keys and macaroons
const cleanupInterval = setInterval(() => {
  rootKeyStore.cleanup();
  macaroonStore.cleanup();
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
    const percentLimit = Math.floor(balance.total * walletConfig.oorLimitFraction);
    const oorLimit = Math.max(percentLimit, walletConfig.oorLimitMinSats);
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
    process.exit(0);
  });
}
