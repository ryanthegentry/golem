/**
 * Telegram MarkdownV2 formatters for the dashboard bot.
 *
 * All functions return escaped MarkdownV2 strings. Numbers use monospace.
 */

import type { WalletBalance, ExtendedVirtualCoin, ArkTransaction } from '@arkade-os/sdk';
import type { GatewayStats } from './types.js';
import type { NetworkConfig } from '../config/networks.js';
import type { RefreshEvent } from '../agent/refresh-agent.js';
import { getNearestExpiryMs } from '../agent/expiry.js';

/** Escape MarkdownV2 special characters. */
export function escapeMarkdownV2(text: string): string {
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/** Format ms duration as human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 0) return 'expired';
  const hours = Math.floor(ms / 3600000);
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  if (days > 0) return `${days}d ${remainingHours}h`;
  const minutes = Math.floor((ms % 3600000) / 60000);
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/** /status — wallet balance, VTXO count, nearest expiry, agent status, network. */
export function formatStatus(
  balance: WalletBalance,
  vtxos: ExtendedVirtualCoin[],
  agentStatus: { running: boolean; lastEvent?: RefreshEvent },
  networkConfig: NetworkConfig,
): string {
  const nearestMs = getNearestExpiryMs(
    vtxos.map(v => ({ batchExpiry: v.virtualStatus?.batchExpiry ?? 0 })),
  );

  const lines = [
    `*Golem Status*`,
    ``,
    `*Balance*`,
    `  Total:     \`${balance.total.toLocaleString()}\` sats`,
    `  Available: \`${balance.available.toLocaleString()}\` sats`,
    `  Settled:   \`${balance.settled.toLocaleString()}\` sats`,
    ``,
    `*VTXOs*`,
    `  Count:   \`${vtxos.length}\``,
    `  Nearest: ${nearestMs !== null ? `\`${escapeMarkdownV2(formatDuration(nearestMs))}\`` : 'none'}`,
    ``,
    `*Agent:* ${agentStatus.running ? 'running' : 'stopped'}`,
    `*Network:* ${escapeMarkdownV2(networkConfig.golemNetwork)}`,
  ];

  return lines.join('\n');
}

/** /txs — last 5 transactions. */
export function formatTxs(txs: ArkTransaction[]): string {
  if (txs.length === 0) {
    return '*Recent Transactions*\n\nNo transactions yet\\.';
  }

  const recent = txs.slice(-5).reverse();
  const lines = ['*Recent Transactions*', ''];

  for (const tx of recent) {
    // ArkTransaction has: type, amount, createdAt, settled, boardingTxHash, roundTxHash
    const type = escapeMarkdownV2(String(tx.type ?? 'unknown'));
    const amount = typeof tx.amount === 'number' ? tx.amount : 0;
    const sign = amount >= 0 ? '\\+' : '';
    lines.push(`${type}: ${sign}\`${amount.toLocaleString()}\` sats`);
  }

  if (txs.length > 5) {
    lines.push('');
    lines.push(`_${escapeMarkdownV2(`${txs.length - 5} more...`)}_`);
  }

  return lines.join('\n');
}

/** /vtxos — list VTXOs with amounts and time-until-expiry. */
export function formatVtxos(vtxos: ExtendedVirtualCoin[]): string {
  if (vtxos.length === 0) {
    return '*VTXOs*\n\nNo VTXOs\\.';
  }

  const lines = ['*VTXOs*', ''];
  const now = Date.now();

  for (const vtxo of vtxos) {
    const sats = vtxo.value ?? 0;
    const state = vtxo.virtualStatus?.state ?? 'unknown';
    const batchExpiry = vtxo.virtualStatus?.batchExpiry ?? 0;
    let expStr = '';
    if (batchExpiry > 0 && batchExpiry >= 1e9) {
      const expiryMs = batchExpiry >= 1e12 ? batchExpiry : batchExpiry * 1000;
      const remaining = expiryMs - now;
      expStr = remaining > 0 ? ` \\(${escapeMarkdownV2(formatDuration(remaining))}\\)` : ' \\(expired\\)';
    }
    lines.push(`\`${sats.toLocaleString()}\` sats \\[${escapeMarkdownV2(state)}\\]${expStr}`);
  }

  return lines.join('\n');
}

/** /health — ASP reachability, agent state, last alert time. */
export function formatHealth(
  balance: WalletBalance,
  vtxoCount: number,
  agentStatus: { running: boolean },
  lastAlertTime: string | null,
): string {
  const lines = [
    '*Health Check*',
    '',
    `Agent:      ${agentStatus.running ? 'running' : 'stopped'}`,
    `VTXOs:      \`${vtxoCount}\``,
    `Balance:    \`${balance.total.toLocaleString()}\` sats`,
    `Last alert: ${lastAlertTime ? escapeMarkdownV2(lastAlertTime) : 'never'}`,
  ];

  return lines.join('\n');
}

/** /gateway — L402 gateway stats or "not running". */
export function formatGateway(stats: GatewayStats | null): string {
  if (!stats) {
    return '*L402 Gateway*\n\nGateway not running\\.';
  }

  const lines = [
    '*L402 Gateway*',
    '',
    `Total requests:  \`${stats.totalRequests.toLocaleString()}\``,
    `Paid requests:   \`${stats.paidRequests.toLocaleString()}\``,
    `Earned:          \`${stats.totalSatsEarned.toLocaleString()}\` sats`,
    '',
    `*Lightning*`,
    `  Paid:   \`${stats.lightningPaidRequests.toLocaleString()}\``,
    `  Earned: \`${stats.lightningEarned.toLocaleString()}\` sats`,
    '',
    `*Ark OOR*`,
    `  Paid:    \`${stats.arkPaidRequests.toLocaleString()}\``,
    `  Earned:  \`${stats.arkEarned.toLocaleString()}\` sats`,
    `  Pending: \`${stats.arkPendingPayments}\``,
    '',
    `Rate limited: \`${stats.rateLimited.toLocaleString()}\``,
    `Challenges:   \`${stats.challengesIssued.toLocaleString()}\``,
  ];

  return lines.join('\n');
}

/** /help — command list. */
export function formatHelp(): string {
  return [
    '*Golem Dashboard*',
    '',
    '/status \\- Wallet balance, VTXO count, agent status',
    '/txs \\- Recent transactions',
    '/vtxos \\- VTXO list with expiry times',
    '/health \\- System health check',
    '/gateway \\- L402 gateway stats',
    '/help \\- This message',
  ].join('\n');
}
