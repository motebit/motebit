/**
 * Property-based mutation tests for `verifyWebAuthnAttestation`.
 *
 * Sibling of `packages/crypto-appattest/src/__tests__/properties.test.ts`
 * and `packages/crypto-android-keystore/src/__tests__/properties.test.ts`
 * per the root CLAUDE.md sibling-boundary rule. `verify.test.ts` covers
 * a rich set of hand-written rejection cases (malformed CBOR, wrong
 * fmt, missing x5c, non-CA intermediate, wrong rpIdHash, mismatched
 * challenge, forged signature, wrong identity in body, self-attestation
 * with mismatched COSE key). The property tests below assert the
 * universal cryptographic property: **for any single mutation in the
 * receipt body, the verifier MUST return `valid: false`**.
 *
 * Receipt shape: `${attestationObjectB64}.${clientDataJSONB64}`. The
 * two property segments are the attestation object (CBOR-encoded `fmt`
 * + `attStmt` + `authData`) and the clientDataJSON (`type`, `challenge`,
 * `origin`).
 *
 * ### Performance
 *
 * The verifier path is expensive (~5–10ms per call), so the strategy is:
 *
 *   1. Build ONE good full-attestation fixture in `beforeAll` — paid
 *      once.
 *   2. Each property run mutates the receipt string and verifies; no
 *      chain rebuild per run.
 *   3. Property 4 (body-identity mismatch) DOES rebuild a chain per
 *      run because it needs a structurally well-formed receipt with a
 *      different body — capped at 15 runs to keep wall time bounded.
 *
 * ### Determinism
 *
 * Pinned seed 0x5eed matches semiring-laws / virtual-accounts / skills
 * / crypto-appattest / crypto-android-keystore shape for CI
 * reproducibility, bisectable counterexamples.
 */

import { describe, it, beforeAll, expect } from "vitest";
import fc from "fast-check";
import { verifyWebAuthnAttestation } from "../verify.js";
import {
  ATTESTED_AT,
  DEVICE_ID,
  IDENT,
  MOTEBIT_ID,
  ORIGIN,
  RP,
  buildFullAttestationFixture,
} from "./test-helpers.js";

const FC_SEED = 0x5eed;

interface SharedFixture {
  receipt: string;
  rootPem: string;
}

let fixture: SharedFixture;

beforeAll(async () => {
  fc.configureGlobal({ seed: FC_SEED, numRuns: 40 });
  fixture = await buildFullAttestationFixture({
    rpId: RP,
    origin: ORIGIN,
    identityPublicKeyHex: IDENT,
    motebitId: MOTEBIT_ID,
    deviceId: DEVICE_ID,
    attestedAt: ATTESTED_AT,
  });
});

function verifyOpts(rootPemOverride?: string) {
  return {
    expectedRpId: RP,
    expectedIdentityPublicKeyHex: IDENT,
    expectedMotebitId: MOTEBIT_ID,
    expectedDeviceId: DEVICE_ID,
    expectedAttestedAt: ATTESTED_AT,
    rootPems: [rootPemOverride ?? fixture.rootPem],
    now: () => new Date("2026-04-22").getTime(),
  };
}

/** Receipt is `${attestationObjectB64}.${clientDataJSONB64}`. */
function segmentBounds(receipt: string): {
  attestation: [number, number];
  clientData: [number, number];
} {
  const dotIdx = receipt.indexOf(".");
  return {
    attestation: [0, dotIdx],
    clientData: [dotIdx + 1, receipt.length],
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
 * `[start, end-1)` rather than `[start, end)`.
 */
function pickMutPos(start: number, end: number, seed: number): number {
  const segLen = end - start;
  if (segLen <= 1) return start;
  return start + (seed % (segLen - 1));
}

// ── Property 1 — Attestation-object mutation always detected ────────

describe("verifyWebAuthnAttestation: mutation in attestation-object (first) segment is always detected", () => {
  it("any single-char substitution in the attestation-object segment yields valid:false", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 99_999 }),
        fc.constantFrom(...BASE64URL),
        async (positionSeed, newChar) => {
          const [start, end] = segmentBounds(fixture.receipt).attestation;
          const pos = pickMutPos(start, end, positionSeed);
          if (fixture.receipt[pos] === newChar) return true; // no-op
          const mutated = fixture.receipt.slice(0, pos) + newChar + fixture.receipt.slice(pos + 1);
          const result = await verifyWebAuthnAttestation(
            { platform: "webauthn", attestation_receipt: mutated },
            verifyOpts(),
          );
          return result.valid === false;
        },
      ),
    );
  });
});

// ── Property 2 — clientDataJSON mutation always detected ────────────

describe("verifyWebAuthnAttestation: mutation in clientDataJSON (second) segment is always detected", () => {
  it("any single-char substitution in the clientDataJSON segment yields valid:false", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.nat({ max: 99_999 }),
        fc.constantFrom(...BASE64URL),
        async (positionSeed, newChar) => {
          const [start, end] = segmentBounds(fixture.receipt).clientData;
          const pos = pickMutPos(start, end, positionSeed);
          if (fixture.receipt[pos] === newChar) return true; // no-op
          const mutated = fixture.receipt.slice(0, pos) + newChar + fixture.receipt.slice(pos + 1);
          const result = await verifyWebAuthnAttestation(
            { platform: "webauthn", attestation_receipt: mutated },
            verifyOpts(),
          );
          return result.valid === false;
        },
      ),
    );
  });
});

// ── Property 3 — Truncation at any position always detected ─────────

describe("verifyWebAuthnAttestation: truncation at any prefix length is always detected", () => {
  it("any prefix truncation strictly less than full length yields valid:false", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 99_999 }), async (truncSeed) => {
        const len = fixture.receipt.length;
        const truncTo = 1 + (truncSeed % (len - 1));
        const mutated = fixture.receipt.slice(0, truncTo);
        const result = await verifyWebAuthnAttestation(
          { platform: "webauthn", attestation_receipt: mutated },
          verifyOpts(),
        );
        return result.valid === false;
      }),
    );
  });
});

// ── Property 4 — Wrong identity in body always rejected ─────────────

describe("verifyWebAuthnAttestation: body naming a different identity_public_key is always detected", () => {
  it("any well-formed body that names a different identity yields valid:false (identity_bound:false)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .array(fc.constantFrom(...HEX_CHARS), { minLength: 64, maxLength: 64 })
          .map((arr) => arr.join("")),
        async (wrongIdentHex) => {
          if (wrongIdentHex.toLowerCase() === IDENT.toLowerCase()) return true; // no-op
          // Full chain rebuild — body now names wrongIdent, verifier expects IDENT.
          const tampered = await buildFullAttestationFixture({
            rpId: RP,
            origin: ORIGIN,
            identityPublicKeyHex: IDENT,
            tamperedBodyIdentityHex: wrongIdentHex,
            motebitId: MOTEBIT_ID,
            deviceId: DEVICE_ID,
            attestedAt: ATTESTED_AT,
          });
          const result = await verifyWebAuthnAttestation(
            { platform: "webauthn", attestation_receipt: tampered.receipt },
            verifyOpts(tampered.rootPem),
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
describe("verifyWebAuthnAttestation: positive control (unmutated fixture verifies)", () => {
  it("the unmutated fixture used for property tests verifies as valid", async () => {
    const result = await verifyWebAuthnAttestation(
      { platform: "webauthn", attestation_receipt: fixture.receipt },
      verifyOpts(),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
