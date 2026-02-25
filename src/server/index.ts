// EventSource polyfill — MUST be set before any SDK imports
import { EventSource } from 'eventsource';
(globalThis as any).EventSource = EventSource;

import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { MockSigner } from '../signer/mock-signer.js';
import { GolemWallet } from '../wallet/golem-wallet.js';
import { MUTINYNET_CONFIG } from '../wallet/config.js';
import { OorLimitExceededError } from '../wallet/errors.js';
import { RefreshAgent } from '../agent/refresh-agent.js';
import type { RefreshEvent } from '../agent/refresh-agent.js';
import { EventLog } from './event-log.js';

// --- Startup ---

const signerKey = process.env.GOLEM_SIGNER_KEY;
if (!signerKey) {
  console.error('GOLEM_SIGNER_KEY env var required (hex-encoded 32-byte secret)');
  process.exit(1);
}

const port = parseInt(process.env.PORT || '3000', 10);

console.log('Initializing Golem wallet...');

const signer = MockSigner.fromSecretKey(Buffer.from(signerKey, 'hex'));
const wallet = await GolemWallet.create(signer, { ...MUTINYNET_CONFIG, dataDir: './data' });

const eventLog = new EventLog<RefreshEvent>(100);
const sseClients = new Set<(event: RefreshEvent) => void>();

const agent = new RefreshAgent(wallet, undefined, (event) => {
  eventLog.push(event);
  console.log(`[agent] ${event.type}`, 'timestamp' in event ? event.timestamp : '');
  for (const send of sseClients) {
    send(event);
  }
});

agent.start();
console.log('RefreshAgent started');

// --- App ---

const app = new Hono();

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

app.post('/api/send', async (c) => {
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

app.post('/api/onboard', async (c) => {
  try {
    const txid = await wallet.onboard((event) => {
      console.log(`[onboard] ${event.type}`);
    });
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
    const percentLimit = Math.floor(balance.total * MUTINYNET_CONFIG.oorLimitFraction);
    const oorLimit = Math.max(percentLimit, MUTINYNET_CONFIG.oorLimitMinSats);
    return c.json({
      signerType: signerInfo.type,
      publicKey: Buffer.from(pubkey).toString('hex'),
      oorLimit,
    });
  } catch (err) {
    return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

// Static files (PWA) — serve from src/server/public relative to cwd
app.use('/*', serveStatic({ root: './src/server/public' }));

// --- Start ---

serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
  console.log(`Golem server running on http://0.0.0.0:${port}`);
});
