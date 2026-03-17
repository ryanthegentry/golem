/**
 * Process-level error guards for long-running daemons (gateway, serve).
 *
 * Prevents process termination from transient upstream errors like:
 * - ASP rate limiting (429) causing EventSource unhandled rejections
 * - SDK subscription errors propagating as uncaught exceptions
 * - Boltz API errors during background polling
 *
 * Short-lived CLI commands should NOT use this — they should exit on error.
 * Only long-running processes (gateway, serve) should install these guards.
 */

/** Transient error patterns that should be logged but never kill the process. */
const TRANSIENT_PATTERNS = [
  'Too Many Requests',
  'EventSource',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'fetch failed',
  'socket hang up',
  'network timeout',
  'Bad Gateway',
  'Service Unavailable',
  'getaddrinfo',
  'EHOSTUNREACH',
] as const;

function isTransient(message: string): boolean {
  return TRANSIENT_PATTERNS.some(p => message.includes(p));
}

export interface ProcessGuardStats {
  transientErrorsCaught: number;
  fatalErrorsCaught: number;
  lastTransientError: string | null;
  lastTransientErrorAt: string | null;
}

/**
 * Install process-level error guards that prevent transient errors from
 * killing a long-running daemon.
 *
 * - Transient errors (network, rate-limit, etc.) are logged and swallowed.
 * - Truly fatal errors (syntax, type, out of memory) still terminate.
 *
 * Returns a stats object for monitoring and a dispose function to uninstall.
 */
export function installProcessGuard(): { stats: ProcessGuardStats; dispose: () => void } {
  const stats: ProcessGuardStats = {
    transientErrorsCaught: 0,
    fatalErrorsCaught: 0,
    lastTransientError: null,
    lastTransientErrorAt: null,
  };

  const onUncaughtException = (err: Error) => {
    const message = err?.message ?? String(err);
    if (isTransient(message)) {
      stats.transientErrorsCaught++;
      stats.lastTransientError = message;
      stats.lastTransientErrorAt = new Date().toISOString();
      console.warn(`[guard] Transient uncaught exception suppressed: ${message}`);
      return;
    }
    // Fatal — log and exit
    stats.fatalErrorsCaught++;
    console.error(`[guard] Fatal uncaught exception — shutting down: ${message}`);
    console.error(err.stack);
    process.exit(1);
  };

  const onUnhandledRejection = (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    if (isTransient(message)) {
      stats.transientErrorsCaught++;
      stats.lastTransientError = message;
      stats.lastTransientErrorAt = new Date().toISOString();
      console.warn(`[guard] Transient unhandled rejection suppressed: ${message}`);
      return;
    }
    // Fatal — log and exit
    stats.fatalErrorsCaught++;
    console.error(`[guard] Fatal unhandled rejection — shutting down: ${message}`);
    if (reason instanceof Error && reason.stack) {
      console.error(reason.stack);
    }
    process.exit(1);
  };

  // Remove any existing handlers before installing ours
  process.removeAllListeners('uncaughtException');
  process.removeAllListeners('unhandledRejection');

  process.on('uncaughtException', onUncaughtException);
  process.on('unhandledRejection', onUnhandledRejection);

  return {
    stats,
    dispose: () => {
      process.removeListener('uncaughtException', onUncaughtException);
      process.removeListener('unhandledRejection', onUnhandledRejection);
    },
  };
}
