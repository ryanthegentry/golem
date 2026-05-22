/**
 * golem gateway — Start a dual-mode L402 reverse proxy (Lightning + Ark OOR)
 */

import { Command } from 'commander';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getWallet, exitWithError } from '../wallet.js';
import { getDataDir } from '../config.js';
import { startRefreshAgent } from '../refresh-setup.js';
import { createL402Gateway } from '../../l402/gateway.js';
import { createProxyHandler } from '../../l402/proxy.js';
import { getNetworkConfig } from '../../config/networks.js';
import { createLightning } from '../../lightning/index.js';
import { validateBearerToken } from '../../auth/safe-compare.js';
import { secureHeaders } from 'hono/secure-headers';
import { loadAlertConfig } from '../../monitoring/alerts.js';
import { TelegramBot } from '../../telegram/bot.js';
import { loadGatewayConfig, type GatewayConfig } from '../gateway-config.js';
import { gatewayInitCommand } from './gateway-init.js';
import { registerWithIndex } from '../../registry/register.js';
import { AutoSweep } from '../../sweep/auto-sweep.js';
import { installProcessGuard } from '../../resilience/process-guard.js';

export const gatewayCommand = new Command('gateway')
  .description('Start a dual-mode L402 reverse proxy (Lightning + Ark OOR)')
  .option('--upstream <url>', 'Upstream server URL to proxy to')
  .option('--price <sats>', 'Price per request in satoshis')
  .option('--port <port>', 'Port to listen on', '8402')
  .option('--currency <currency>', 'Currency for pricing', 'sats')
  .option('--description <text>', 'Description shown in 402 responses')
  .option('--free-paths <paths>', 'Comma-separated paths that skip payment', '/health,/stats')
  .option('--no-ark', 'Disable Ark-native OOR payments (Lightning only)')
  .option('--trusted-proxy', 'Trust x-forwarded-for/x-real-ip headers for rate limiting (set when behind a reverse proxy)')
  .option('--demo', 'Simplified output for demos (hides implementation details)')
  .action(async (opts) => {
    // Load golem.yaml — used for CLI fallback and 402index registration
    const yamlConfig: GatewayConfig | null = loadGatewayConfig();

    // Fall back to golem.yaml if --upstream/--price not provided
    if (!opts.upstream || !opts.price) {
      if (yamlConfig) {
        if (!opts.upstream) opts.upstream = yamlConfig.upstream;
        if (!opts.price) opts.price = String(yamlConfig.price);
        if (!opts.port || opts.port === '8402') opts.port = String(yamlConfig.port ?? 8402);
        if (yamlConfig.freePaths) opts.freePaths = yamlConfig.freePaths.join(',');
        if (yamlConfig.description && !opts.description) opts.description = yamlConfig.description;
      }
    }

    if (!opts.upstream || !opts.price) {
      exitWithError(
        'Missing --upstream and/or --price. Either:\n' +
        '  1. Run `golem gateway init` to auto-configure\n' +
        '  2. Pass --upstream <url> --price <sats> directly'
      );
    }

    if (opts.currency && opts.currency !== 'sats') {
      exitWithError('Only sats currency is supported. USD pricing coming soon.');
    }

    const port = parseInt(opts.port, 10);
    const priceSats = parseInt(opts.price, 10);
    const freePaths = opts.freePaths.split(',').map((p: string) => p.trim());

    // Set GOLEM_TRUSTED_PROXY so the gateway rate limiter reads x-forwarded-for
    if (opts.trustedProxy) {
      process.env.GOLEM_TRUSTED_PROXY = '1';
    }

    if (isNaN(priceSats) || priceSats <= 0) {
      exitWithError('--price must be a positive number of satoshis.');
    }

    // Self-proxy detection — prevent infinite request amplification
    try {
      const upstreamUrl = new URL(opts.upstream);
      if (upstreamUrl.protocol !== 'http:' && upstreamUrl.protocol !== 'https:') {
        exitWithError(`Upstream URL must use http or https (got ${upstreamUrl.protocol})`);
      }
      const upstreamHost = upstreamUrl.hostname;
      const upstreamPort = upstreamUrl.port || (upstreamUrl.protocol === 'https:' ? '443' : '80');
      if (
        (upstreamHost === 'localhost' || upstreamHost === '127.0.0.1' || upstreamHost === '0.0.0.0') &&
        String(upstreamPort) === String(port)
      ) {
        exitWithError(
          `Upstream URL points to the gateway's own port (${port}). This creates a self-proxy loop.\n` +
          'Set --upstream to the actual upstream service URL.'
        );
      }
    } catch (err) {
      if (err instanceof TypeError) {
        exitWithError(`Invalid upstream URL: ${opts.upstream}`);
      }
      throw err;  // Re-throw exitWithError calls
    }

    // Install process-level guards — transient upstream errors (ASP 429, EventSource
    // drops, Boltz 404s) must never kill a long-running gateway. The CLI's default
    // handlers call process.exit(1) on any unhandled rejection, which is correct for
    // short-lived commands but fatal for daemons.
    const processGuard = installProcessGuard();

    const { wallet, config } = await getWallet();
    const netConfig = getNetworkConfig(config.network);
    const lightning = await createLightning(wallet.sdkWallet, netConfig, getDataDir());

    // Start RefreshAgent for VTXO protection
    // Pass gateway shutdown handle so emergency exit can stop accepting payments
    const gatewayHandle = { shutdown: () => { /* set below after gateway creation */ } };
    const { agent, alertManager, eventLog } = startRefreshAgent(wallet, config, gatewayHandle, { demo: !!opts.demo });

    // Get Ark address for OOR payments
    let arkAddress: string | undefined;
    if (opts.ark !== false) {
      try {
        arkAddress = await wallet.getAddress();
      } catch {
        // Ark address unavailable — gateway runs Lightning-only
      }
    }

    // Start Telegram dashboard bot (if configured)
    let bot: TelegramBot | null = null;
    const alertConfig = loadAlertConfig();

    // Create L402 gateway (dual-mode if Ark address available)
    const gateway = createL402Gateway(lightning, {
      priceSats,
      description: opts.description,
      freePaths: [...freePaths, '/l402/preimage'],
      arkAddress,
      wallet: arkAddress ? wallet.sdkWallet : undefined,
      onPayment: (rail, sats, paymentHash) => {
        void bot?.notifyPayment(rail, sats, paymentHash);
      },
    });

    // Wire gateway shutdown into the RefreshAgent's emergency exit handle
    gatewayHandle.shutdown = () => gateway.dispose();

    if (alertConfig) {
      bot = new TelegramBot(
        { botToken: alertConfig.telegramBotToken, chatId: alertConfig.telegramChatId },
        {
          wallet,
          getAgentStatus: () => ({ running: agent.isRunning, lastEvent: eventLog.getLast() }),
          getGatewayStats: () => gateway.getStats(),
          getEventLog: () => eventLog,
          networkConfig: netConfig,
        },
      );
      bot.setLastAlertTime(alertManager.lastAlertTime);
      bot.start();
    }

    // Start AutoSweep if configured — validate config at startup (MEDIUM-004)
    let autoSweep: AutoSweep | null = null;
    if (yamlConfig?.sweep?.enabled && yamlConfig.sweep.address) {
      const sweepConfig = {
        enabled: true as const,
        address: yamlConfig.sweep.address,
        threshold: yamlConfig.sweep.threshold,
        keep: yamlConfig.sweep.keep ?? 10_000,
        minSweep: yamlConfig.sweep.minSweep ?? 5_000,
      };
      const configError = AutoSweep.validateConfig(sweepConfig);
      if (configError) {
        console.warn(`  Sweep:     disabled — ${configError}`);
      } else {
        autoSweep = new AutoSweep(
          wallet,
          lightning,
          sweepConfig,
          (event) => console.log(`  [sweep] ${JSON.stringify(event)}`),
          (amount, dest) => void bot?.notifySweep(amount, dest),
          (error) => void bot?.notifySweepError(error),
        );
        autoSweep.start();
      }
    }

    // Build Hono app
    const app = new Hono();

    // Security headers on all responses
    app.use('*', secureHeaders());

    // Free: health check
    app.get('/health', (c) => c.json({ status: 'ok' }));

    // Gateway stats — fail-closed: requires GOLEM_API_KEY
    const apiKey = process.env.GOLEM_API_KEY;
    app.get('/stats', (c) => {
      if (!apiKey) {
        return c.json({ error: 'GOLEM_API_KEY required for /stats' }, 403);
      }
      if (!validateBearerToken(c.req.header('Authorization'), apiKey)) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      return c.json(gateway.getStats());
    });

    // Free: preimage endpoint (for Ark OOR payment polling)
    app.get('/l402/preimage', gateway.preimageHandler);

    // L402 gate on all other routes
    app.use('/*', gateway.middleware);

    // Proxy to upstream
    app.all('/*', createProxyHandler(opts.upstream));

    // Start server with EADDRINUSE handling
    const server = serve({ fetch: app.fetch, port, hostname: '0.0.0.0' }, () => {
      console.log('');
      console.log('');
      if (opts.demo) {
        console.log(`  URL:        http://0.0.0.0:${port}`);
        console.log(`  Upstream:   ${opts.upstream}`);
        console.log(`  Price:      ${priceSats} sats/request`);
        console.log(`  Free paths: ${freePaths.join(', ')}`);
        console.log(`  Lightning:  enabled`);
      } else {
        console.log(`  URL:        http://0.0.0.0:${port}`);
        console.log(`  Upstream:   ${opts.upstream}`);
        console.log(`  Price:      ${priceSats} sats/request`);
        console.log(`  Free paths: ${freePaths.join(', ')}`);
        console.log(`  Network:    ${config.network}`);
        console.log(`  Lightning:  enabled (Boltz reverse swap, invoice generated per-request)`);
        if (arkAddress) {
          console.log(`  Ark OOR:    enabled (${arkAddress})`);
        } else {
          console.log(`  Ark OOR:    disabled (--no-ark)`);
        }
        console.log(`  Refresh:    ${agent.isRunning ? 'running' : 'stopped'} (${config.safeHarborAddress ? 'emergency exit enabled' : 'no safe harbor'})`);
        if (autoSweep) {
          console.log(`  Sweep:      enabled → ${yamlConfig!.sweep!.address} at ${yamlConfig!.sweep!.threshold.toLocaleString()} sats`);
        }
      }
      console.log('');
      console.log('Press Ctrl+C to stop.');

      // 402index auto-registration (fire-and-forget, never blocks gateway)
      if (yamlConfig?.autoRegister !== false && yamlConfig?.publicUrl) {
        registerWithIndex({
          registryUrl: yamlConfig.registryUrl ?? 'https://402index.io',
          publicUrl: yamlConfig.publicUrl,
          serviceName: yamlConfig.serviceName ?? 'Golem Gateway',
          description: yamlConfig.description,
          priceSats,
          category: yamlConfig.category,
          contactEmail: yamlConfig.contactEmail,
          probeBody: yamlConfig.probeBody,
        }).then((result) => {
          switch (result.status) {
            case 'active':
              console.log(`  402index:   registered and live ✓`);
              break;
            case 'pending':
              console.log(`  402index:   registered, pending review (id: ${result.id})`);
              break;
            case 'already_registered':
              console.log('  402index:   already registered');
              break;
            case 'probe_failed':
              console.log(`  402index:   probe failed — ${result.error}`);
              break;
            case 'failed':
              console.log(`  402index:   registration failed — ${result.error}`);
              break;
            case 'skipped':
              console.log(`  402index:   skipped — ${result.reason}`);
              break;
          }
        }).catch((err) => {
          console.error(`  402index:   registration error — ${err instanceof Error ? err.message : err}`);
        });
      }
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        exitWithError(`Port ${port} already in use. Is another gateway running?`);
      }
      throw err;
    });

    // Clean shutdown — await in-progress sweep, then zero key material on exit.
    // NOTE: On Railway, set RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30 to allow
    // the graceful shutdown sequence to complete before SIGKILL.
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      process.on(signal, () => {
        const shutdownTimeout = setTimeout(() => process.exit(1), 28_000);
        Promise.resolve(autoSweep?.stopGraceful(25_000))
          .finally(async () => {
            bot?.stop();
            agent.stop();
            try {
              await wallet.dispose();  // Zero signer key material + tear down SDK watchers
            } catch (err) {
              console.error('[shutdown] wallet.dispose() failed:', err);
            }
            gateway.dispose();
            processGuard.dispose();
            server.close();
            clearTimeout(shutdownTimeout);
            process.exit(0);
          });
      });
    }
  });

gatewayCommand.addCommand(gatewayInitCommand);
