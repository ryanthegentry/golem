/**
 * golem stats — Show L402 gateway stats
 */

import { Command } from 'commander';

export const statsCommand = new Command('stats')
  .description('Show L402 gateway stats')
  .option('--port <port>', 'Gateway port to query', '8402')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const url = `http://localhost:${port}/stats`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.error(`Error: Gateway returned ${res.status}`);
        process.exit(1);
      }

      const stats = await res.json();

      console.log('');
      console.log('L402 Gateway Stats');
      console.log('');
      console.log(`  Total requests:     ${stats.totalRequests}`);
      console.log(`  Paid requests:      ${stats.paidRequests}`);
      console.log(`  Challenges issued:  ${stats.challengesIssued}`);
      console.log(`  Sats earned:        ${stats.totalSatsEarned}`);
    } catch (err) {
      if (err instanceof TypeError && (err as any).cause?.code === 'ECONNREFUSED') {
        console.error(`Error: Gateway not running on port ${port}.`);
      } else {
        console.error(`Error: Could not reach gateway at ${url}`);
      }
      process.exit(1);
    }
  });
