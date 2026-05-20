/**
 * Property-based mutation tests for `verifyAndroidKeystoreAttestation`.
 *
 * Sibling of `packages/crypto-appattest/src/__tests__/properties.test.ts`
 * per the root CLAUDE.md sibling-boundary rule. `verify.test.ts` covers
 * a rich set of hand-written rejection cases (chain validity, non-CA
 * intermediate, expired cert, non-Google root, software-only security
 * level, unverified boot state, mismatched attestationApplicationId,
 * mismatched challenge, malformed DER, revocation snapshot hit). The
 * property tests below assert the universal cryptographic property:
 * **for any single mutation in the receipt body, the verifier MUST
 * return `valid: false`**.
 *
 * Receipt shape: `${leafB64}.${intermediatesJoinedB64}` (leaf-first
 * DER chain). The two property segments are the leaf and the
 * intermediates.
 *
 * ### Performance
 *
 * The verifier path is expensive (~5–10ms per call), so the strategy is:
 *
 *   1. Build ONE good fixture in `beforeAll` — paid once.
 *   2. Each property run mutates the receipt string and verifies; no
 *      chain rebuild per run.
 *   3. Property 4 (body-identity mismatch) DOES rebuild a chain per
 *      run because it needs a structurally well-formed receipt with a
 *      different body — capped at 15 runs to keep wall time bounded.
 *
 * ### Determinism
 *
 * Pinned seed 0x5eed matches semiring-laws / virtual-accounts / skills
 * / crypto-appattest shape for CI reproducibility, bisectable
 * counterexamples.
 */

import { describe, it, beforeAll, expect } from "vitest";
import fc from "fast-check";
import { verifyAndroidKeystoreAttestation } from "../verify.js";
import {
  APP_ID_BYTES,
  ATTESTED_AT,
  DEVICE_ID,
  FIXED_CLOCK,
  IDENT,
  MOTEBIT_ID,
  buildHappyPathFixture,
} from "./test-helpers.js";

const FC_SEED = 0x5eed;

interface SharedFixture {
  receipt: string;
  rootPem: string;
}

let fixture: SharedFixture;

beforeAll(async () => {
  fc.configureGlobal({ seed: FC_SEED, numRuns: 40 });
  fixture = await buildHappyPathFixture();
});

function verifyOpts(rootPemOverride?: string) {
  return {
    expectedIdentityPublicKeyHex: IDENT,
    expectedMotebitId: MOTEBIT_ID,
    expectedDeviceId: DEVICE_ID,
    expectedAttestedAt: ATTESTED_AT,
    expectedAttestationApplicationId: APP_ID_BYTES,
    rootPems: [rootPemOverride ?? fixture.rootPem],
    now: FIXED_CLOCK,
  };
}

/** Receipt is `${leafB64}.${intermediatesB64}`. Return char ranges per segment. */
function segmentBounds(receipt: string): {
  leaf: [number, number];
  intermediates: [number, number];
} {
  const dotIdx = receipt.indexOf(".");
  return {
    leaf: [0, dotIdx],
    intermediates: [dotIdx + 1, receipt.length],
  };
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");
const HEX_CHARS = "0123456789abcdef".split("");

// ── Property 1 — Leaf-segment mutation always detected ──────────────

describe("verifyAndroidKeystoreAttestation: mutation in leaf (first) segment is always detected", () => {
  it("any single-char substitution in the receipt's leaf segment yields valid:false", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 99_999 }),
        fc.constantFrom(...BASE64URL),
        async (positionSeed, newChar) => {
          const [start, end] = segmentBounds(fixture.receipt).leaf;
          const pos = start + (positionSeed % (end - start));
          if (fixture.receipt[pos] === newChar) return true; // no-op
          const mutated = fixture.receipt.slice(0, pos) + newChar + fixture.receipt.slice(pos + 1);
          const result = await verifyAndroidKeystoreAttestation(
            { platform: "android_keystore", attestation_receipt: mutated },
            verifyOpts(),
          );
          return result.valid === false;
        },
      ),
    );
  });
});

// ── Property 2 — Intermediate-segment mutation always detected ──────

describe("verifyAndroidKeystoreAttestation: mutation in intermediates (second) segment is always detected", () => {
  it("any single-char substitution in the receipt's intermediates segment yields valid:false", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 99_999 }),
        fc.constantFrom(...BASE64URL),
        async (positionSeed, newChar) => {
          const [start, end] = segmentBounds(fixture.receipt).intermediates;
          const pos = start + (positionSeed % (end - start));
          if (fixture.receipt[pos] === newChar) return true; // no-op
          const mutated = fixture.receipt.slice(0, pos) + newChar + fixture.receipt.slice(pos + 1);
          const result = await verifyAndroidKeystoreAttestation(
            { platform: "android_keystore", attestation_receipt: mutated },
            verifyOpts(),
          );
          return result.valid === false;
        },
      ),
    );
  });
});

// ── Property 3 — Truncation at any position always detected ─────────

describe("verifyAndroidKeystoreAttestation: truncation at any prefix length is always detected", () => {
  it("any prefix truncation strictly less than full length yields valid:false", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 99_999 }), async (truncSeed) => {
        const len = fixture.receipt.length;
        const truncTo = 1 + (truncSeed % (len - 1));
        const mutated = fixture.receipt.slice(0, truncTo);
        const result = await verifyAndroidKeystoreAttestation(
          { platform: "android_keystore", attestation_receipt: mutated },
          verifyOpts(),
        );
        return result.valid === false;
      }),
    );
  });
});

// ── Property 4 — Wrong identity in body always rejected ─────────────

describe("verifyAndroidKeystoreAttestation: body naming a different identity_public_key is always detected", () => {
  it("any well-formed body that names a different identity yields valid:false (identity_bound:false)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .array(fc.constantFrom(...HEX_CHARS), { minLength: 64, maxLength: 64 })
          .map((arr) => arr.join("")),
        async (wrongIdentHex) => {
          if (wrongIdentHex.toLowerCase() === IDENT.toLowerCase()) return true; // no-op
          // Full chain rebuild — body now names wrongIdent, verifier expects IDENT.
          const { receipt, rootPem } = await buildHappyPathFixture({
            identityPublicKeyHex: IDENT,
            bodyIdentityHex: wrongIdentHex,
          });
          const result = await verifyAndroidKeystoreAttestation(
            { platform: "android_keystore", attestation_receipt: receipt },
            verifyOpts(rootPem),
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
describe("verifyAndroidKeystoreAttestation: positive control (unmutated fixture verifies)", () => {
  it("the unmutated fixture used for property tests verifies as valid", async () => {
    const result = await verifyAndroidKeystoreAttestation(
      { platform: "android_keystore", attestation_receipt: fixture.receipt },
      verifyOpts(),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
