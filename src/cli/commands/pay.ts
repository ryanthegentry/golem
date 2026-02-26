/**
 * golem pay — L402 client: pay for access to an L402-gated URL.
 *
 * 1. Request the URL
 * 2. If 200, print response
 * 3. If 402, parse L402 challenge (macaroon + invoice)
 * 4. Pay invoice via Boltz submarine swap (Ark → Lightning)
 * 5. Retry with Authorization: L402 <macaroon>:<preimage>
 * 6. Print response
 */

import { Command } from 'commander';
import { BoltzSwapProvider, ArkadeLightning } from '@arkade-os/boltz-swap';
import { loadConfig } from '../config.js';
import { createWalletFromConfig } from '../wallet.js';
import { MUTINYNET_LIGHTNING_CONFIG } from '../../lightning/config.js';

/** Parse L402 challenge from 402 response. Tries JSON body first, then WWW-Authenticate header. */
function parseL402Challenge(
  headers: Headers,
  body: Record<string, unknown>,
): { macaroon: string; invoice: string; price?: number } | null {
  // Try JSON body (Golem gateway format)
  if (typeof body.macaroon === 'string' && typeof body.invoice === 'string') {
    return {
      macaroon: body.macaroon,
      invoice: body.invoice,
      price: typeof body.price === 'number' ? body.price : undefined,
    };
  }

  // Try WWW-Authenticate header
  const wwwAuth = headers.get('www-authenticate');
  if (!wwwAuth) return null;

  const match = wwwAuth.match(/L402\s+macaroon="([^"]+)",\s*invoice="([^"]+)"/i);
  if (!match) return null;

  return { macaroon: match[1], invoice: match[2] };
}

export const payCommand = new Command('pay')
  .description('Pay for access to an L402-gated URL')
  .argument('<url>', 'URL to request')
  .option('--max-price <sats>', 'Maximum price to pay (sats)', '10000')
  .option('--method <method>', 'HTTP method', 'GET')
  .option('--header <headers...>', 'Additional headers (key:value)')
  .action(async (url: string, opts) => {
    const maxPrice = parseInt(opts.maxPrice, 10);

    // Build request headers
    const requestHeaders: Record<string, string> = {};
    if (opts.header) {
      for (const h of opts.header as string[]) {
        const idx = h.indexOf(':');
        if (idx > 0) {
          requestHeaders[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
        }
      }
    }

    // Step 1: Make initial request
    console.log(`Requesting ${url}...\n`);
    const res = await fetch(url, {
      method: opts.method,
      headers: requestHeaders,
    });

    // Step 2: If 200, just print
    if (res.status === 200) {
      const contentType = res.headers.get('content-type') || '';
      const text = await res.text();
      if (contentType.includes('json')) {
        try {
          console.log(JSON.stringify(JSON.parse(text), null, 2));
        } catch {
          console.log(text);
        }
      } else {
        console.log(text);
      }
      return;
    }

    // Step 3: If not 402, error
    if (res.status !== 402) {
      console.error(`Unexpected status: ${res.status}`);
      const text = await res.text();
      if (text) console.error(text);
      process.exit(1);
    }

    // Step 4: Parse L402 challenge
    let body: Record<string, unknown> = {};
    try {
      body = await res.json() as Record<string, unknown>;
    } catch {
      // Body may not be JSON
    }

    const challenge = parseL402Challenge(res.headers, body);
    if (!challenge) {
      console.error('Error: Got 402 but could not parse L402 challenge.');
      console.error('Expected WWW-Authenticate header or JSON body with macaroon + invoice.');
      process.exit(1);
    }

    const price = challenge.price;
    console.log('402 Payment Required');
    if (price !== undefined) {
      console.log(`  Price: ${price.toLocaleString()} sats`);
    }
    console.log(`  Invoice: ${challenge.invoice.slice(0, 60)}...`);

    // Step 5: Check max price
    if (price !== undefined && price > maxPrice) {
      console.error(`\nError: Price ${price} sats exceeds --max-price ${maxPrice} sats.`);
      console.error('Use --max-price to increase the limit.');
      process.exit(1);
    }

    // Step 6: Pay invoice
    const config = loadConfig();
    console.log('\nConnecting to Ark server...');
    const wallet = await createWalletFromConfig(config);

    console.log('Paying invoice via Lightning (Ark → Boltz → Lightning)...');
    const swapProvider = new BoltzSwapProvider({
      apiUrl: MUTINYNET_LIGHTNING_CONFIG.boltzApiUrl,
      network: MUTINYNET_LIGHTNING_CONFIG.network,
      referralId: MUTINYNET_LIGHTNING_CONFIG.referralId,
    });

    const lightning = new ArkadeLightning({
      wallet: wallet.sdkWallet,
      swapProvider,
      swapManager: { enableAutoActions: true },
    });

    await lightning.startSwapManager();

    const payResult = await lightning.sendLightningPayment({
      invoice: challenge.invoice,
    });

    console.log(`  Preimage: ${payResult.preimage}`);

    // Step 7: Retry with L402 token
    console.log('\nRetrying with L402 token...');
    const authRes = await fetch(url, {
      method: opts.method,
      headers: {
        ...requestHeaders,
        'Authorization': `L402 ${challenge.macaroon}:${payResult.preimage}`,
      },
    });

    const contentType = authRes.headers.get('content-type') || '';
    const responseText = await authRes.text();

    console.log(`  Status: ${authRes.status}`);
    console.log('');

    if (contentType.includes('json')) {
      try {
        console.log(JSON.stringify(JSON.parse(responseText), null, 2));
      } catch {
        console.log(responseText);
      }
    } else {
      console.log(responseText);
    }

    if (authRes.status === 200) {
      console.log(`\nPaid ${price !== undefined ? price.toLocaleString() : '?'} sats.`);
    } else {
      console.error(`\nWarning: Payment succeeded but server returned ${authRes.status}.`);
    }

    // Force exit — SwapManager's WebSocket cleanup is noisy and hangs
    process.exit(authRes.status === 200 ? 0 : 1);
  });
