import { bech32 } from '@scure/base';
import type { SweepAddressType, ResolvedInvoice, LnurlPayResponse, LnurlCallbackResponse } from './types.js';

/**
 * Detect the address format from a user-provided sweep destination.
 */
export function detectAddressType(address: string): SweepAddressType {
  if (address.includes('@')) {
    const [user, domain] = address.split('@');
    if (!user || !domain) {
      throw new Error('Invalid Lightning Address: missing user or domain');
    }
    return 'lightning-address';
  }

  if (address.startsWith('lnurl1')) return 'lnurl-pay';
  if (address.startsWith('lnbc') || address.startsWith('lntb') || address.startsWith('lnbcrt')) return 'bolt11';
  if (address.startsWith('http://') || address.startsWith('https://')) return 'lnurl-raw';

  throw new Error(`Unrecognized address format: ${address}`);
}

/**
 * Resolve any supported address format to a payable bolt11 invoice.
 *
 * For Lightning Address and LNURL-pay: performs HTTP resolution.
 * For bolt11: passes through directly (single-use warning logged by caller).
 */
export async function resolveToInvoice(address: string, amountSats: number): Promise<ResolvedInvoice> {
  const type = detectAddressType(address);

  switch (type) {
    case 'lightning-address': {
      const [user, domain] = address.split('@');
      const url = `https://${domain}/.well-known/lnurlp/${user}`;
      return resolveLnurlPayEndpoint(url, amountSats);
    }
    case 'lnurl-pay': {
      const url = decodeLnurlBech32(address);
      return resolveLnurlPayEndpoint(url, amountSats);
    }
    case 'lnurl-raw': {
      return resolveLnurlPayEndpoint(address, amountSats);
    }
    case 'bolt11': {
      return { bolt11: address, amountSats };
    }
  }
}

/**
 * Fetch a LNURL-pay endpoint, validate the payRequest, request an invoice via
 * the callback, and return the bolt11.
 */
async function resolveLnurlPayEndpoint(url: string, amountSats: number): Promise<ResolvedInvoice> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`LNURL-pay endpoint returned HTTP ${res.status}`);
  }

  const data = await res.json() as LnurlPayResponse;

  if (data.tag !== 'payRequest' || !data.callback) {
    throw new Error('Invalid LNURL-pay response: missing tag=payRequest or callback');
  }

  const amountMillisats = amountSats * 1000;

  // Check minSendable
  if (amountMillisats < data.minSendable) {
    throw new Error(
      `Sweep amount ${amountSats} sats is below minimum ${Math.ceil(data.minSendable / 1000)} sats`,
    );
  }

  // Clamp to maxSendable
  let finalAmountSats = amountSats;
  if (amountMillisats > data.maxSendable) {
    finalAmountSats = Math.floor(data.maxSendable / 1000);
  }

  const finalMillisats = finalAmountSats * 1000;
  const callbackUrl = `${data.callback}?amount=${finalMillisats}`;

  const cbRes = await fetch(callbackUrl, { signal: AbortSignal.timeout(15_000) });
  if (!cbRes.ok) {
    throw new Error(`LNURL callback returned HTTP ${cbRes.status}`);
  }

  const cbData = await cbRes.json() as LnurlCallbackResponse;
  if (!cbData.pr) {
    throw new Error('LNURL callback returned no invoice (missing pr field)');
  }

  return {
    bolt11: cbData.pr,
    amountSats: finalAmountSats,
  };
}

/**
 * Decode a bech32-encoded LNURL (lnurl1...) to a plain URL string.
 */
function decodeLnurlBech32(lnurl: string): string {
  const decoded = bech32.decode(lnurl, 2000);
  const bytes = bech32.fromWords(decoded.words);
  return new TextDecoder().decode(new Uint8Array(bytes));
}
