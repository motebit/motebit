/**
 * The pinned set of a hosting operator's signing keys —
 * `motebit/operator-signing-keys@1.0` (spec/repo-change-v1.md §9.1).
 *
 * Each pinned key carries the window it is trusted for: from its creation
 * (read from the key itself) until `trusted_until`, or open when that is
 * `null`. Retiring a key closes its window; the entry stays, so a landing
 * the key signed before then still verifies. Revocation and expiry inside
 * the OpenPGP key material are not read: this file is the trust decision.
 *
 * Strict and fail-closed: the file parses only in its one shape, and every
 * entry's armored block must hold exactly one primary key whose computed
 * fingerprint equals the entry's `fingerprint`.
 */
import { parsePinnedSigningKeys } from "@motebit/crypto-openpgp";
import type { PinnedSigningKey } from "@motebit/crypto-openpgp";

export const OPERATOR_SIGNING_KEYS_SPEC = "motebit/operator-signing-keys@1.0";

/** A pinned key and the end of its window. */
export interface OperatorSigningKey extends PinnedSigningKey {
  /** Seconds since the epoch: a committer time at or after it is not accepted. `null` = open. */
  readonly trustedUntil: number | null;
}

const FILE_KEYS = ["spec", "keys"] as const;
const ENTRY_KEYS = ["fingerprint", "armored", "trusted_until"] as const;
const FINGERPRINT = /^[0-9a-f]{40}$/;

function fail(detail: string): never {
  throw new Error(`operator signing keys: ${detail}`);
}

function exactKeys(o: unknown, keys: readonly string[], where: string): Record<string, unknown> {
  if (typeof o !== "object" || o === null || Array.isArray(o))
    fail(`${where} is not a JSON object`);
  const r = o as Record<string, unknown>;
  for (const k of keys) {
    if (!Object.prototype.hasOwnProperty.call(r, k)) fail(`${where}: missing key \`${k}\``);
  }
  for (const k of Object.keys(r)) {
    if (!keys.includes(k)) fail(`${where}: unknown key \`${k}\``);
  }
  return r;
}

/**
 * Parse a `motebit/operator-signing-keys@1.0` file strictly. Throws on invalid
 * JSON, a member name repeated within one object, a missing or unknown key,
 * a `spec` other than that string, an empty `keys`, a fingerprint that is
 * not 40 lowercase hex digits or is pinned twice, a `trusted_until` that is
 * neither `null` nor a non-negative safe integer, or an `armored` block that
 * does not hold exactly one key with that fingerprint.
 */
export function parseOperatorSigningKeys(text: string): OperatorSigningKey[] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error("operator signing keys: not valid JSON", { cause: err });
  }
  const repeated = repeatedMemberName(text);
  if (repeated !== null) fail(`member name ${JSON.stringify(repeated)} is repeated in one object`);
  const file = exactKeys(value, FILE_KEYS, "the file");
  if (file.spec !== OPERATOR_SIGNING_KEYS_SPEC) {
    fail(
      `\`spec\` is ${JSON.stringify(file.spec)}, not ${JSON.stringify(OPERATOR_SIGNING_KEYS_SPEC)}`,
    );
  }
  if (!Array.isArray(file.keys) || file.keys.length === 0) fail("`keys` is not a non-empty array");
  const seen = new Set<string>();
  return file.keys.map((raw: unknown, i): OperatorSigningKey => {
    const where = `keys[${i}]`;
    const e = exactKeys(raw, ENTRY_KEYS, where);
    const fp = e.fingerprint;
    if (typeof fp !== "string" || !FINGERPRINT.test(fp)) {
      fail(`${where}: \`fingerprint\` is not 40 lowercase hex digits`);
    }
    if (seen.has(fp)) fail(`${where}: fingerprint ${fp} is pinned twice`);
    seen.add(fp);
    const until = e.trusted_until;
    if (until !== null && !(Number.isSafeInteger(until) && (until as number) >= 0)) {
      fail(`${where}: \`trusted_until\` is neither null nor a non-negative integer of seconds`);
    }
    if (typeof e.armored !== "string") fail(`${where}: \`armored\` is not a string`);
    let keys: PinnedSigningKey[];
    try {
      keys = parsePinnedSigningKeys(e.armored);
    } catch (err) {
      throw new Error(`operator signing keys: ${where}: \`armored\` does not parse`, {
        cause: err,
      });
    }
    if (keys.length !== 1) fail(`${where}: \`armored\` holds ${keys.length} keys, not exactly one`);
    const key = keys[0]!;
    if (key.fingerprint !== fp) {
      fail(`${where}: \`armored\` holds key ${key.fingerprint}, not ${fp}`);
    }
    return { ...key, trustedUntil: until as number | null };
  });
}

/**
 * The first member name that occurs twice in one object of `text`, or null.
 * `JSON.parse` keeps the last of repeated names, so a later copy could
 * silently replace a window a reviewer read. The same scanner as
 * `@motebit/verifier`'s repo-path-policy.ts, kept local because that module
 * must import nothing and does not export it. `text` is already valid JSON.
 */
function repeatedMemberName(text: string): string | null {
  const stack: { names: Set<string> | null; expectName: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (c === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      if (top !== undefined && top.names !== null && top.expectName) {
        const name = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.names.has(name)) return name;
        top.names.add(name);
        top.expectName = false;
      }
      i = j;
    } else if (c === "{") {
      stack.push({ names: new Set(), expectName: true });
    } else if (c === "[") {
      stack.push({ names: null, expectName: false });
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === "," && top !== undefined && top.names !== null) {
      top.expectName = true;
    }
  }
  return null;
}
