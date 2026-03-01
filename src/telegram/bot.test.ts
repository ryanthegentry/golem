import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TelegramBot } from './bot.js';
import type { BotConfig, BotContext } from './types.js';
import { EventLog } from '../server/event-log.js';

function createMockContext(): BotContext {
  return {
    wallet: {
      getBalance: vi.fn().mockResolvedValue({ total: 10000, available: 8000, settled: 8000, preconfirmed: 2000, boarding: 0 }),
      getVtxos: vi.fn().mockResolvedValue([]),
      getTransactionHistory: vi.fn().mockResolvedValue([]),
      getAddress: vi.fn().mockResolvedValue('tark1...'),
    },
    getAgentStatus: () => ({ running: true }),
    getGatewayStats: null,
    getEventLog: () => new EventLog(),
    networkConfig: { golemNetwork: 'mutinynet' } as any,
  };
}

function createConfig(overrides?: Partial<BotConfig>): BotConfig {
  return {
    botToken: 'test-token',
    chatId: '12345',
    rateLimitMs: 0, // no rate limit in tests
    ...overrides,
  };
}

/**
 * Build a mock fetch that returns canned getUpdates responses in sequence,
 * then blocks forever (simulating a long-poll with no new updates).
 */
function mockGetUpdates(...batches: Array<Array<{ update_id: number; message?: unknown }>>) {
  let call = 0;
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
    // sendMessage calls — just return ok
    if (urlStr.includes('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true }));
    }
    // getUpdates calls — return next batch, then block
    if (call < batches.length) {
      const result = batches[call++];
      return new Response(JSON.stringify({ ok: true, result }));
    }
    // Block until aborted
    return new Promise<Response>((_, reject) => {
      const signal = init?.signal as AbortSignal | undefined;
      if (signal?.aborted) { reject(new Error('aborted')); return; }
      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });
  });
}

/** Wait for async work to settle. */
const tick = (ms = 100) => new Promise(r => setTimeout(r, ms));

describe('TelegramBot', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('creates without error', () => {
    const bot = new TelegramBot(createConfig(), createMockContext());
    expect(bot).toBeDefined();
  });

  it('stop is safe to call before start', () => {
    const bot = new TelegramBot(createConfig(), createMockContext());
    expect(() => bot.stop()).not.toThrow();
  });

  it('start is idempotent', () => {
    const bot = new TelegramBot(createConfig(), createMockContext());
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('aborted'));
    bot.start();
    bot.start(); // second call should be no-op
    bot.stop();
  });

  it('drains stale updates on startup without processing them', async () => {
    const staleUpdate = { update_id: 500, message: { text: '/status', chat: { id: 12345 } } };
    const fetchSpy = mockGetUpdates(
      [staleUpdate],  // drain call (offset: -1) returns stale update
      [],             // confirmation call (offset: 501) returns empty
    );

    const ctx = createMockContext();
    const bot = new TelegramBot(createConfig(), ctx);
    bot.start();
    await tick();
    bot.stop();

    // Find the getUpdates calls (not sendMessage)
    const getUpdatesCalls = fetchSpy.mock.calls.filter((c: any[]) => {
      const u = typeof c[0] === 'string' ? c[0] : '';
      return u.includes('/getUpdates');
    });

    expect(getUpdatesCalls.length).toBeGreaterThanOrEqual(2);

    // First getUpdates should pass offset: -1
    const firstBody = JSON.parse(getUpdatesCalls[0][1]?.body as string);
    expect(firstBody.offset).toBe(-1);

    // Second getUpdates should pass offset: 501 (confirming the drain)
    const secondBody = JSON.parse(getUpdatesCalls[1][1]?.body as string);
    expect(secondBody.offset).toBe(501);

    // Wallet methods should NOT have been called (stale update not processed)
    expect(ctx.wallet.getBalance).not.toHaveBeenCalled();
  });

  it('does not reprocess duplicate update_ids', async () => {
    const update = { update_id: 100, message: { text: '/status', chat: { id: 12345 } } };
    const fetchSpy = mockGetUpdates(
      [],                     // drain returns empty (no stale)
      [update, update],       // same update delivered twice in one batch
    );

    const ctx = createMockContext();
    const bot = new TelegramBot(createConfig(), ctx);
    bot.start();
    await tick();
    bot.stop();

    // getBalance should be called exactly once (second duplicate skipped)
    expect(ctx.wallet.getBalance).toHaveBeenCalledTimes(1);
  });

  it('advances offset past processed updates', async () => {
    const fetchSpy = mockGetUpdates(
      [],  // drain
      [{ update_id: 200, message: { text: '/help', chat: { id: 12345 } } }],
    );

    const bot = new TelegramBot(createConfig(), createMockContext());
    bot.start();
    await tick();
    bot.stop();

    // After processing update 200, the next getUpdates should use offset 201
    const getUpdatesCalls = fetchSpy.mock.calls.filter((c: any[]) => {
      const u = typeof c[0] === 'string' ? c[0] : '';
      return u.includes('/getUpdates');
    });

    const offsets = getUpdatesCalls.map((c: any[]) => JSON.parse(c[1]?.body as string).offset);
    expect(offsets).toContain(201);
  });

  it('notifyPayment formats message correctly', async () => {
    const bot = new TelegramBot(createConfig(), createMockContext());
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}'));

    await bot.notifyPayment('lightning', 500, 'abc123def456789');

    expect(fetchSpy).toHaveBeenCalledOnce();
    const call = fetchSpy.mock.calls[0];
    const body = JSON.parse(call[1]?.body as string);
    expect(body.chat_id).toBe('12345');
    expect(body.text).toContain('Payment Received');
    expect(body.text).toContain('500');
    expect(body.text).toContain('abc123def456');
    expect(body.parse_mode).toBe('MarkdownV2');
  });

  it('notifyPayment handles Ark rail', async () => {
    const bot = new TelegramBot(createConfig(), createMockContext());
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ok":true}'));

    await bot.notifyPayment('ark', 1000, 'deadbeef12345678');

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.text).toContain('Ark OOR');
  });

  it('notifyPayment does not throw on send failure', async () => {
    const bot = new TelegramBot(createConfig(), createMockContext());
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network error'));

    await expect(bot.notifyPayment('lightning', 100, 'hash')).resolves.not.toThrow();
  });

  it('silently ignores messages from unauthorized chat IDs', async () => {
    const fetchSpy = mockGetUpdates(
      [],  // drain
      [{ update_id: 300, message: { text: '/status', chat: { id: 99999 } } }],  // wrong chat ID
    );

    const ctx = createMockContext();
    const bot = new TelegramBot(createConfig(), ctx);
    bot.start();
    await tick();
    bot.stop();

    // Wallet should not be queried for unauthorized chat
    expect(ctx.wallet.getBalance).not.toHaveBeenCalled();

    // No sendMessage call (only getUpdates calls)
    const sendCalls = fetchSpy.mock.calls.filter((c: any[]) => {
      const u = typeof c[0] === 'string' ? c[0] : '';
      return u.includes('/sendMessage');
    });
    expect(sendCalls).toHaveLength(0);
  });

  it('setLastAlertTime stores the value', () => {
    const bot = new TelegramBot(createConfig(), createMockContext());
    bot.setLastAlertTime('2026-02-28T12:00:00Z');
    expect(() => bot.setLastAlertTime(null)).not.toThrow();
  });
});
