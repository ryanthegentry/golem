/**
 * golem directory — Search and list services from the 402Index.io directory.
 *
 * Public API, no authentication required.
 */

import { Command } from 'commander';
import { queryDirectory } from '../../directory/client.js';
import type { DirectoryService, DirectoryQuery } from '../../directory/client.js';

/** Format a table row for a service. */
function formatRow(s: DirectoryService): string {
  const name = s.name.length > 28 ? s.name.slice(0, 25) + '...' : s.name;
  const provider = (s.provider ?? '-').slice(0, 16);
  const price = s.price_sats !== null ? `${s.price_sats} sats` : s.price_usd !== null ? `$${s.price_usd}` : '-';
  const health = s.health_status;
  return `  ${name.padEnd(28)} ${provider.padEnd(18)} ${price.padEnd(12)} ${s.protocol.padEnd(6)} ${health}`;
}

function printTable(services: DirectoryService[], total: number, offset: number, limit: number): void {
  if (services.length === 0) {
    console.log('\n  No services found.\n');
    return;
  }

  console.log('');
  console.log(`  ${'Name'.padEnd(28)} ${'Provider'.padEnd(18)} ${'Price'.padEnd(12)} ${'Proto'.padEnd(6)} Health`);
  console.log(`  ${'─'.repeat(28)} ${'─'.repeat(18)} ${'─'.repeat(12)} ${'─'.repeat(6)} ${'─'.repeat(8)}`);

  for (const s of services) {
    console.log(formatRow(s));
  }

  console.log('');
  if (total > offset + limit) {
    console.log(`  Showing ${offset + 1}–${offset + services.length} of ${total}. Use --offset ${offset + limit} to see more.`);
  } else {
    console.log(`  ${total} service${total === 1 ? '' : 's'} total.`);
  }
  console.log('');
}

const searchCommand = new Command('search')
  .description('Search the 402Index.io service directory')
  .argument('<query>', 'Search query (name/description)')
  .option('--category <category>', 'Filter by category (e.g., crypto/defi)')
  .option('--protocol <protocol>', 'Filter by protocol: L402, x402, both')
  .option('--max-price <sats>', 'Maximum price in sats')
  .option('--healthy-only', 'Only show healthy services')
  .option('--limit <n>', 'Results per page', '20')
  .option('--offset <n>', 'Pagination offset', '0')
  .option('--json', 'Output raw JSON')
  .action(async (query: string, opts) => {
    const params: DirectoryQuery = {
      q: query,
      limit: parseInt(opts.limit, 10),
      offset: parseInt(opts.offset, 10),
    };

    if (opts.category) params.category = opts.category;
    if (opts.protocol) params.protocol = opts.protocol;
    if (opts.healthyOnly) params.health = 'healthy';
    if (opts.maxPrice) {
      // API takes max_price_usd; convert sats to USD rough estimate isn't useful.
      // Pass as-is — the directory may add sats filtering in future.
      // For now, use it as a display-side filter.
      const maxSats = parseInt(opts.maxPrice, 10);
      if (!isNaN(maxSats)) {
        params.limit = 200; // fetch more to filter client-side
      }
    }

    try {
      const result = await queryDirectory(params);

      // Client-side sats filter if --max-price was specified
      let services = result.services;
      if (opts.maxPrice) {
        const maxSats = parseInt(opts.maxPrice, 10);
        if (!isNaN(maxSats)) {
          services = services.filter(s => s.price_sats === null || s.price_sats <= maxSats);
        }
      }

      if (opts.json) {
        console.log(JSON.stringify({ services, total: services.length }, null, 2));
      } else {
        printTable(services, result.total, result.offset, result.limit);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

const listCommand = new Command('list')
  .description('List all services in the 402Index.io directory')
  .option('--protocol <protocol>', 'Filter by protocol: L402, x402, both')
  .option('--healthy-only', 'Only show healthy services')
  .option('--category <category>', 'Filter by category')
  .option('--limit <n>', 'Results per page', '20')
  .option('--offset <n>', 'Pagination offset', '0')
  .option('--all', 'Show all results (overrides --limit)')
  .option('--json', 'Output raw JSON')
  .action(async (opts) => {
    const params: DirectoryQuery = {
      limit: opts.all ? 200 : parseInt(opts.limit, 10),
      offset: parseInt(opts.offset, 10),
    };

    if (opts.protocol) params.protocol = opts.protocol;
    if (opts.healthyOnly) params.health = 'healthy';
    if (opts.category) params.category = opts.category;

    try {
      const result = await queryDirectory(params);

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        printTable(result.services, result.total, result.offset, result.limit);
      }
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

export const directoryCommand = new Command('directory')
  .description('Browse the 402Index.io L402/x402 service directory')
  .addCommand(searchCommand)
  .addCommand(listCommand);
