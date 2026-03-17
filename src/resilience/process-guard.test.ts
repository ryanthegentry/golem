import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installProcessGuard } from './process-guard.js';

describe('ProcessGuard', () => {
  let originalExit: typeof process.exit;
  let exitMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    originalExit = process.exit;
    exitMock = vi.fn() as unknown as ReturnType<typeof vi.fn>;
    process.exit = exitMock as unknown as typeof process.exit;
    // Clear all listeners to start fresh
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  });

  afterEach(() => {
    process.exit = originalExit;
    process.removeAllListeners('uncaughtException');
    process.removeAllListeners('unhandledRejection');
  });

  it('suppresses transient unhandled rejections (EventSource)', () => {
    const { stats, dispose } = installProcessGuard();

    // Simulate ASP EventSource error (the exact crash we saw in production)
    process.emit('unhandledRejection' as any, new Error('EventSource error'), Promise.resolve());

    expect(exitMock).not.toHaveBeenCalled();
    expect(stats.transientErrorsCaught).toBe(1);
    expect(stats.lastTransientError).toBe('EventSource error');

    dispose();
  });

  it('suppresses transient "Too Many Requests" errors', () => {
    const { stats, dispose } = installProcessGuard();

    process.emit('unhandledRejection' as any, new Error('Failed to fetch vtxos: Too Many Requests'), Promise.resolve());

    expect(exitMock).not.toHaveBeenCalled();
    expect(stats.transientErrorsCaught).toBe(1);

    dispose();
  });

  it('suppresses transient ECONNRESET errors', () => {
    const { stats, dispose } = installProcessGuard();

    process.emit('uncaughtException' as any, new Error('read ECONNRESET'));

    expect(exitMock).not.toHaveBeenCalled();
    expect(stats.transientErrorsCaught).toBe(1);

    dispose();
  });

  it('suppresses transient "fetch failed" errors', () => {
    const { stats, dispose } = installProcessGuard();

    process.emit('unhandledRejection' as any, new Error('fetch failed'), Promise.resolve());

    expect(exitMock).not.toHaveBeenCalled();
    expect(stats.transientErrorsCaught).toBe(1);

    dispose();
  });

  it('suppresses transient "Bad Gateway" errors', () => {
    const { stats, dispose } = installProcessGuard();

    process.emit('unhandledRejection' as any, new Error('Failed to fetch vtxos: Bad Gateway'), Promise.resolve());

    expect(exitMock).not.toHaveBeenCalled();
    expect(stats.transientErrorsCaught).toBe(1);

    dispose();
  });

  it('exits on non-transient errors (fatal)', () => {
    const { stats, dispose } = installProcessGuard();

    process.emit('uncaughtException' as any, new Error('Cannot read properties of undefined'));

    expect(exitMock).toHaveBeenCalledWith(1);
    expect(stats.fatalErrorsCaught).toBe(1);
    expect(stats.transientErrorsCaught).toBe(0);

    dispose();
  });

  it('handles multiple transient errors without crashing', () => {
    const { stats, dispose } = installProcessGuard();

    // Simulate the exact error storm from the production crash
    for (let i = 0; i < 50; i++) {
      process.emit('unhandledRejection' as any, new Error('EventSource error'), Promise.resolve());
      process.emit('unhandledRejection' as any, new Error('Failed to fetch vtxos: Too Many Requests'), Promise.resolve());
      process.emit('unhandledRejection' as any, new Error('fetch failed'), Promise.resolve());
    }

    expect(exitMock).not.toHaveBeenCalled();
    expect(stats.transientErrorsCaught).toBe(150);

    dispose();
  });

  it('tracks lastTransientErrorAt timestamp', () => {
    const { stats, dispose } = installProcessGuard();

    process.emit('unhandledRejection' as any, new Error('ETIMEDOUT'), Promise.resolve());

    expect(stats.lastTransientErrorAt).not.toBeNull();
    const ts = new Date(stats.lastTransientErrorAt!);
    expect(ts.getTime()).toBeGreaterThan(Date.now() - 5000);

    dispose();
  });

  it('dispose removes handlers', () => {
    const { dispose } = installProcessGuard();

    dispose();

    // After dispose, no handlers should be installed
    expect(process.listenerCount('uncaughtException')).toBe(0);
    expect(process.listenerCount('unhandledRejection')).toBe(0);
  });
});
