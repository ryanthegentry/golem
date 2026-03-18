#!/usr/bin/env node

// EventSource polyfill — MUST come before any Ark SDK imports
import '../polyfills.js';

// Load ~/.golem/.env before anything else (TELEGRAM_*, GOLEM_PASSWORD, etc.)
import * as dotenv from 'dotenv';
import * as os from 'node:os';
import * as path from 'node:path';
dotenv.config({ path: path.join(os.homedir(), '.golem', '.env'), quiet: true });

// Global error handlers — clean output instead of stack traces
process.on('uncaughtException', (err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error(`Error: ${reason instanceof Error ? reason.message : reason}`);
  process.exit(1);
});

import { Command } from 'commander';
import { initCommand } from './commands/init.js';
import { balanceCommand } from './commands/balance.js';
import { gatewayCommand } from './commands/gateway.js';
import { statsCommand } from './commands/stats.js';
import { payCommand } from './commands/pay.js';
import { safeHarborCommand } from './commands/safe-harbor.js';
import { exitCommand } from './commands/exit.js';
import { reserveCommand } from './commands/reserve.js';
import { serveCommand } from './commands/serve.js';
import { sweepCommand } from './commands/sweep.js';
import { receiveCommand } from './commands/receive.js';
import { directoryCommand } from './commands/directory.js';

const program = new Command()
  .name('golem')
  .description('Agent-managed self-custodial Bitcoin wallet on Ark')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(balanceCommand);
program.addCommand(gatewayCommand);
program.addCommand(statsCommand);
program.addCommand(payCommand);
program.addCommand(safeHarborCommand);
program.addCommand(exitCommand);
program.addCommand(reserveCommand);
program.addCommand(serveCommand);
program.addCommand(sweepCommand);
program.addCommand(receiveCommand);
program.addCommand(directoryCommand);

program.parse();
