/**
 * Monitoring + alerts tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  sendAlert,
  AlertManager,
  checkVtxoExpiry,
  checkBalance,
  loadAlertConfig,
  type AlertConfig,
} from './alerts.js';

describe('Alert function', () => {
  it('does not throw when Telegram API is unreachable', async () => {
    const config: AlertConfig = {
      telegramBotToken: 'fake-token',
      telegramChatId: 'fake-chat-id',
    };

    // Mock fetch to simulate network failure
    const originalFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    await expect(sendAlert(config, 'test message', 'CRITICAL')).resolves.toBeUndefined();

    global.fetch = originalFetch;
  });

  it('does not throw when config is null (no Telegram configured)', async () => {
    await expect(sendAlert(null, 'test message', 'WARNING')).resolves.toBeUndefined();
  });

  it('loadAlertConfig returns null when env vars not set', () => {
    const origToken = process.env.TELEGRAM_BOT_TOKEN;
    const origChat = process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHAT_ID;

    expect(loadAlertConfig()).toBeNull();

    if (origToken) process.env.TELEGRAM_BOT_TOKEN = origToken;
    if (origChat) process.env.TELEGRAM_CHAT_ID = origChat;
  });
});

describe('AlertManager', () => {
  let manager: AlertManager;

  beforeEach(() => {
    manager = new AlertManager(null, 60_000); // null config = console-only, 1min cooldown
  });

  it('sends first alert', async () => {
    const sent = await manager.alert('test', 'test message', 'WARNING');
    expect(sent).toBe(true);
    expect(manager.lastAlertTime).not.toBeNull();
  });

  it('respects cooldown — blocks duplicate within cooldown', async () => {
    await manager.alert('test', 'first', 'WARNING');
    const sent2 = await manager.alert('test', 'second', 'WARNING');
    expect(sent2).toBe(false);
  });

  it('different condition keys are independent', async () => {
    const sent1 = await manager.alert('vtxo-expiry', 'vtxo warning', 'WARNING');
    const sent2 = await manager.alert('balance-high', 'balance warning', 'WARNING');
    expect(sent1).toBe(true);
    expect(sent2).toBe(true);
  });

  it('clear resets cooldown for a condition', async () => {
    await manager.alert('test', 'first', 'WARNING');
    manager.clear('test');
    const sent = await manager.alert('test', 'after clear', 'WARNING');
    expect(sent).toBe(true);
  });
});

describe('VTXO expiry checks', () => {
  it('returns CRITICAL when expiry < alert threshold (48h)', () => {
    const result = checkVtxoExpiry(
      { nearestExpirySeconds: 40 * 3600, vtxoCount: 3 },
      48 * 3600, // 48h alert
      72 * 3600, // 72h warning
    );

    expect(result).not.toBeNull();
    expect(result!.level).toBe('CRITICAL');
    expect(result!.message).toContain('expiring');
  });

  it('returns WARNING when expiry < warning threshold (72h)', () => {
    const result = checkVtxoExpiry(
      { nearestExpirySeconds: 60 * 3600, vtxoCount: 2 },
      48 * 3600,
      72 * 3600,
    );

    expect(result).not.toBeNull();
    expect(result!.level).toBe('WARNING');
  });

  it('returns null when expiry is comfortable', () => {
    const result = checkVtxoExpiry(
      { nearestExpirySeconds: 120 * 3600, vtxoCount: 2 },
      48 * 3600,
      72 * 3600,
    );

    expect(result).toBeNull();
  });

  it('returns null when no VTXOs', () => {
    const result = checkVtxoExpiry(
      { nearestExpirySeconds: 10 * 3600, vtxoCount: 0 },
      48 * 3600,
      72 * 3600,
    );

    expect(result).toBeNull();
  });

  it('boundary: exactly at 48h threshold returns CRITICAL', () => {
    const result = checkVtxoExpiry(
      { nearestExpirySeconds: 48 * 3600 - 1, vtxoCount: 1 },
      48 * 3600,
      72 * 3600,
    );

    expect(result).not.toBeNull();
    expect(result!.level).toBe('CRITICAL');
  });

  it('boundary: exactly at 72h threshold returns WARNING', () => {
    const result = checkVtxoExpiry(
      { nearestExpirySeconds: 72 * 3600 - 1, vtxoCount: 1 },
      48 * 3600,
      72 * 3600,
    );

    expect(result).not.toBeNull();
    expect(result!.level).toBe('WARNING');
  });
});

describe('Balance checks', () => {
  it('returns WARNING when balance > 200k sats', () => {
    const result = checkBalance(250_000, 'high');
    expect(result).not.toBeNull();
    expect(result!.level).toBe('WARNING');
    expect(result!.message).toContain('200,000');
  });

  it('returns null when balance <= 200k sats', () => {
    const result = checkBalance(200_000, 'high');
    expect(result).toBeNull();
  });

  it('returns WARNING when balance < 5k sats (low)', () => {
    const result = checkBalance(4_000, 'low');
    expect(result).not.toBeNull();
    expect(result!.level).toBe('WARNING');
    expect(result!.message).toContain('low');
  });

  it('returns null when balance is 0 (empty wallet, no alarm)', () => {
    const result = checkBalance(0, 'low');
    expect(result).toBeNull();
  });
});
