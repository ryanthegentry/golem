import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectAddressType, resolveToInvoice, validateCallbackUrl } from './address-resolver.js';

describe('detectAddressType', () => {
  it('detects Lightning Address (user@domain)', () => {
    expect(detectAddressType('marty@tftc.io')).toBe('lightning-address');
    expect(detectAddressType('satoshi@getalby.com')).toBe('lightning-address');
    expect(detectAddressType('user@sub.domain.com')).toBe('lightning-address');
  });

  it('detects bolt11 invoices', () => {
    expect(detectAddressType('lnbc5000n1pjfakeboltzinvoice')).toBe('bolt11');
    expect(detectAddressType('lntb5000n1pjfaketestnet')).toBe('bolt11');
    expect(detectAddressType('lnbcrt5000n1pjfakeregtest')).toBe('bolt11');
  });

  it('detects bech32-encoded LNURL', () => {
    expect(detectAddressType('lnurl1dp68gurn8ghj7fakelnurl')).toBe('lnurl-pay');
  });

  it('detects raw LNURL-pay URLs', () => {
    expect(detectAddressType('https://tftc.io/.well-known/lnurlp/marty')).toBe('lnurl-raw');
    expect(detectAddressType('http://localhost:3000/.well-known/lnurlp/test')).toBe('lnurl-raw');
  });

  it('throws on garbage input', () => {
    expect(() => detectAddressType('garbage')).toThrow('Unrecognized address format');
    expect(() => detectAddressType('')).toThrow('Unrecognized address format');
  });

  it('throws on malformed Lightning Address', () => {
    expect(() => detectAddressType('@invalid')).toThrow('Invalid Lightning Address');
    expect(() => detectAddressType('user@')).toThrow('Invalid Lightning Address');
    expect(() => detectAddressType('@')).toThrow('Invalid Lightning Address');
  });
});

describe('resolveToInvoice', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('Lightning Address', () => {
    const lnurlPayResponse = {
      callback: 'https://tftc.io/lnurlp/marty/callback',
      minSendable: 1_000,     // 1 sat in millisats
      maxSendable: 500_000_000, // 500,000 sats in millisats
      tag: 'payRequest',
      metadata: '[[\"text/plain\",\"Pay marty\"]]',
    };

    it('resolves Lightning Address to bolt11 invoice', async () => {
      fetchSpy
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(lnurlPayResponse),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ pr: 'lnbc100000n1fake' }),
        });

      const result = await resolveToInvoice('marty@tftc.io', 100_000);

      expect(fetchSpy).toHaveBeenCalledTimes(2);
      // First call: LNURL-pay endpoint
      expect(fetchSpy.mock.calls[0][0]).toBe('https://tftc.io/.well-known/lnurlp/marty');
      // Second call: callback with amount in millisats
      expect(fetchSpy.mock.calls[1][0]).toBe('https://tftc.io/lnurlp/marty/callback?amount=100000000');
      expect(result).toEqual({
        bolt11: 'lnbc100000n1fake',
        amountSats: 100_000,
      });
    });

    it('clamps to maxSendable when sweep exceeds max', async () => {
      const smallMax = { ...lnurlPayResponse, maxSendable: 50_000_000 }; // 50k sats
      fetchSpy
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(smallMax) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ pr: 'lnbc50000n1clamped' }) });

      const result = await resolveToInvoice('marty@tftc.io', 100_000);

      // Should clamp to 50,000 sats
      expect(fetchSpy.mock.calls[1][0]).toBe('https://tftc.io/lnurlp/marty/callback?amount=50000000');
      expect(result.amountSats).toBe(50_000);
      expect(result.bolt11).toBe('lnbc50000n1clamped');
    });

    it('throws when sweep amount below minSendable', async () => {
      const highMin = { ...lnurlPayResponse, minSendable: 200_000_000 }; // 200k sats
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(highMin) });

      await expect(resolveToInvoice('marty@tftc.io', 100_000))
        .rejects.toThrow(/below minimum/i);
    });

    it('throws on HTTP error from LNURL endpoint', async () => {
      fetchSpy.mockResolvedValueOnce({ ok: false, status: 404 });

      await expect(resolveToInvoice('marty@tftc.io', 100_000))
        .rejects.toThrow(/404/);
    });

    it('throws on HTTP error from callback', async () => {
      fetchSpy
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(lnurlPayResponse) })
        .mockResolvedValueOnce({ ok: false, status: 500 });

      await expect(resolveToInvoice('marty@tftc.io', 100_000))
        .rejects.toThrow(/500/);
    });

    it('throws on malformed LNURL JSON', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ tag: 'withdrawRequest' }), // wrong tag
      });

      await expect(resolveToInvoice('marty@tftc.io', 100_000))
        .rejects.toThrow(/invalid LNURL/i);
    });

    it('throws when callback response has no pr field', async () => {
      fetchSpy
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(lnurlPayResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });

      await expect(resolveToInvoice('marty@tftc.io', 100_000))
        .rejects.toThrow(/no invoice/i);
    });

    it('throws on network error (DNS, timeout, etc.)', async () => {
      fetchSpy.mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(resolveToInvoice('marty@tftc.io', 100_000))
        .rejects.toThrow('fetch failed');
    });

    it('throws when LNURL response has missing callback field', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ ...lnurlPayResponse, callback: undefined }),
      });

      await expect(resolveToInvoice('marty@tftc.io', 100_000))
        .rejects.toThrow(/invalid LNURL/i);
    });
  });

  describe('raw LNURL URL', () => {
    const lnurlPayResponse = {
      callback: 'https://example.com/lnurlp/callback',
      minSendable: 1_000,
      maxSendable: 1_000_000_000,
      tag: 'payRequest',
      metadata: '[[\"text/plain\",\"test\"]]',
    };

    it('resolves raw LNURL URL to bolt11', async () => {
      fetchSpy
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(lnurlPayResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ pr: 'lnbc50000n1raw' }) });

      const result = await resolveToInvoice('https://example.com/.well-known/lnurlp/user', 50_000);

      expect(fetchSpy.mock.calls[0][0]).toBe('https://example.com/.well-known/lnurlp/user');
      expect(result.bolt11).toBe('lnbc50000n1raw');
      expect(result.amountSats).toBe(50_000);
    });
  });

  describe('bech32 LNURL', () => {
    // bech32-encoded lnurl that decodes to a URL
    // We'll test the decode path by mocking the full resolution

    it('throws on invalid bech32 string', async () => {
      // "lnurl1" prefix but garbage bech32 data
      await expect(resolveToInvoice('lnurl1invalidbech32!!!', 50_000))
        .rejects.toThrow();
    });
  });

  // ---- Callback URL validation (HIGH-003 SSRF prevention) ----

  describe('callback URL validation', () => {
    it('accepts HTTPS callback to public domain', () => {
      expect(() => validateCallbackUrl('https://tftc.io/lnurlp/callback')).not.toThrow();
    });

    it('rejects HTTP callback (non-onion)', () => {
      expect(() => validateCallbackUrl('http://tftc.io/lnurlp/callback')).toThrow(/HTTPS/);
    });

    it('allows HTTP for .onion domains', () => {
      expect(() => validateCallbackUrl('http://abc123.onion/lnurlp/callback')).not.toThrow();
    });

    it('rejects callback pointing to 127.0.0.1', () => {
      expect(() => validateCallbackUrl('https://127.0.0.1/callback')).toThrow(/private IP/i);
    });

    it('rejects callback pointing to localhost', () => {
      expect(() => validateCallbackUrl('https://localhost/callback')).toThrow(/localhost/i);
    });

    it('rejects callback pointing to 169.254.x.x', () => {
      expect(() => validateCallbackUrl('https://169.254.169.254/latest/meta-data/')).toThrow(/private IP/i);
    });

    it('rejects callback pointing to 10.x.x.x', () => {
      expect(() => validateCallbackUrl('https://10.0.0.1/callback')).toThrow(/private IP/i);
    });

    it('rejects callback pointing to 172.16.x.x', () => {
      expect(() => validateCallbackUrl('https://172.16.0.1/callback')).toThrow(/private IP/i);
    });

    it('rejects callback pointing to 192.168.x.x', () => {
      expect(() => validateCallbackUrl('https://192.168.1.1/callback')).toThrow(/private IP/i);
    });

    it('rejects file:// scheme', () => {
      expect(() => validateCallbackUrl('file:///etc/passwd')).toThrow(/HTTPS/);
    });

    it('rejects invalid URL', () => {
      expect(() => validateCallbackUrl('not a url at all')).toThrow(/Invalid callback/);
    });
  });

  describe('callback URL used via URL API in resolution', () => {
    const lnurlPayResponse = {
      callback: 'https://tftc.io/lnurlp/marty/callback',
      minSendable: 1_000,
      maxSendable: 500_000_000,
      tag: 'payRequest' as const,
      metadata: '[[\"text/plain\",\"Pay marty\"]]',
    };

    it('callback amount parameter appended via URL API', async () => {
      fetchSpy
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(lnurlPayResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ pr: 'lnbc100000n1fake' }) });

      await resolveToInvoice('marty@tftc.io', 100_000);

      // URL API appends via searchParams — callback uses ?amount= format
      const callbackCall = fetchSpy.mock.calls[1][0] as string;
      const parsed = new URL(callbackCall);
      expect(parsed.searchParams.get('amount')).toBe('100000000');
    });

    it('both fetch calls receive abort signals for total timeout', async () => {
      fetchSpy
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(lnurlPayResponse) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ pr: 'lnbc100000n1fake' }) });

      await resolveToInvoice('marty@tftc.io', 100_000);

      // Both fetch calls should have received an AbortSignal
      const firstOpts = fetchSpy.mock.calls[0][1] as { signal: AbortSignal };
      const secondOpts = fetchSpy.mock.calls[1][1] as { signal: AbortSignal };
      expect(firstOpts.signal).toBeDefined();
      expect(secondOpts.signal).toBeDefined();
    });

    it('rejects LNURL response with SSRF callback', async () => {
      const ssrfPayload = { ...lnurlPayResponse, callback: 'https://169.254.169.254/latest/meta-data/' };
      fetchSpy.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve(ssrfPayload) });

      await expect(resolveToInvoice('marty@tftc.io', 100_000))
        .rejects.toThrow(/private IP/i);
    });
  });

  describe('bolt11 passthrough', () => {
    it('returns bolt11 invoice directly without HTTP', async () => {
      const invoice = 'lnbc100000n1pjdirectinvoice';
      const result = await resolveToInvoice(invoice, 100_000);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toEqual({
        bolt11: invoice,
        amountSats: 100_000,
      });
    });

    it('works with testnet invoices', async () => {
      const invoice = 'lntb5000n1pjtestnetinvoice';
      const result = await resolveToInvoice(invoice, 5_000);

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result.bolt11).toBe(invoice);
    });
  });
});
