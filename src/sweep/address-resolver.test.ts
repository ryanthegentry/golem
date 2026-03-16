import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectAddressType, resolveToInvoice } from './address-resolver.js';

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
