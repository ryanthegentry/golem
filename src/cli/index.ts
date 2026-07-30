#!/usr/bin/env node

// EventSource polyfill — MUST come before any Ark SDK imports
import '../polyfills.js';

// Load ~/.golem/.env before anything else (TELEGRAM_*, GOLEM_PASSWORD, etc.)
import * as dotenv from 'dotenv';
import * as os from 'node:os';
import * as path from 'node:path';
dotenv.config({ path: path.join(os.homedir(), '.golem', '.env'), quiet: true });

import { disposeCliResources } from './wallet.js';

// Global error handlers — clean output instead of stack traces. Teardown
// runs first so signer key zeroing happens on these paths too (#10).
process.on('uncaughtException', (err) => {
  console.error(`Error: ${err.message}`);
  void disposeCliResources().finally(() => process.exit(1));
});
process.on('unhandledRejection', (reason) => {
  console.error(`Error: ${reason instanceof Error ? reason.message : reason}`);
  void disposeCliResources().finally(() => process.exit(1));
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

// parseAsync, not parse: parse() returns without awaiting async action
// handlers, so teardown would run before the command's work. The finally
// block is the one teardown every command shares — after it, the event loop
// drains and the process exits on its own. Do not add a forced exit here:
// if a command still hangs after teardown, that is a second holder to find,
// and an exit would hide it while skipping nothing-else (key zeroing already
// ran).
try {
  await program.parseAsync();
} finally {
  await disposeCliResources();
}
