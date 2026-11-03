/**
 * `motebit/operator-signing-keys@1.0` (spec/repo-change-v1.md §9.1): the
 * pinned set of a hosting operator's keys, each with its window. Parsed
 * strictly; every refusal below throws.
 */
import { describe, expect, it } from "vitest";

import { OPERATOR_SIGNING_KEYS_SPEC, parseOperatorSigningKeys } from "../git/operator-keys.js";
import { testSigningKey } from "./helpers/github-signer.js";

const A = testSigningKey();
const B = testSigningKey();

function entry(key = A, trusted_until: unknown = null): Record<string, unknown> {
  return { fingerprint: key.fingerprint, armored: key.armored, trusted_until };
}
function file(keys: unknown, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ spec: OPERATOR_SIGNING_KEYS_SPEC, keys, ...extra });
}

describe("the pinned set file", () => {
  it("reads each key with its window: open, or closed at trusted_until", () => {
    const keys = parseOperatorSigningKeys(file([entry(A), entry(B, 1_700_000_000)]));
    expect(keys.map((k) => [k.fingerprint, k.trustedUntil])).toEqual([
      [A.fingerprint, null],
      [B.fingerprint, 1_700_000_000],
    ]);
    expect(keys[0]!.createdAt).toBeTypeOf("number");
  });

  it("reads a trusted_until written as plain digits, up to 2^53 - 1", () => {
    for (const n of [0, 1_800_000_000, Number.MAX_SAFE_INTEGER]) {
      expect(parseOperatorSigningKeys(file([entry(A, n)]))[0]!.trustedUntil).toBe(n);
    }
  });

  it.each<[string, string, RegExp]>([
    ["invalid JSON", "{", /not valid JSON/],
    ["not an object", "[]", /the file is not a JSON object/],
    [
      "a member name repeated at the top",
      `{"spec":"${OPERATOR_SIGNING_KEYS_SPEC}","keys":[],"keys":[]}`,
      /member name "keys" is repeated/,
    ],
    [
      "a member name repeated in an entry",
      file([entry()]).replace('"trusted_until":null', '"trusted_until":null,"trusted_until":1'),
      /member name "trusted_until" is repeated/,
    ],
    ["a missing key", JSON.stringify({ spec: OPERATOR_SIGNING_KEYS_SPEC }), /missing key `keys`/],
    ["an unknown key", file([entry()], { note: "x" }), /unknown key `note`/],
    ["another spec", file([entry()], { spec: "motebit/operator-signing-keys@2.0" }), /`spec` is/],
    ["keys not an array", file({}), /`keys` is not a non-empty array/],
    ["no keys", file([]), /`keys` is not a non-empty array/],
    ["an entry not an object", file(["x"]), /keys\[0\] is not a JSON object/],
    [
      "an entry missing trusted_until",
      file([{ fingerprint: A.fingerprint, armored: A.armored }]),
      /missing key `trusted_until`/,
    ],
    ["an unknown entry key", file([{ ...entry(), created: 1 }]), /unknown key `created`/],
    [
      "an uppercase fingerprint",
      file([{ ...entry(), fingerprint: A.fingerprint.toUpperCase() }]),
      /40 lowercase hex/,
    ],
    [
      "a short fingerprint",
      file([{ ...entry(), fingerprint: A.fingerprint.slice(1) }]),
      /40 lowercase hex/,
    ],
    ["a fingerprint not a string", file([{ ...entry(), fingerprint: 1 }]), /40 lowercase hex/],
    ["a key pinned twice", file([entry(A), entry(A, 5)]), /pinned twice/],
    ["a negative trusted_until", file([entry(A, -1)]), /the number -1 is not written/],
    ["a fractional trusted_until", file([entry(A, 1.5)]), /the number 1.5 is not written/],
    ["a string trusted_until", file([entry(A, "1")]), /trusted_until/],
    ["an unsafe trusted_until", file([entry(A, 2 ** 53)]), /trusted_until/],
    ...(
      ["1800000000.0000001", "4503599627370496.5", "1e-400", "1e3", "1E3", "1.0", "-0"] as const
    ).map((n): [string, string, RegExp] => [
      `a trusted_until written ${n}`,
      file([entry()]).replace('"trusted_until":null', `"trusted_until":${n}`),
      /is not written as a plain non-negative integer/,
    ]),
    [
      "a trusted_until with a leading zero (not JSON)",
      file([entry()]).replace('"trusted_until":null', '"trusted_until":01'),
      /not valid JSON/,
    ],
    ["armored not a string", file([{ ...entry(), armored: 1 }]), /`armored` is not a string/],
    [
      "armored that does not parse",
      file([{ ...entry(), armored: "x" }]),
      /`armored` does not parse/,
    ],
    [
      "armored holding two keys",
      file([{ ...entry(), armored: `${A.armored}\n${B.armored}` }]),
      /holds 2 keys, not exactly one/,
    ],
    [
      "armored holding another key than the fingerprint",
      file([{ ...entry(), armored: B.armored }]),
      /holds key [0-9a-f]{40}, not/,
    ],
  ])("refuses %s", (_name, text, reason) => {
    expect(() => parseOperatorSigningKeys(text)).toThrow(reason);
  });
});
