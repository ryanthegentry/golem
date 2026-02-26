/**
 * golem pay — L402 client: pay for access to an L402-gated URL.
 *
 * Supports two payment rails:
 * - Lightning (default fallback): Ark → Boltz submarine swap → Lightning invoice
 * - Ark OOR (preferred): direct sendBitcoin to gateway's Ark address (~600ms)
 *
 * 1. Request the URL
 * 2. If 200, print response
 * 3. If 402, parse L402 challenge (Lightning invoice + optional Ark payment option)
 * 4. Pay via preferred rail
 * 5. Retry with Authorization: L402 <macaroon>:<preimage>
 * 6. Print response
 */

import { Command } from 'commander';
import { BoltzSwapProvider, ArkadeLightning } from '@arkade-os/boltz-swap';
import { loadConfig } from '../config.js';
import { createWalletFromConfig } from '../wallet.js';
import { MUTINYNET_LIGHTNING_CONFIG } from '../../lightning/config.js';

interface ArkPaymentOption {
  address: string;
  amount: number;
  payment_id: string;
  macaroon: string;
}

interface L402Challenge {
  macaroon: string;
  invoice: string;
  price?: number;
  arkPayment?: ArkPaymentOption;
}

/** Parse L402 challenge from 402 response. Tries JSON body first, then WWW-Authenticate header. */
function parseL402Challenge(
  headers: Headers,
  body: Record<string, unknown>,
): L402Challenge | null {
  // Try JSON body (Golem gateway format)
  if (typeof body.macaroon === 'string' && typeof body.invoice === 'string') {
    const result: L402Challenge = {
      macaroon: body.macaroon,
      invoice: body.invoice,
      price: typeof body.price === 'number' ? body.price : undefined,
    };

    // Extract Ark payment option if present
    const ark = body.ark_payment as Record<string, unknown> | undefined;
    if (ark && typeof ark.address === 'string' && typeof ark.payment_id === 'string') {
      result.arkPayment = {
        address: ark.address,
        amount: ark.amount as number,
        payment_id: ark.payment_id,
        macaroon: ark.macaroon as string,
      };
    }

    return result;
  }

  // Try WWW-Authenticate header
  const wwwAuth = headers.get('www-authenticate');
  if (!wwwAuth) return null;

  const match = wwwAuth.match(/L402\s+macaroon="([^"]+)",\s*invoice="([^"]+)"/i);
  if (!match) return null;

  return { macaroon: match[1], invoice: match[2] };
}

/** Poll the preimage endpoint until fulfilled or timeout. */
async function pollForPreimage(
  baseUrl: string,
  paymentId: string,
  timeoutMs: number = 30_000,
): Promise<{ preimage: string; macaroon: string }> {
  const endpoint = new URL('/l402/preimage', baseUrl);
  endpoint.searchParams.set('payment_id', paymentId);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const res = await fetch(endpoint.toString());
    if (res.status === 200) {
      const data = await res.json() as { preimage: string; macaroon: string };
      return data;
    }
    if (res.status === 202) {
      // Still pending — wait and retry
      await new Promise(r => setTimeout(r, 500));
      continue;
    }
    // 404 or other error
    const errBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new Error(`Preimage endpoint returned ${res.status}: ${errBody.error || 'unknown error'}`);
  }
  throw new Error(`Timed out waiting for Ark payment confirmation (${timeoutMs}ms)`);
}

export const payCommand = new Command('pay')
  .description('Pay for access to an L402-gated URL')
  .argument('<url>', 'URL to request')
  .option('--max-price <sats>', 'Maximum price to pay (sats)', '10000')
  .option('--method <method>', 'HTTP method', 'GET')
  .option('--header <headers...>', 'Additional headers (key:value)')
  .option('--lightning', 'Force Lightning payment (skip Ark OOR)')
  .option('--ark', 'Force Ark OOR payment (fail if unavailable)')
  .action(async (url: string, opts) => {
    const maxPrice = parseInt(opts.maxPrice, 10);
    const forceRail = opts.lightning ? 'lightning' : opts.ark ? 'ark' : null;

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
    const startTime = Date.now();
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
    if (challenge.arkPayment) {
      console.log(`  Ark OOR: ${challenge.arkPayment.amount} sats → ${challenge.arkPayment.address.slice(0, 30)}...`);
    }

    // Step 5: Check max price
    const effectivePrice = challenge.arkPayment?.amount ?? price;
    if (effectivePrice !== undefined && effectivePrice > maxPrice) {
      console.error(`\nError: Price ${effectivePrice} sats exceeds --max-price ${maxPrice} sats.`);
      console.error('Use --max-price to increase the limit.');
      process.exit(1);
    }

    // Decide which rail to use: prefer Ark if available, unless forced
    const useArk = forceRail === 'ark'
      || (forceRail !== 'lightning' && challenge.arkPayment);

    if (useArk && !challenge.arkPayment) {
      console.error('\nError: --ark specified but gateway does not offer Ark OOR payment.');
      process.exit(1);
    }

    const config = loadConfig();
    console.log('\nConnecting to Ark server...');
    const wallet = await createWalletFromConfig(config);

    let macaroonForAuth: string;
    let preimageForAuth: string;

    if (useArk && challenge.arkPayment) {
      // --- Ark OOR payment path ---
      const ark = challenge.arkPayment;
      console.log(`Paying via Ark OOR (${ark.amount} sats)...`);
      const payStart = Date.now();

      await wallet.sdkWallet.sendBitcoin({
        address: ark.address,
        amount: ark.amount,
      });

      console.log('  OOR sent. Waiting for gateway confirmation...');

      // Extract base URL from the target URL
      const baseUrl = new URL(url).origin;
      const { preimage, macaroon } = await pollForPreimage(baseUrl, ark.payment_id);

      const payDuration = Date.now() - payStart;
      console.log(`  Preimage: ${preimage}`);
      console.log(`  Payment confirmed in ${(payDuration / 1000).toFixed(1)}s (Ark OOR)`);

      macaroonForAuth = macaroon;
      preimageForAuth = preimage;
    } else {
      // --- Lightning payment path ---
      console.log('Paying invoice via Lightning (Ark → Boltz → Lightning)...');
      const payStart = Date.now();

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

      const payDuration = Date.now() - payStart;
      console.log(`  Preimage: ${payResult.preimage}`);
      console.log(`  Payment confirmed in ${(payDuration / 1000).toFixed(1)}s (Lightning)`);

      macaroonForAuth = challenge.macaroon;
      preimageForAuth = payResult.preimage;
    }

    // Step 7: Retry with L402 token
    console.log('\nRetrying with L402 token...');
    const authRes = await fetch(url, {
      method: opts.method,
      headers: {
        ...requestHeaders,
        'Authorization': `L402 ${macaroonForAuth}:${preimageForAuth}`,
      },
    });

    const contentType = authRes.headers.get('content-type') || '';
    const responseText = await authRes.text();
    const totalDuration = Date.now() - startTime;

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
      const paidAmount = useArk && challenge.arkPayment ? challenge.arkPayment.amount : price;
      const rail = useArk ? 'Ark OOR' : 'Lightning';
      console.log(`\nPaid ${paidAmount !== undefined ? paidAmount.toLocaleString() : '?'} sats via ${rail} (${(totalDuration / 1000).toFixed(1)}s total).`);
    } else {
      console.error(`\nWarning: Payment succeeded but server returned ${authRes.status}.`);
    }

    // Force exit — SwapManager's WebSocket cleanup is noisy and hangs
    process.exit(authRes.status === 200 ? 0 : 1);
  });
