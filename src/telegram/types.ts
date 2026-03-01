/**
 * Telegram bot types — narrow dependency injection interfaces.
 *
 * The bot receives only the functions it needs. No god objects.
 */

import type { WalletBalance, ExtendedVirtualCoin, ArkTransaction } from '@arkade-os/sdk';
import type { RefreshEvent } from '../agent/refresh-agent.js';
import type { EventLog } from '../server/event-log.js';
import type { NetworkConfig } from '../config/networks.js';

/** Narrow wallet interface — only what the bot needs. */
export interface BotWallet {
  getBalance(): Promise<WalletBalance>;
  getVtxos(): Promise<ExtendedVirtualCoin[]>;
  getTransactionHistory(): Promise<ArkTransaction[]>;
  getAddress(): Promise<string>;
}

/** Gateway stats snapshot (from L402Gateway.getStats()). */
export interface GatewayStats {
  totalRequests: number;
  paidRequests: number;
  challengesIssued: number;
  totalSatsEarned: number;
  rateLimited: number;
  lightningPaidRequests: number;
  lightningEarned: number;
  arkPaidRequests: number;
  arkEarned: number;
  arkPendingPayments: number;
}

/** Everything the bot needs — injected at creation. */
export interface BotContext {
  wallet: BotWallet;
  getAgentStatus: () => { running: boolean; lastEvent?: RefreshEvent };
  getGatewayStats: (() => GatewayStats) | null;
  getEventLog: () => EventLog<RefreshEvent>;
  networkConfig: NetworkConfig;
}

export interface BotConfig {
  botToken: string;
  chatId: string;
  /** Minimum ms between bot responses (default: 1000). */
  rateLimitMs?: number;
}

export interface CommandResult {
  text: string;
  parseMode?: 'MarkdownV2';
}
