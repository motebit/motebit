/**
 * Canonical JSON serialization.
 *
 * Lives in its own file (not in `index.ts`) so that other files inside
 * `@motebit/crypto` can import it without creating a circular dependency.
 * Specifically: `merkle.ts` needs `canonicalJson` to compute settlement
 * leaf hashes, but `index.ts` already imports from `merkle.ts` (it
 * re-exports the merkle helpers via the barrel). If `merkle.ts` imported
 * directly from `./index.js` for `canonicalJson`, the cycle would be:
 *
 *     index.ts → merkle.ts → index.ts
 *
 * Putting `canonicalJson` here breaks the cycle: both `index.ts` and
 * `merkle.ts` can import it directly from `./canonical.js` without
 * touching each other.
 *
 * The function itself is identical to the historical version in `index.ts`
 * — `index.ts` re-exports it from this module so external consumers see no
 * change. Pure, deterministic, no I/O, no global state.
 */

/**
 * Deterministic JSON serialization with sorted keys (recursive).
 * Produces identical output regardless of insertion order.
 *
 * Used by every signed-payload helper in `@motebit/crypto`: execution
 * receipts, identity files, succession records, settlement leaves, etc.
 * Two structurally-equal payloads always produce identical bytes here,
 * which is what makes the Ed25519 signatures verifiable.
 *
 * Matches JSON.stringify behavior in one respect: keys whose value is
 * `undefined` are omitted (not serialized as `"key":null`).
 */
export function canonicalJson(obj: unknown): string {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) {
    return "[" + obj.map((item) => canonicalJson(item)).join(",") + "]";
  }
  const sorted = Object.keys(obj as Record<string, unknown>).sort();
  const entries: string[] = [];
  for (const key of sorted) {
    const val = (obj as Record<string, unknown>)[key];
    if (val === undefined) continue; // Match JSON.stringify behavior: omit undefined
    entries.push(JSON.stringify(key) + ":" + canonicalJson(val));
  }
  return "{" + entries.join(",") + "}";
}
