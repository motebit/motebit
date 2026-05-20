/**
 * Property-based mutation tests for `verifyAppAttestReceipt`.
 *
 * `verify.test.ts` covers a rich set of hand-written rejection cases:
 * rpIdHash mismatch, root mismatch, wrong `fmt`, nonce-binding payload
 * tampering, identity-hash mismatch, expired cert window, swapped
 * non-self-signed root, malformed PEM, non-CA intermediate, malformed
 * CBOR, missing nonce extension. The property tests below complement
 * those by asserting the universal cryptographic property: **for any
 * single mutation in the receipt body, the verifier MUST return
 * `valid: false`**. This catches the failure modes example tests
 * structurally miss — positions in the byte stream that no hand-written
 * case happens to exercise.
 *
 * ### Performance
 *
 * The full verifier path is expensive (~5–10ms per call including chain
 * parse + signature verify), so the strategy is:
 *
 *   1. Build ONE good fixture in `beforeAll` — paid once.
 *   2. Each property run mutates the receipt string and verifies; no
 *      chain rebuild per run.
 *   3. Property 4 (body-identity mismatch) DOES rebuild a chain per run
 *      because it needs a structurally well-formed receipt with a
 *      different body — capped at 15 runs to keep wall time bounded.
 *
 * ### Determinism
 *
 * Pinned seed 0x5eed matches semiring-laws / virtual-accounts / skills
 * shape for CI reproducibility, bisectable counterexamples.
 */

import { describe, it, beforeAll, expect } from "vitest";
import fc from "fast-check";
import { verifyAppAttestReceipt } from "../verify.js";
import { ATTESTED_AT, BUNDLE, DEVICE_ID, IDENT, MOTEBIT_ID, buildFixture } from "./test-helpers.js";

const FC_SEED = 0x5eed;

interface SharedFixture {
  receipt: string;
  rootPem: string;
}

let fixture: SharedFixture;

beforeAll(async () => {
  fc.configureGlobal({ seed: FC_SEED, numRuns: 40 });
  const { receipt, chain } = await buildFixture({
    bundleId: BUNDLE,
    identityPublicKeyHex: IDENT,
    motebitId: MOTEBIT_ID,
    deviceId: DEVICE_ID,
    attestedAt: ATTESTED_AT,
  });
  fixture = { receipt, rootPem: chain.rootPem };
});

function verifyOpts(rootPemOverride?: string) {
  return {
    expectedBundleId: BUNDLE,
    expectedIdentityPublicKeyHex: IDENT,
    expectedMotebitId: MOTEBIT_ID,
    expectedDeviceId: DEVICE_ID,
    expectedAttestedAt: ATTESTED_AT,
    rootPem: rootPemOverride ?? fixture.rootPem,
    now: () => new Date("2026-04-22").getTime(),
  };
}

/** Receipt is `${cborB64}.${keyIdB64}.${cdhB64}`. Return char ranges per segment. */
function segmentBounds(receipt: string): {
  cbor: [number, number];
  keyId: [number, number];
  cdh: [number, number];
} {
  const parts = receipt.split(".");
  const cborEnd = parts[0]!.length;
  const keyIdEnd = cborEnd + 1 + parts[1]!.length;
  return {
    cbor: [0, cborEnd],
    keyId: [cborEnd + 1, keyIdEnd],
    cdh: [keyIdEnd + 1, receipt.length],
  };
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");
const HEX_CHARS = "0123456789abcdef".split("");

// ── Property 1 — CBOR-segment mutation always detected ──────────────

describe("verifyAppAttestReceipt: mutation in CBOR (first) segment is always detected", () => {
  it("any single-char substitution in the receipt's CBOR segment yields valid:false", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 99_999 }),
        fc.constantFrom(...BASE64URL),
        async (positionSeed, newChar) => {
          const [start, end] = segmentBounds(fixture.receipt).cbor;
          const pos = start + (positionSeed % (end - start));
          if (fixture.receipt[pos] === newChar) return true; // no-op
          const mutated = fixture.receipt.slice(0, pos) + newChar + fixture.receipt.slice(pos + 1);
          const result = await verifyAppAttestReceipt(
            { platform: "device_check", attestation_receipt: mutated },
            verifyOpts(),
          );
          return result.valid === false;
        },
      ),
    );
  });
});

// ── Property 2 — clientDataHash-segment mutation always detected ────

describe("verifyAppAttestReceipt: mutation in clientDataHash (third) segment is always detected", () => {
  it("any single-char substitution in the receipt's clientDataHash segment yields valid:false", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 99_999 }),
        fc.constantFrom(...BASE64URL),
        async (positionSeed, newChar) => {
          const [start, end] = segmentBounds(fixture.receipt).cdh;
          const pos = start + (positionSeed % (end - start));
          if (fixture.receipt[pos] === newChar) return true; // no-op
          const mutated = fixture.receipt.slice(0, pos) + newChar + fixture.receipt.slice(pos + 1);
          const result = await verifyAppAttestReceipt(
            { platform: "device_check", attestation_receipt: mutated },
            verifyOpts(),
          );
          return result.valid === false;
        },
      ),
    );
  });
});

// ── Property 3 — Truncation at any position always detected ─────────

describe("verifyAppAttestReceipt: truncation at any prefix length is always detected", () => {
  it("any prefix truncation strictly less than full length yields valid:false", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 99_999 }), async (truncSeed) => {
        const len = fixture.receipt.length;
        const truncTo = 1 + (truncSeed % (len - 1));
        const mutated = fixture.receipt.slice(0, truncTo);
        const result = await verifyAppAttestReceipt(
          { platform: "device_check", attestation_receipt: mutated },
          verifyOpts(),
        );
        return result.valid === false;
      }),
    );
  });
});

// ── Property 4 — Wrong identity in body always rejected ─────────────

describe("verifyAppAttestReceipt: body naming a different identity_public_key is always detected", () => {
  it("any well-formed body that names a different identity yields valid:false (identity_bound:false)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .array(fc.constantFrom(...HEX_CHARS), { minLength: 64, maxLength: 64 })
          .map((arr) => arr.join("")),
        async (wrongIdentHex) => {
          if (wrongIdentHex.toLowerCase() === IDENT.toLowerCase()) return true; // no-op
          // Full chain rebuild — body now names wrongIdent, verifier expects IDENT.
          const { receipt, chain } = await buildFixture({
            bundleId: BUNDLE,
            identityPublicKeyHex: IDENT,
            bodyIdentityHex: wrongIdentHex,
            motebitId: MOTEBIT_ID,
            deviceId: DEVICE_ID,
            attestedAt: ATTESTED_AT,
          });
          const result = await verifyAppAttestReceipt(
            { platform: "device_check", attestation_receipt: receipt },
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

// Pinned smoke catches a regression where the fixture builder produces
// a receipt the verifier rejects (which would render every property
// above trivially-passing — they all assert `valid: false`).
describe("verifyAppAttestReceipt: positive control (unmutated fixture verifies)", () => {
  it("the unmutated fixture used for property tests verifies as valid", async () => {
    const result = await verifyAppAttestReceipt(
      { platform: "device_check", attestation_receipt: fixture.receipt },
      verifyOpts(),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
