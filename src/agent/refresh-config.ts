/**
 * Operator override for the RefreshAgent's safety margin.
 *
 * The margin decides how much time must remain before a VTXO's expiry for the agent to
 * renew it. Three days is the right steady-state value and stays the default. The override
 * exists for incidents: on 2026-07-26 a VTXO recovered from a deprecated-signer script sat
 * 84.6 hours from expiry, outside the 72-hour window, and renewing it meant either waiting
 * half a day or hand-rolling a settle against mainnet funds.
 *
 * Bounded on both sides. A value that is not a positive integer, or one past the 30-day
 * ceiling, falls back to the default rather than being honoured — an over-large margin makes
 * every VTXO look like it is expiring, which turns the agent into a permanent settle loop.
 */

/** Steady-state margin: renew when less than this remains before expiry. */
export const DEFAULT_SAFETY_MARGIN_MS = 3 * 24 * 60 * 60 * 1000;

/** Largest override accepted. Beyond this the value is treated as a typo. */
export const MAX_SAFETY_MARGIN_MS = 30 * 24 * 60 * 60 * 1000;

type Env = Record<string, string | undefined>;

export function resolveRefreshSafetyMarginMs(env: Env = process.env): number {
  const raw = env.GOLEM_REFRESH_SAFETY_MARGIN_MS;
  if (!raw) return DEFAULT_SAFETY_MARGIN_MS;

  // Reject anything that is not a plain positive integer — `Number` would happily accept
  // "1.5e3" and "Infinity", and a silently-coerced margin is worse than no override.
  if (!/^\d+$/.test(raw.trim())) return DEFAULT_SAFETY_MARGIN_MS;

  const value = Number(raw.trim());
  if (!Number.isSafeInteger(value) || value <= 0) return DEFAULT_SAFETY_MARGIN_MS;
  if (value > MAX_SAFETY_MARGIN_MS) return DEFAULT_SAFETY_MARGIN_MS;

  return value;
}
