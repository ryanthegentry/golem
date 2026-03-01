/**
 * Golem monitoring — Telegram alerts for VTXO expiry, connectivity, balance.
 *
 * Alert config is optional. If TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID
 * are not set, alerts log to console only. Never crashes on alert failure.
 */

export interface AlertConfig {
  telegramBotToken: string;
  telegramChatId: string;
}

type AlertLevel = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * Load alert config from environment. Returns null if not configured.
 */
export function loadAlertConfig(): AlertConfig | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return null;

  return { telegramBotToken: token, telegramChatId: chatId };
}

/**
 * Send an alert via Telegram (if configured) and log to console.
 * Never throws — alert delivery failure must not crash the server.
 */
export async function sendAlert(
  config: AlertConfig | null,
  message: string,
  level: AlertLevel,
): Promise<void> {
  const prefix = { INFO: '[ALERT:INFO]', WARNING: '[ALERT:WARNING]', CRITICAL: '[ALERT:CRITICAL]' }[level];
  console.log(`${prefix} ${message}`);

  if (!config) return;

  const emoji = { INFO: '\u2139\ufe0f', WARNING: '\u26a0\ufe0f', CRITICAL: '\ud83d\udd34' }[level];
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text: `${emoji} GOLEM ${level}\n${message}`,
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (err) {
    // Alert delivery failure must not crash the server
    console.error('[ALERT] Failed to send Telegram alert:', err instanceof Error ? err.message : err);
  }
}

/**
 * AlertManager — manages alert state to prevent duplicate notifications.
 *
 * Deduplicates by condition key + cooldown period.
 */
export class AlertManager {
  private lastAlerted = new Map<string, number>();
  private readonly cooldownMs: number;
  private readonly config: AlertConfig | null;
  lastAlertTime: string | null = null;

  constructor(config: AlertConfig | null, cooldownMs: number = 3600_000) {
    this.config = config;
    this.cooldownMs = cooldownMs;
  }

  /**
   * Send an alert if the cooldown for this condition has elapsed.
   * Returns true if the alert was sent (or logged).
   */
  async alert(conditionKey: string, message: string, level: AlertLevel): Promise<boolean> {
    const now = Date.now();
    const last = this.lastAlerted.get(conditionKey);

    if (last && now - last < this.cooldownMs) {
      return false; // Still in cooldown
    }

    this.lastAlerted.set(conditionKey, now);
    this.lastAlertTime = new Date(now).toISOString();
    await sendAlert(this.config, message, level);
    return true;
  }

  /** Clear cooldown for a condition (e.g., when it resolves). */
  clear(conditionKey: string): void {
    this.lastAlerted.delete(conditionKey);
  }
}

// --- Alert condition checkers ---

interface VtxoExpiryInfo {
  nearestExpirySeconds: number;
  vtxoCount: number;
}

/**
 * Check VTXO expiry against alert thresholds.
 */
export function checkVtxoExpiry(
  info: VtxoExpiryInfo,
  alertThresholdSeconds: number,
  warningThresholdSeconds: number,
): { level: AlertLevel; message: string } | null {
  if (info.vtxoCount === 0) return null;
  if (info.nearestExpirySeconds <= 0) return null;

  const hoursRemaining = Math.round(info.nearestExpirySeconds / 3600 * 10) / 10;

  if (info.nearestExpirySeconds < alertThresholdSeconds) {
    return {
      level: 'CRITICAL',
      message: `VTXOs expiring in ${hoursRemaining}h! ${info.vtxoCount} VTXO(s) at risk. Refresh NOW.`,
    };
  }

  if (info.nearestExpirySeconds < warningThresholdSeconds) {
    return {
      level: 'WARNING',
      message: `VTXOs expiring in ${hoursRemaining}h. ${info.vtxoCount} VTXO(s). Refresh soon.`,
    };
  }

  return null;
}

/**
 * Check wallet balance against thresholds.
 */
export function checkBalance(
  balanceSats: number,
  direction: 'high' | 'low',
): { level: AlertLevel; message: string } | null {
  if (direction === 'high' && balanceSats > 200_000) {
    return {
      level: 'WARNING',
      message: `Wallet balance ${balanceSats.toLocaleString()} sats exceeds 200,000 sats. Consider running 'golem sweep' to move excess to safe harbor.`,
    };
  }

  if (direction === 'low' && balanceSats < 5_000 && balanceSats > 0) {
    return {
      level: 'WARNING',
      message: `Wallet balance low: ${balanceSats.toLocaleString()} sats. Gateway may not be able to receive payments.`,
    };
  }

  return null;
}
