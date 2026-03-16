/**
 * Telegram dashboard bot — interactive read-only wallet dashboard.
 *
 * Long-polls getUpdates (no webhook needed). Chat ID allowlist for security.
 * 1 msg/sec rate limit to stay within Telegram API limits.
 */

import type { BotConfig, BotContext, CommandResult } from './types.js';
import { formatHelp, escapeMarkdownV2 } from './formatter.js';
import { handleStatus } from './commands/status.js';
import { handleTxs } from './commands/txs.js';
import { handleVtxos } from './commands/vtxos.js';
import { handleHealth } from './commands/health.js';
import { handleGateway } from './commands/gateway.js';

const TELEGRAM_API = 'https://api.telegram.org';
const POLL_TIMEOUT = 30; // seconds — Telegram long-poll timeout

export class TelegramBot {
  private readonly config: BotConfig;
  private readonly ctx: BotContext;
  private readonly rateLimitMs: number;
  private abortController: AbortController | null = null;
  private running = false;
  private lastSendTime = 0;
  private offset: number | undefined;
  private readonly processedIds = new Set<number>();
  private lastAlertTime: string | null = null;

  constructor(config: BotConfig, ctx: BotContext) {
    this.config = config;
    this.ctx = ctx;
    this.rateLimitMs = config.rateLimitMs ?? 1000;
  }

  /** Start long-polling loop. */
  start(): void {
    if (this.running) return; // already running
    this.running = true;
    this.abortController = new AbortController();
    console.log('[telegram] Bot started — listening for commands');
    void this.drainAndPoll();
  }

  /** Stop polling and clean up. */
  stop(): void {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      console.log('[telegram] Bot stopped');
    }
  }

  /** Set last alert time (called from AlertManager wiring). */
  setLastAlertTime(time: string | null): void {
    this.lastAlertTime = time;
  }

  /** Push auto-sweep success notification to the chat. */
  async notifySweep(amountSats: number, destination: string): Promise<void> {
    const text = `*Auto\\-Sweep*\n\nSent: \`${amountSats.toLocaleString()}\` sats\nTo: \`${escapeMarkdownV2(destination)}\``;
    await this.sendMessage(text, 'MarkdownV2');
  }

  /** Push auto-sweep failure notification to the chat. */
  async notifySweepError(error: string): Promise<void> {
    const text = `*Auto\\-Sweep Failed*\n\n${escapeMarkdownV2(error)}`;
    await this.sendMessage(text, 'MarkdownV2');
  }

  /** Push payment notification to the chat. */
  async notifyPayment(rail: 'lightning' | 'ark', sats: number, paymentHash: string): Promise<void> {
    const railLabel = rail === 'lightning' ? 'Lightning' : 'Ark OOR';
    const shortHash = paymentHash.slice(0, 12);
    const text = `*Payment Received*\n\nRail: ${escapeMarkdownV2(railLabel)}\nAmount: \`${sats.toLocaleString()}\` sats\nHash: \`${escapeMarkdownV2(shortHash)}\\.\\.\\.\``;
    await this.sendMessage(text, 'MarkdownV2');
  }

  /**
   * Drain stale updates on startup, then enter the normal poll loop.
   *
   * Calls getUpdates with offset: -1 to skip all queued updates (they were
   * sent while the bot was offline and would otherwise replay on every restart).
   * Then advances offset past that last stale update so pollLoop starts clean.
   */
  private async drainAndPoll(): Promise<void> {
    try {
      const stale = await this.getUpdates(-1);
      if (stale.length > 0) {
        const maxId = Math.max(...stale.map(u => u.update_id));
        this.offset = maxId + 1;
        // Confirm the drain by fetching once with the advanced offset
        await this.getUpdates(this.offset);
      }
    } catch {
      // If drain fails, pollLoop will start from undefined offset (earliest unconfirmed)
    }
    await this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.getUpdates(this.offset);
        for (const update of updates) {
          // Advance offset — use Math.max to guarantee it never goes backward
          this.offset = Math.max(this.offset ?? 0, update.update_id + 1);

          // Skip already-processed updates (dedup guard)
          if (this.processedIds.has(update.update_id)) continue;
          this.processedIds.add(update.update_id);

          await this.processUpdate(update);
        }

        // Cap the dedup set so it doesn't grow unbounded
        if (this.processedIds.size > 500) {
          const ids = [...this.processedIds].sort((a, b) => a - b);
          for (const id of ids.slice(0, ids.length - 200)) {
            this.processedIds.delete(id);
          }
        }
      } catch (err) {
        if (!this.running) break;
        console.error('[telegram] Poll error:', err instanceof Error ? err.message : err);
        // Back off on error
        await this.sleep(5000);
      }
    }
  }

  private async getUpdates(offset: number | undefined): Promise<TelegramUpdate[]> {
    const url = `${TELEGRAM_API}/bot${this.config.botToken}/getUpdates`;
    const body: Record<string, unknown> = {
      timeout: POLL_TIMEOUT,
      allowed_updates: ['message'],
    };
    // Only include offset when explicitly set — offset 0 has special semantics
    // in the Telegram API ("return all unconfirmed") and does NOT confirm prior updates.
    if (offset !== undefined) {
      body.offset = offset;
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abortController?.signal,
    });

    if (!res.ok) {
      throw new Error(`Telegram API error: ${res.status}`);
    }

    const data = await res.json() as { ok: boolean; result: TelegramUpdate[] };
    return data.ok ? data.result : [];
  }

  private async processUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message?.text || !message.chat) return;

    // Chat ID allowlist — silent ignore for unauthorized chats
    if (String(message.chat.id) !== this.config.chatId) return;

    const text = message.text.trim();
    const command = text.split(/\s+/)[0]?.toLowerCase();

    // Strip @botname suffix (e.g. /status@mybot)
    const cmd = command?.split('@')[0];

    let result: CommandResult;
    try {
      switch (cmd) {
        case '/status':
          result = await handleStatus(this.ctx);
          break;
        case '/txs':
          result = await handleTxs(this.ctx);
          break;
        case '/vtxos':
          result = await handleVtxos(this.ctx);
          break;
        case '/health':
          result = await handleHealth(this.ctx, this.lastAlertTime);
          break;
        case '/gateway':
          result = await handleGateway(this.ctx);
          break;
        case '/help':
        case '/start':
          result = { text: formatHelp(), parseMode: 'MarkdownV2' };
          break;
        default:
          // Unknown command — send help
          result = { text: formatHelp(), parseMode: 'MarkdownV2' };
          break;
      }
    } catch (err) {
      console.error('[telegram] Command error:', err instanceof Error ? err.message : err);
      result = { text: 'Error processing command\\. Try again\\.', parseMode: 'MarkdownV2' };
    }

    await this.sendMessage(result.text, result.parseMode);
  }

  private async sendMessage(text: string, parseMode?: 'MarkdownV2'): Promise<void> {
    // Rate limit: wait if needed
    const now = Date.now();
    const elapsed = now - this.lastSendTime;
    if (elapsed < this.rateLimitMs) {
      await this.sleep(this.rateLimitMs - elapsed);
    }

    const url = `${TELEGRAM_API}/bot${this.config.botToken}/sendMessage`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
          parse_mode: parseMode,
        }),
        signal: AbortSignal.timeout(10000),
      });
      this.lastSendTime = Date.now();
    } catch (err) {
      // Message delivery failure must not crash the bot
      console.error('[telegram] Send error:', err instanceof Error ? err.message : err);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Minimal Telegram API types (only what we use)
interface TelegramUpdate {
  update_id: number;
  message?: {
    text?: string;
    chat: { id: number };
  };
}
