/**
 * Shared RefreshAgent setup for long-running CLI commands (gateway, serve).
 *
 * Creates a RefreshAgent with:
 * - [REFRESH] prefixed logging
 * - Telegram alerts (if TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID set)
 * - Safe harbor config from wallet config
 */

import { RefreshAgent, DEFAULT_REFRESH_CONFIG } from '../agent/refresh-agent.js';
import type { RefreshEvent } from '../agent/refresh-agent.js';
import { AlertManager, loadAlertConfig, checkVtxoExpiry, checkBalance } from '../monitoring/alerts.js';
import { EventLog } from '../server/event-log.js';
import { getNetworkConfig } from '../config/networks.js';
import type { GolemWallet } from '../wallet/golem-wallet.js';
import type { GolemConfig } from './config.js';

interface RefreshSetup {
  agent: RefreshAgent;
  alertManager: AlertManager;
  eventLog: EventLog<RefreshEvent>;
}

interface RefreshSetupOptions {
  demo?: boolean;
}

/**
 * Create and start a RefreshAgent with logging and optional Telegram alerts.
 *
 * @param wallet - The GolemWallet to monitor
 * @param config - CLI config (for safe harbor address + exit threshold)
 * @param gateway - Optional gateway reference for emergency exit shutdown
 * @param options - Optional settings (demo: suppress non-critical noise)
 */
export function startRefreshAgent(
  wallet: GolemWallet,
  config: GolemConfig,
  gateway?: { shutdown(): void },
  options?: RefreshSetupOptions,
): RefreshSetup {
  const demo = options?.demo ?? false;
  const alertConfig = loadAlertConfig();
  const alertManager = new AlertManager(alertConfig);
  const eventLog = new EventLog<RefreshEvent>();
  const netConfig = getNetworkConfig(config.network);

  const refreshConfig = {
    ...DEFAULT_REFRESH_CONFIG,
    safeHarborAddress: config.safeHarborAddress,
    safeHarborExitThresholdBlocks: config.safeHarborExitThresholdBlocks,
    esploraUrl: netConfig.mempoolUrl,
  };

  const agent = new RefreshAgent(wallet, refreshConfig, (event: RefreshEvent) => {
    logRefreshEvent(event, demo);
    eventLog.push(event);
    void handleAlerts(event, alertManager, demo);
  }, gateway);

  agent.start();

  return { agent, alertManager, eventLog };
}

function logRefreshEvent(event: RefreshEvent, demo = false): void {
  if (event.type === 'refresh_error') {
    // In demo mode, suppress transient Ark errors (e.g. "Error renewing VTXOs")
    // that distract from the payment flow. Emergency exits always surface.
    if (!demo) console.error(`Refresh error: ${event.error}`);
  } else if (event.type === 'consolidation_error') {
    if (!demo) console.error(`Consolidation error: ${event.error}`);
  } else if (event.type === 'emergency_exit_triggered') {
    console.error(`EMERGENCY EXIT: ${event.reason}`);
  } else if (event.type === 'emergency_exit_failed') {
    console.error(`Emergency exit FAILED: ${event.error}`);
  }
}

async function handleAlerts(
  event: RefreshEvent,
  alertManager: AlertManager,
  demo = false,
): Promise<void> {
  try {
    if (event.type === 'refresh_error') {
      // Demo: suppress WARNING-level noise; only surface via Telegram if configured
      if (!demo) await alertManager.alert('refresh_error', `Refresh failed: ${event.error}`, 'WARNING');
    }

    if (event.type === 'emergency_exit_triggered') {
      await alertManager.alert('emergency_exit', `EMERGENCY EXIT: ${event.reason}`, 'CRITICAL');
    }

    if (event.type === 'emergency_exit_failed') {
      await alertManager.alert('emergency_exit_failed', `Emergency exit FAILED: ${event.error}`, 'CRITICAL');
    }

    if (event.type === 'reserve_low') {
      if (!demo) await alertManager.alert(
        'reserve_low',
        `On-chain reserve low: ${event.actual} sats, need ${event.required} sats for ${event.vtxoCount} VTXOs`,
        'WARNING',
      );
    }

    if (event.type === 'check') {
      // Use pre-computed data from the tick() event — no redundant SDK calls
      if (event.nearestExpiryMs !== null) {
        const nearestExpirySec = event.nearestExpiryMs / 1000;
        const expiryAlert = checkVtxoExpiry(
          { nearestExpirySeconds: nearestExpirySec, vtxoCount: event.vtxoCount },
          48 * 3600, // CRITICAL at 48h
          72 * 3600, // WARNING at 72h
        );
        if (expiryAlert) {
          // Demo: suppress WARNING-level expiry noise
          if (!demo || expiryAlert.level === 'CRITICAL') {
            await alertManager.alert('vtxo_expiry', expiryAlert.message, expiryAlert.level);
          }
        }
      }

      // Balance alerts — use totalBalanceSats from event payload
      if (!demo) {
        const highAlert = checkBalance(event.totalBalanceSats, 'high');
        if (highAlert) {
          await alertManager.alert('balance_high', highAlert.message, highAlert.level);
        }
        const lowAlert = checkBalance(event.totalBalanceSats, 'low');
        if (lowAlert) {
          await alertManager.alert('balance_low', lowAlert.message, lowAlert.level);
        }
      }
    }

    if (event.type === 'refresh_ok') {
      // Clear expiry and error alerts on successful refresh
      alertManager.clear('vtxo_expiry');
      alertManager.clear('refresh_error');
    }
  } catch (err) {
    console.warn('Alert handler error:', err instanceof Error ? err.message : err);
  }
}
