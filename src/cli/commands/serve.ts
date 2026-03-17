/**
 * golem serve — Start the internal L402 API (no upstream proxy).
 *
 * This is what the Railway service runs. Exposes POST /l402/challenge,
 * POST /l402/verify, GET /l402/status on the configured port.
 */

import * as path from 'node:path';
import { Command } from 'commander';
import { serve } from '@hono/node-server';
import { getDataDir } from '../config.js';
import { getWallet, exitWithError } from '../wallet.js';
import { startRefreshAgent } from '../refresh-setup.js';
import { getNetworkConfig } from '../../config/networks.js';
import { createLightning } from '../../lightning/index.js';
import { FileRootKeyStore } from '../../l402/macaroon.js';
import { MacaroonStore } from '../../l402/macaroon-store.js';
import { createInternalApi } from '../../l402/internal-api.js';
import { loadAlertConfig } from '../../monitoring/alerts.js';
import { TelegramBot } from '../../telegram/bot.js';
import { installProcessGuard } from '../../resilience/process-guard.js';

export const serveCommand = new Command('serve')
  .description('Start the internal L402 API (for 402index integration)')
  .option('--port <port>', 'Port to listen on', '8402')
  .option('--host <host>', 'Host to bind to (default: 127.0.0.1 for security)', '127.0.0.1')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const host = opts.host;

    // Long-running daemon — transient upstream errors must not kill the process
    const processGuard = installProcessGuard();

    const { wallet, config } = await getWallet();

    const netConfig = getNetworkConfig(config.network);
    const dataDir = getDataDir();
    const lightning = await createLightning(wallet.sdkWallet, netConfig, dataDir);

    // Start RefreshAgent for VTXO protection
    const { agent, alertManager, eventLog } = startRefreshAgent(wallet, config);

    // Initialize stores
    const rootKeyStore = new FileRootKeyStore(dataDir);
    const macaroonStore = new MacaroonStore(path.join(dataDir, 'macaroons.db'));

    // Daily cleanup of expired macaroons
    const cleanupInterval = setInterval(() => {
      macaroonStore.cleanup();
    }, 24 * 3600 * 1000);

    // Create internal API
    const apiKey = process.env.GOLEM_API_KEY;
    if (!apiKey) {
      console.log('WARNING: No GOLEM_API_KEY set. Internal API endpoints are unprotected.');
      console.log('         Set GOLEM_API_KEY env var to require Bearer token auth.');
    }

    const app = createInternalApi({
      lightning,
      wallet,
      rootKeyStore,
      macaroonStore,
      networkConfig: netConfig,
      startTime: Date.now(),
      alertManager,
      refreshAgentRunning: () => agent.isRunning,
      apiKey,
    });

    const server = serve({ fetch: app.fetch, port, hostname: host }, () => {
      console.log('');
      console.log(`  Network:  ${config.network}`);
      console.log(`  Data dir: ${dataDir}`);
      console.log('');
      console.log('Endpoints:');
      console.log(`  POST /l402/challenge  — Create payment challenge`);
      console.log(`  POST /l402/verify     — Verify L402 token`);
      console.log(`  GET  /l402/status     — Health + metrics`);
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        exitWithError(`Port ${port} already in use.`);
      }
      throw err;
    });

    // Start Telegram dashboard bot (if configured)
    let bot: TelegramBot | null = null;
    const alertConfig = loadAlertConfig();
    if (alertConfig) {
      bot = new TelegramBot(
        { botToken: alertConfig.telegramBotToken, chatId: alertConfig.telegramChatId },
        {
          wallet,
          getAgentStatus: () => ({ running: agent.isRunning, lastEvent: eventLog.getLast() }),
          getGatewayStats: null,
          getEventLog: () => eventLog,
          networkConfig: netConfig,
        },
      );
      bot.setLastAlertTime(alertManager.lastAlertTime);
      bot.start();
    }

    // Graceful shutdown
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;

      bot?.stop();
      agent.stop();

      // Wait for pending Boltz swaps (up to 30 seconds)
      await new Promise(r => setTimeout(r, 1000));

      // Flush and close stores
      clearInterval(cleanupInterval);
      macaroonStore.close();

      processGuard.dispose();
      server.close();
      process.exit(0);
    };

    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  });
