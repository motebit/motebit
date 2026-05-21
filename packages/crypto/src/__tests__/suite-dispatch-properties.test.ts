/**
 * Property-based laws for the proof-composability root.
 *
 * The CLAUDE.md principle "Proof composability" states it as an absolute:
 * "Canonical JSON → SHA-256 → Ed25519 verify. Always." Every signed
 * artifact in motebit — `ExecutionReceipt`, `ToolInvocationReceipt`,
 * `ContentArtifactManifest`, `AgentTrustCredential`, delegation receipts,
 * succession chains, deletion certificates, hardware-attestation claims,
 * state-export envelopes — flows through `signBySuite` / `verifyBySuite`
 * and `canonicalJson`. If any of the universal laws below fail, the
 * entire self-attesting system is unsound at the root: a tampered
 * artifact could verify, or a valid one could be rejected.
 *
 * Existing tests (`receipts.test.ts`, `verify-artifacts.test.ts`,
 * `receipt-chain.test.ts`, …) exercise the sign/verify path with
 * hand-picked artifacts. The property suite below asserts the universal
 * cryptographic laws across arbitrary message bytes, key orderings, and
 * every registered Ed25519 `SuiteId` — the cases hand-written tests
 * structurally cannot exhaust.
 *
 * The four crypto-* hardware-attestation verifier packages already carry
 * mutation property suites (any receipt mutation → reject). This suite
 * is the floor beneath them: the core `@motebit/crypto` primitive those
 * verifiers — and everything else — are built on.
 *
 * Sibling pattern to `semiring-laws.test.ts` / `sensitivity-laws.test.ts`
 * (algebraic laws) and the crypto-* mutation suites. Per
 * `docs/doctrine/evals-as-attestations.md` § "What ships now", these
 * ship as testing-only artifacts under the existing package surface.
 *
 * Pinned seed 0x5eed matches the rest of the property-test floor for CI
 * reproducibility, bisectable counterexamples.
 */

import { describe, it, beforeAll, expect } from "vitest";
import fc from "fast-check";
import { ALL_SUITE_IDS } from "@motebit/protocol";
import type { SuiteId } from "@motebit/protocol";
import { signBySuite, verifyBySuite, generateEd25519Keypair } from "../suite-dispatch.js";
import { canonicalJson } from "../signing.js";

const FC_SEED = 0x5eed;

// One keypair pair, generated once. Key generation is async + relatively
// expensive; the laws under test vary the MESSAGE, not the key, so a
// fixed keypair (plus a second for wrong-key tests) is sufficient.
let keyA: { publicKey: Uint8Array; privateKey: Uint8Array };
let keyB: { publicKey: Uint8Array; privateKey: Uint8Array };

beforeAll(async () => {
  fc.configureGlobal({ seed: FC_SEED, numRuns: 100 });
  keyA = await generateEd25519Keypair();
  keyB = await generateEd25519Keypair();
});

const suiteArb: fc.Arbitrary<SuiteId> = fc.constantFrom(...ALL_SUITE_IDS);
const messageArb: fc.Arbitrary<Uint8Array> = fc
  .array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 256 })
  .map((arr) => Uint8Array.from(arr));

// ── Property 1 — Round-trip soundness ───────────────────────────────

describe("signBySuite / verifyBySuite: round-trip soundness", () => {
  it("verify(sign(m)) === true for any message bytes and any registered Ed25519 suite", async () => {
    await fc.assert(
      fc.asyncProperty(suiteArb, messageArb, async (suite, message) => {
        const sig = await signBySuite(suite, message, keyA.privateKey);
        return (await verifyBySuite(suite, message, sig, keyA.publicKey)) === true;
      }),
    );
  });
});

// ── Property 2 — Message-mutation rejection ─────────────────────────

describe("verifyBySuite: any single-byte message mutation is rejected", () => {
  it("flipping any byte of a signed message yields verify === false", async () => {
    await fc.assert(
      fc.asyncProperty(
        suiteArb,
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 1, maxLength: 256 }),
        fc.nat({ max: 99_999 }),
        fc.integer({ min: 1, max: 255 }),
        async (suite, msgArr, posSeed, xorByte) => {
          const message = Uint8Array.from(msgArr);
          const sig = await signBySuite(suite, message, keyA.privateKey);
          const pos = posSeed % message.length;
          const mutated = Uint8Array.from(message);
          mutated[pos] = mutated[pos]! ^ xorByte; // xorByte in [1,255] guarantees a change
          return (await verifyBySuite(suite, mutated, sig, keyA.publicKey)) === false;
        },
      ),
    );
  });
});

// ── Property 3 — Signature-mutation rejection ──────────────────────

describe("verifyBySuite: any single-byte signature mutation is rejected", () => {
  it("flipping any byte of the signature yields verify === false", async () => {
    await fc.assert(
      fc.asyncProperty(
        suiteArb,
        messageArb,
        fc.nat({ max: 99_999 }),
        fc.integer({ min: 1, max: 255 }),
        async (suite, message, posSeed, xorByte) => {
          const sig = await signBySuite(suite, message, keyA.privateKey);
          const pos = posSeed % sig.length;
          const mutatedSig = Uint8Array.from(sig);
          mutatedSig[pos] = mutatedSig[pos]! ^ xorByte;
          return (await verifyBySuite(suite, message, mutatedSig, keyA.publicKey)) === false;
        },
      ),
    );
  });
});

// ── Property 4 — Wrong-key rejection ────────────────────────────────

describe("verifyBySuite: a signature verified against the wrong key is rejected", () => {
  it("a valid signature from key A does NOT verify against key B's public key", async () => {
    await fc.assert(
      fc.asyncProperty(suiteArb, messageArb, async (suite, message) => {
        const sig = await signBySuite(suite, message, keyA.privateKey);
        // Correct key verifies; wrong key must not.
        const correct = await verifyBySuite(suite, message, sig, keyA.publicKey);
        const wrong = await verifyBySuite(suite, message, sig, keyB.publicKey);
        return correct === true && wrong === false;
      }),
    );
  });
});

// ── Property 5 — Suite coverage (closed-registry) ──────────────────

describe("signBySuite / verifyBySuite: every registered suite round-trips", () => {
  it("all ALL_SUITE_IDS entries sign + verify (no suite silently unsupported)", async () => {
    const message = new TextEncoder().encode("proof-composability-coverage-probe");
    for (const suite of ALL_SUITE_IDS) {
      const sig = await signBySuite(suite, message, keyA.privateKey);
      const ok = await verifyBySuite(suite, message, sig, keyA.publicKey);
      expect(ok, `suite ${suite} failed round-trip`).toBe(true);
    }
    // The dispatch switch is exhaustive over the closed union; this test
    // is the runtime witness that adding a SuiteId without a working
    // dispatch arm fails here, not silently in production.
    expect(ALL_SUITE_IDS.length).toBeGreaterThanOrEqual(5);
  });
});

// ── Property 6 — canonicalJson key-order independence ──────────────

describe("canonicalJson: JCS key ordering is insertion-order-independent", () => {
  it("the same key/value set produces identical canonical JSON regardless of insertion order", () => {
    const keyArb = fc.string({ minLength: 1, maxLength: 12 }).filter((s) => s.length > 0);
    const entriesArb = fc.uniqueArray(
      fc.tuple(keyArb, fc.oneof(fc.string(), fc.integer(), fc.boolean())),
      { minLength: 0, maxLength: 12, selector: (t) => t[0] },
    );
    fc.assert(
      fc.property(entriesArb, (entries) => {
        const forward: Record<string, unknown> = {};
        for (const [k, v] of entries) forward[k] = v;
        const reversed: Record<string, unknown> = {};
        for (const [k, v] of [...entries].reverse()) reversed[k] = v;
        return canonicalJson(forward) === canonicalJson(reversed);
      }),
    );
  });

  it("canonicalJson is idempotent — same input yields byte-identical output across calls", () => {
    const valueArb: fc.Arbitrary<unknown> = fc.jsonValue();
    fc.assert(
      fc.property(valueArb, (v) => {
        return canonicalJson(v) === canonicalJson(v);
      }),
    );
  });
});

// ── Property 7 — sign over canonicalJson round-trips end-to-end ────

describe("end-to-end: sign(canonicalJson(obj)) verifies; mutated obj does not", () => {
  it("a signed canonical body verifies, and any key/value change breaks it", async () => {
    await fc.assert(
      fc.asyncProperty(
        suiteArb,
        fc.record({
          task_id: fc.string({ minLength: 1, maxLength: 16 }),
          amount: fc.integer({ min: 0, max: 1_000_000 }),
          status: fc.constantFrom("completed", "failed", "denied"),
        }),
        async (suite, body) => {
          const enc = new TextEncoder();
          const canonical = enc.encode(canonicalJson(body));
          const sig = await signBySuite(suite, canonical, keyA.privateKey);
          const valid = await verifyBySuite(suite, canonical, sig, keyA.publicKey);
          // Mutate the body (bump amount) → different canonical bytes → must not verify.
          const mutatedCanonical = enc.encode(canonicalJson({ ...body, amount: body.amount + 1 }));
          const mutatedVerifies = await verifyBySuite(suite, mutatedCanonical, sig, keyA.publicKey);
          return valid === true && mutatedVerifies === false;
        },
      ),
    );
  });
});
