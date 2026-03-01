/**
 * golem stats — Show L402 gateway stats
 */

import { Command } from 'commander';
import { exitWithError } from '../wallet.js';

export const statsCommand = new Command('stats')
  .description('Show L402 gateway stats')
  .option('--port <port>', 'Gateway port to query', '8402')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const url = `http://localhost:${port}/stats`;

    try {
      const headers: Record<string, string> = {};
      const apiKey = process.env.GOLEM_API_KEY;
      if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
      }
      const res = await fetch(url, { headers });
      if (!res.ok) {
        exitWithError(`Gateway returned ${res.status}`);
      }

      const stats = await res.json() as Record<string, number>;

      console.log('');
      console.log('L402 Gateway Stats');
      console.log('');
      console.log(`  Total requests:     ${stats.totalRequests}`);
      console.log(`  Paid requests:      ${stats.paidRequests}`);
      console.log(`  Challenges issued:  ${stats.challengesIssued}`);
      console.log(`  Sats earned:        ${stats.totalSatsEarned}`);

      // Per-rail breakdown (only if fields are present — backward compat)
      if (stats.lightningPaidRequests !== undefined || stats.arkPaidRequests !== undefined) {
        console.log('');
        console.log('  Payment Rails:');
        console.log(`    Lightning:  ${stats.lightningPaidRequests ?? 0} paid, ${stats.lightningEarned ?? 0} sats`);
        console.log(`    Ark OOR:    ${stats.arkPaidRequests ?? 0} paid, ${stats.arkEarned ?? 0} sats`);
        if (stats.arkPendingPayments > 0) {
          console.log(`    Pending:    ${stats.arkPendingPayments} Ark payments awaiting VTXO`);
        }
      }
    } catch (err) {
      if (err instanceof TypeError && (err as TypeError & { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED') {
        exitWithError(`Gateway not running on port ${port}.`);
      } else {
        exitWithError(`Could not reach gateway at ${url}`);
      }
    }
  });
