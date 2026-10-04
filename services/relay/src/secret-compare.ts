/**
 * Constant-time comparison for shared secrets and bearer tokens.
 *
 * `===` on strings short-circuits at the first differing byte, so response
 * timing leaks how much of a guessed secret is right. Both sides are hashed to
 * fixed-length SHA-256 digests first, so `timingSafeEqual` always compares 32
 * bytes and the secret's length does not leak either.
 *
 * Fail-closed: an unset or empty `expected` never matches anything (an unset
 * operator secret must not authenticate an empty presentation).
 */
import { createHash, timingSafeEqual } from "node:crypto";

export function secretEquals(
  presented: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (expected == null || expected === "" || presented == null) return false;
  const a = createHash("sha256").update(presented, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}
