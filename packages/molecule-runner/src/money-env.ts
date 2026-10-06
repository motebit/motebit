/**
 * The one reading of a money-denominated environment variable (a spend
 * ceiling, a sweep floor, a budget in micro-units).
 *
 * `raw` is the variable's value as the caller read it (`process.env.X`, read
 * at the call site so deploy-parity sees it); `name` is only for the message.
 * Unset keeps the caller's documented default. Anything SET — including the
 * empty string — must be a plain non-negative decimal integer no larger than
 * 2^53−1, or this throws, so the service refuses to boot rather than run on a
 * value it guessed. `parseInt` / `Number` / `BigInt` each read some malformed
 * spelling as a number (`parseInt("12abc")` is 12, `parseInt("")` is NaN,
 * `Number("")` and `BigInt("")` are 0), and a NaN limit signed into a grant
 * canonicalizes to `null` and still verifies.
 */
export function parseMicroEnv(name: string, raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const trimmed = raw.trim();
  const n = /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
  if (!Number.isSafeInteger(n)) {
    throw new Error(
      `${name} must be a non-negative integer number of micro-units (at most ${String(
        Number.MAX_SAFE_INTEGER,
      )}), got ${JSON.stringify(raw)}. Unset it to use the default (${String(fallback)}).`,
    );
  }
  return n;
}
