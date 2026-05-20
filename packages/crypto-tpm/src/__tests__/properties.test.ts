/**
 * Property-based mutation tests for `verifyTpmQuote`.
 *
 * Sibling of the property suites in `packages/crypto-appattest`,
 * `packages/crypto-android-keystore`, and `packages/crypto-webauthn` per
 * the root CLAUDE.md sibling-boundary rule. `verify.test.ts` covers a
 * rich set of hand-written rejection cases (malformed magic, wrong
 * structure tag, signature over tampered bytes, non-CA intermediate,
 * non-vendor root, expired cert, identity-hash mismatch). The property
 * tests below assert the universal cryptographic property: **for any
 * single mutation in the receipt body, the verifier MUST return
 * `valid: false`**.
 *
 * Receipt shape: four base64url segments separated by `.`:
 *   `${attestB64}.${signatureB64}.${leafDerB64}.${intermediateDerB64}`
 *
 * The TPM receipt is the longest of the four hardware-attestation
 * receipts (the AK signature segment alone is ~70 bytes pre-base64),
 * so we cover all four segments individually.
 *
 * ### Performance
 *
 * The verifier path is expensive (~5–10ms per call), so the strategy is:
 *
 *   1. Build ONE good fixture in `beforeAll` — paid once.
 *   2. Each property run mutates the receipt string and verifies; no
 *      chain rebuild per run.
 *   3. Property 5 (body-identity mismatch) DOES rebuild a chain per
 *      run — capped at 15 runs.
 *
 * ### Determinism
 *
 * Pinned seed 0x5eed matches semiring-laws / virtual-accounts / skills
 * / crypto-appattest / crypto-android-keystore / crypto-webauthn shape
 * for CI reproducibility, bisectable counterexamples.
 */

import { describe, it, beforeAll, expect } from "vitest";
import fc from "fast-check";
import { verifyTpmQuote } from "../verify.js";
import {
  ATTESTED_AT,
  DEVICE_ID,
  FIXED_NOW,
  IDENT,
  MOTEBIT_ID,
  buildFixture,
} from "./test-helpers.js";

const FC_SEED = 0x5eed;

interface SharedFixture {
  receipt: string;
  rootPem: string;
}

let fixture: SharedFixture;

beforeAll(async () => {
  fc.configureGlobal({ seed: FC_SEED, numRuns: 40 });
  const { receipt, chain } = await buildFixture({ identityPublicKeyHex: IDENT });
  fixture = { receipt, rootPem: chain.rootPem };
});

function verifyOpts(rootPemOverride?: string) {
  return {
    expectedIdentityPublicKeyHex: IDENT,
    expectedMotebitId: MOTEBIT_ID,
    expectedDeviceId: DEVICE_ID,
    expectedAttestedAt: ATTESTED_AT,
    rootPems: [rootPemOverride ?? fixture.rootPem],
    now: FIXED_NOW,
  };
}

/** Receipt is four dot-separated segments. */
function segmentBounds(receipt: string): {
  attest: [number, number];
  signature: [number, number];
  leaf: [number, number];
  intermediate: [number, number];
} {
  const dots: number[] = [];
  for (let i = 0; i < receipt.length; i++) {
    if (receipt[i] === ".") dots.push(i);
  }
  if (dots.length !== 3) throw new Error(`expected 3 dots in TPM receipt; got ${dots.length}`);
  return {
    attest: [0, dots[0]!],
    signature: [dots[0]! + 1, dots[1]!],
    leaf: [dots[1]! + 1, dots[2]!],
    intermediate: [dots[2]! + 1, receipt.length],
  };
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");
const HEX_CHARS = "0123456789abcdef".split("");

/**
 * Pick a mutation position within a base64url segment, EXCLUDING the
 * last char. base64url has trailing-bit ambiguity at the end of a
 * segment whose length is not a multiple of 4: the last char's unused
 * low-order bits don't affect the decoded byte stream, so a single-char
 * mutation there can decode to identical bytes and be a structural
 * no-op. Avoid that case by capping mutation positions to
 * `[start, end-1)`. Sibling helper to the same-named function in
 * `crypto-appattest`, `crypto-android-keystore`, `crypto-webauthn`.
 */
function pickMutPos(start: number, end: number, seed: number): number {
  const segLen = end - start;
  if (segLen <= 1) return start;
  return start + (seed % (segLen - 1));
}

async function assertSegmentMutation(segName: "attest" | "signature" | "leaf" | "intermediate") {
  await fc.assert(
    fc.asyncProperty(
      fc.nat({ max: 99_999 }),
      fc.constantFrom(...BASE64URL),
      async (positionSeed, newChar) => {
        const [start, end] = segmentBounds(fixture.receipt)[segName];
        const pos = pickMutPos(start, end, positionSeed);
        if (fixture.receipt[pos] === newChar) return true; // no-op
        const mutated = fixture.receipt.slice(0, pos) + newChar + fixture.receipt.slice(pos + 1);
        const result = await verifyTpmQuote(
          { platform: "tpm", attestation_receipt: mutated },
          verifyOpts(),
        );
        return result.valid === false;
      },
    ),
  );
}

// ── Property 1-4 — Per-segment mutation always detected ─────────────

describe("verifyTpmQuote: mutation in any segment is always detected", () => {
  it("attest (1st) segment: any single-char substitution yields valid:false", async () => {
    await assertSegmentMutation("attest");
  });
  it("signature (2nd) segment: any single-char substitution yields valid:false", async () => {
    await assertSegmentMutation("signature");
  });
  it("leaf-cert (3rd) segment: any single-char substitution yields valid:false", async () => {
    await assertSegmentMutation("leaf");
  });
  it("intermediate-cert (4th) segment: any single-char substitution yields valid:false", async () => {
    await assertSegmentMutation("intermediate");
  });
});

// ── Property 5 — Truncation always detected ─────────────────────────

describe("verifyTpmQuote: truncation at any prefix length is always detected", () => {
  it("any prefix truncation strictly less than full length yields valid:false", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 99_999 }), async (truncSeed) => {
        const len = fixture.receipt.length;
        const truncTo = 1 + (truncSeed % (len - 1));
        const mutated = fixture.receipt.slice(0, truncTo);
        const result = await verifyTpmQuote(
          { platform: "tpm", attestation_receipt: mutated },
          verifyOpts(),
        );
        return result.valid === false;
      }),
    );
  });
});

// ── Property 6 — Wrong identity in body always rejected ─────────────

describe("verifyTpmQuote: body naming a different identity_public_key is always detected", () => {
  it("any well-formed body that names a different identity yields valid:false (identity_bound:false)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .array(fc.constantFrom(...HEX_CHARS), { minLength: 64, maxLength: 64 })
          .map((arr) => arr.join("")),
        async (wrongIdentHex) => {
          if (wrongIdentHex.toLowerCase() === IDENT.toLowerCase()) return true; // no-op
          // Full chain rebuild — extraData now binds wrongIdent, verifier expects IDENT.
          const { receipt, chain } = await buildFixture({
            identityPublicKeyHex: IDENT,
            bodyIdentityHex: wrongIdentHex,
          });
          const result = await verifyTpmQuote(
            { platform: "tpm", attestation_receipt: receipt },
            verifyOpts(chain.rootPem),
          );
          return result.valid === false && result.identity_bound === false;
        },
      ),
      { numRuns: 15 }, // expensive — full chain rebuild per run
    );
  });
});

// ── Sanity smoke: the good fixture still verifies ───────────────────

describe("verifyTpmQuote: positive control (unmutated fixture verifies)", () => {
  it("the unmutated fixture used for property tests verifies as valid", async () => {
    const result = await verifyTpmQuote(
      { platform: "tpm", attestation_receipt: fixture.receipt },
      verifyOpts(),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
