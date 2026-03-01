/**
 * Constant-time string comparison for Bearer token validation.
 *
 * Uses crypto.timingSafeEqual to prevent timing side-channel attacks
 * on API key checks. Handles unequal lengths safely by comparing
 * against a fixed-length digest.
 */

import { timingSafeEqual, createHash } from 'node:crypto';

/**
 * Constant-time comparison of two strings.
 *
 * Hashes both inputs with SHA-256 before comparing, so the comparison
 * time is independent of string length or content. This prevents
 * timing attacks that could reveal the API key byte-by-byte.
 */
export function timingSafeCompare(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();
  return timingSafeEqual(hashA, hashB);
}

/**
 * Validate a Bearer token from an Authorization header.
 * Returns true if the header matches "Bearer <expectedKey>".
 */
export function validateBearerToken(authHeader: string | undefined, expectedKey: string): boolean {
  if (!authHeader) return false;
  if (!authHeader.startsWith('Bearer ')) return false;
  const token = authHeader.slice(7);
  return timingSafeCompare(token, expectedKey);
}
