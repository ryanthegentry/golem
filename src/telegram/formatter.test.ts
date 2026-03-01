import { describe, it, expect } from 'vitest';
import {
  escapeMarkdownV2,
  formatStatus,
  formatTxs,
  formatVtxos,
  formatHealth,
  formatGateway,
  formatHelp,
} from './formatter.js';

describe('escapeMarkdownV2', () => {
  it('escapes special characters', () => {
    expect(escapeMarkdownV2('hello_world')).toBe('hello\\_world');
    expect(escapeMarkdownV2('a*b*c')).toBe('a\\*b\\*c');
    expect(escapeMarkdownV2('test.end')).toBe('test\\.end');
    expect(escapeMarkdownV2('1+2=3')).toBe('1\\+2\\=3');
  });

  it('handles empty string', () => {
    expect(escapeMarkdownV2('')).toBe('');
  });

  it('leaves plain text unchanged', () => {
    expect(escapeMarkdownV2('hello world 123')).toBe('hello world 123');
  });
});

describe('formatStatus', () => {
  it('formats basic status', () => {
    const balance = { total: 50000, available: 45000, settled: 40000, preconfirmed: 5000, boarding: 0 } as any;
    const vtxos: any[] = [];
    const agent = { running: true };
    const net = { golemNetwork: 'mutinynet' } as any;

    const result = formatStatus(balance, vtxos, agent, net);
    expect(result).toContain('Golem Status');
    expect(result).toContain('50,000');
    expect(result).toContain('45,000');
    expect(result).toContain('running');
    expect(result).toContain('mutinynet');
  });

  it('shows nearest expiry when VTXOs exist', () => {
    const balance = { total: 1000, available: 1000, settled: 1000, preconfirmed: 0, boarding: 0 } as any;
    const futureMs = Date.now() + 48 * 3600 * 1000; // 48 hours from now
    const vtxos = [{ value: 1000, virtualStatus: { state: 'settled', batchExpiry: futureMs } }] as any[];
    const agent = { running: true };
    const net = { golemNetwork: 'mutinynet' } as any;

    const result = formatStatus(balance, vtxos, agent, net);
    expect(result).toContain('2d');
  });

  it('handles zero balance', () => {
    const balance = { total: 0, available: 0, settled: 0, preconfirmed: 0, boarding: 0 } as any;
    const result = formatStatus(balance, [], { running: false }, { golemNetwork: 'mainnet' } as any);
    expect(result).toContain('0');
    expect(result).toContain('stopped');
    expect(result).toContain('none');
  });
});

describe('formatTxs', () => {
  it('handles empty transaction list', () => {
    const result = formatTxs([]);
    expect(result).toContain('No transactions yet');
  });

  it('formats transactions', () => {
    const txs = [
      { type: 'receive', amount: 5000 },
      { type: 'send', amount: -2000 },
    ] as any[];

    const result = formatTxs(txs);
    expect(result).toContain('Recent Transactions');
    expect(result).toContain('5,000');
    expect(result).toContain('2,000');
  });

  it('shows last 5 only', () => {
    const txs = Array.from({ length: 8 }, (_, i) => ({ type: 'receive', amount: (i + 1) * 100 })) as any[];
    const result = formatTxs(txs);
    expect(result).toContain('3 more');
  });
});

describe('formatVtxos', () => {
  it('handles empty VTXO list', () => {
    const result = formatVtxos([]);
    expect(result).toContain('No VTXOs');
  });

  it('formats VTXOs with expiry', () => {
    const futureMs = Date.now() + 24 * 3600 * 1000;
    const vtxos = [
      { value: 10000, virtualStatus: { state: 'settled', batchExpiry: futureMs } },
    ] as any[];

    const result = formatVtxos(vtxos);
    expect(result).toContain('10,000');
    expect(result).toContain('settled');
    expect(result).toContain('1d');
  });
});

describe('formatHealth', () => {
  it('formats health check', () => {
    const balance = { total: 25000 } as any;
    const result = formatHealth(balance, 3, { running: true }, '2026-02-28T12:00:00Z');
    expect(result).toContain('Health Check');
    expect(result).toContain('running');
    expect(result).toContain('25,000');
    expect(result).toContain('2026');
  });

  it('shows never for null last alert', () => {
    const balance = { total: 0 } as any;
    const result = formatHealth(balance, 0, { running: false }, null);
    expect(result).toContain('never');
  });
});

describe('formatGateway', () => {
  it('shows not running when null', () => {
    const result = formatGateway(null);
    expect(result).toContain('Gateway not running');
  });

  it('formats gateway stats', () => {
    const stats = {
      totalRequests: 100,
      paidRequests: 50,
      challengesIssued: 60,
      totalSatsEarned: 5000,
      rateLimited: 2,
      lightningPaidRequests: 30,
      lightningEarned: 3000,
      arkPaidRequests: 20,
      arkEarned: 2000,
      arkPendingPayments: 1,
    };

    const result = formatGateway(stats);
    expect(result).toContain('L402 Gateway');
    expect(result).toContain('100');
    expect(result).toContain('5,000');
    expect(result).toContain('Lightning');
    expect(result).toContain('3,000');
    expect(result).toContain('Ark OOR');
    expect(result).toContain('2,000');
  });
});

describe('formatHelp', () => {
  it('lists all commands', () => {
    const result = formatHelp();
    expect(result).toContain('/status');
    expect(result).toContain('/txs');
    expect(result).toContain('/vtxos');
    expect(result).toContain('/health');
    expect(result).toContain('/gateway');
    expect(result).toContain('/help');
  });
});
