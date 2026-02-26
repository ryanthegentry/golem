#!/usr/bin/env node

// EventSource polyfill — MUST come before any Ark SDK imports
import { EventSource } from 'eventsource';
(globalThis as any).EventSource ??= EventSource;

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

const program = new Command()
  .name('golem')
  .description('Agent-managed self-custodial Bitcoin wallet on Ark')
  .version('0.1.0');

program.addCommand(initCommand);
program.addCommand(balanceCommand);
program.addCommand(gatewayCommand);
program.addCommand(statsCommand);
program.addCommand(payCommand);

program.parse();
