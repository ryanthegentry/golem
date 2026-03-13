/**
 * L402 URL payment mode for `golem pay`.
 *
 * Requests an L402-gated URL, pays the 402 challenge (via Lightning or Ark OOR),
 * and retries with the L402 authorization token.
 */

import { getWallet, exitWithError } from '../wallet.js';
import { getNetworkConfig, type NetworkConfig } from '../../config/networks.js';
import { createLightning } from '../../lightning/index.js';
import type { GolemWallet } from '../../wallet/golem-wallet.js';

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

interface PaymentResult {
  macaroon: string;
  preimage: string;
  rail: 'Ark OOR' | 'Lightning';
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

/** Build request headers from --header CLI options. */
function buildRequestHeaders(headerArgs: string[] | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!headerArgs) return headers;
  for (const h of headerArgs) {
    const idx = h.indexOf(':');
    if (idx > 0) {
      headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    }
  }
  return headers;
}

/**
 * Fetch the URL and extract a 402 challenge. Returns null if the response was
 * 200 (content already printed). Throws on non-402 errors.
 */
async function fetch402Challenge(
  url: string,
  method: string,
  requestHeaders: Record<string, string>,
  maxPrice: number,
): Promise<{ challenge: L402Challenge; useArk: boolean } | null> {
  console.log(`Requesting ${url}...\n`);
  const res = await fetch(url, { method, headers: requestHeaders });

  // 200 — just print the response body
  if (res.status === 200) {
    printResponseBody(res.headers.get('content-type') || '', await res.text());
    return null;
  }

  if (res.status !== 402) {
    const text = await res.text();
    throw new Error(`Unexpected status: ${res.status}${text ? `\n${text}` : ''}`);
  }

  // Parse 402 challenge
  let body: Record<string, unknown> = {};
  try {
    body = await res.json() as Record<string, unknown>;
  } catch {
    // Body may not be JSON
  }

  const challenge = parseL402Challenge(res.headers, body);
  if (!challenge) {
    throw new Error('Got 402 but could not parse L402 challenge. Expected WWW-Authenticate header or JSON body with macaroon + invoice.');
  }

  // Log challenge details
  console.log('402 Payment Required');
  if (challenge.price !== undefined) {
    console.log(`  Price: ${challenge.price.toLocaleString()} sats`);
  }
  console.log(`  Invoice: ${challenge.invoice.slice(0, 60)}...`);
  if (challenge.arkPayment) {
    console.log(`  Ark OOR: ${challenge.arkPayment.amount} sats → ${challenge.arkPayment.address.slice(0, 30)}...`);
  }

  // Enforce max price
  const effectivePrice = challenge.arkPayment?.amount ?? challenge.price;
  if (effectivePrice !== undefined && effectivePrice > maxPrice) {
    throw new Error(`Price ${effectivePrice} sats exceeds --max-price ${maxPrice} sats. Use --max-price to increase the limit.`);
  }

  return { challenge, useArk: false };
}

/** Pay a 402 challenge via Ark OOR. Returns macaroon + preimage. */
async function payViaArkOOR(
  url: string,
  challenge: L402Challenge,
  wallet: GolemWallet,
): Promise<PaymentResult> {
  const ark = challenge.arkPayment!;
  console.log(`Paying via Ark OOR (${ark.amount} sats)...`);
  const payStart = Date.now();

  await wallet.sdkWallet.sendBitcoin({
    address: ark.address,
    amount: ark.amount,
  });

  console.log('  OOR sent. Waiting for gateway confirmation...');
  const baseUrl = new URL(url).origin;
  const { preimage, macaroon } = await pollForPreimage(baseUrl, ark.payment_id);

  const payDuration = Date.now() - payStart;
  console.log(`  Preimage: ${preimage.slice(0, 8)}...`);
  console.log(`  Payment confirmed in ${(payDuration / 1000).toFixed(1)}s (Ark OOR)`);

  return { macaroon, preimage, rail: 'Ark OOR' };
}

/** Pay a 402 challenge via Lightning (Ark -> Boltz -> Lightning). Returns macaroon + preimage. */
async function payViaLightning(
  challenge: L402Challenge,
  wallet: GolemWallet,
  netConfig: NetworkConfig,
): Promise<PaymentResult> {
  console.log('Paying invoice via Lightning (Ark → Boltz → Lightning)...');
  const payStart = Date.now();

  const lightning = await createLightning(wallet.sdkWallet, netConfig);

  const payResult = await lightning.sendLightningPayment({
    invoice: challenge.invoice,
  });

  const payDuration = Date.now() - payStart;
  console.log(`  Preimage: ${payResult.preimage.slice(0, 8)}...`);
  console.log(`  Payment confirmed in ${(payDuration / 1000).toFixed(1)}s (Lightning)`);

  return { macaroon: challenge.macaroon, preimage: payResult.preimage, rail: 'Lightning' };
}

/** Retry the original request with the L402 authorization token and print the result. */
async function fetchWithL402Token(
  url: string,
  method: string,
  requestHeaders: Record<string, string>,
  payment: PaymentResult,
  challenge: L402Challenge,
  startTime: number,
): Promise<void> {
  console.log('\nRetrying with L402 token...');
  const authRes = await fetch(url, {
    method,
    headers: {
      ...requestHeaders,
      'Authorization': `L402 ${payment.macaroon}:${payment.preimage}`,
    },
  });

  const contentType = authRes.headers.get('content-type') || '';
  const responseText = await authRes.text();
  const totalDuration = Date.now() - startTime;

  console.log(`  Status: ${authRes.status}`);
  console.log('');
  printResponseBody(contentType, responseText);

  if (authRes.status === 200) {
    const paidAmount = payment.rail === 'Ark OOR' && challenge.arkPayment
      ? challenge.arkPayment.amount : challenge.price;
    console.log(`\nPaid ${paidAmount !== undefined ? paidAmount.toLocaleString() : '?'} sats via ${payment.rail} (${(totalDuration / 1000).toFixed(1)}s total).`);
  } else {
    console.error(`\nWarning: Payment succeeded but server returned ${authRes.status}.`);
  }

  // Force exit — SwapManager's WebSocket cleanup is noisy and hangs
  process.exit(authRes.status === 200 ? 0 : 1);
}

/** Print response body, pretty-printing JSON when possible. */
function printResponseBody(contentType: string, text: string): void {
  if (contentType.includes('json')) {
    try {
      console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
      console.log(text);
    }
  } else {
    console.log(text);
  }
}

/** L402 client: request URL, pay 402 challenge, retry with token. */
export async function payL402Url(url: string, opts: Record<string, unknown>): Promise<void> {
  const maxPrice = parseInt(opts.maxPrice as string, 10);
  const forceRail = opts.lightning ? 'lightning' : opts.ark ? 'ark' : null;
  const method = opts.method as string;
  const requestHeaders = buildRequestHeaders(opts.header as string[] | undefined);

  try {
    // Step 1: Fetch the 402 challenge (returns null if 200)
    const startTime = Date.now();
    const result = await fetch402Challenge(url, method, requestHeaders, maxPrice);
    if (!result) return;
    const { challenge } = result;

    // Step 2: Decide payment rail
    const useArk = forceRail === 'ark'
      || (forceRail !== 'lightning' && !!challenge.arkPayment);

    if (useArk && !challenge.arkPayment) {
      exitWithError('--ark specified but gateway does not offer Ark OOR payment.');
    }

    // Step 3: Pay via chosen rail
    console.log('\nConnecting to Ark server...');
    const { wallet, config } = await getWallet();
    const netConfig = getNetworkConfig(config.network);

    const payment = useArk
      ? await payViaArkOOR(url, challenge, wallet)
      : await payViaLightning(challenge, wallet, netConfig);

    // Step 4: Retry with L402 token
    await fetchWithL402Token(url, method, requestHeaders, payment, challenge, startTime);
  } catch (err) {
    exitWithError(err instanceof Error ? err.message : String(err));
  }
}
