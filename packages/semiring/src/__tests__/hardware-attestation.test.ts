/**
 * Tests for HardwareAttestationSemiring — the fifth semiring consumer.
 *
 * Covers:
 *   - semiring axioms (identity, associativity, annihilation, distributivity)
 *   - scoreAttestation maps every claim shape to the expected scalar
 *   - ranking: hardware > exported hardware > software > none
 *   - parallel composition (⊕) picks the strongest
 *   - sequential composition (⊗) is the weakest link
 *   - composition with productSemiring works (attestation × trust)
 */
import { describe, expect, it } from "vitest";
import type { HardwareAttestationClaim, Semiring } from "@motebit/protocol";
import { productSemiring, TrustSemiring } from "@motebit/protocol";

import {
  HW_ATTESTATION_HARDWARE,
  HW_ATTESTATION_HARDWARE_EXPORTED,
  HW_ATTESTATION_NONE,
  HW_ATTESTATION_SOFTWARE,
  HardwareAttestationSemiring,
  attestationRanksAbove,
  scoreAttestation,
} from "../hardware-attestation.js";

// ── Sample values spanning the domain ───────────────────────────────

const VALUES = [
  HW_ATTESTATION_NONE,
  HW_ATTESTATION_SOFTWARE,
  HW_ATTESTATION_HARDWARE_EXPORTED,
  HW_ATTESTATION_HARDWARE,
];

// ── Semiring axioms ─────────────────────────────────────────────────

function verifyAxioms<T>(name: string, sr: Semiring<T>, values: T[]): void {
  describe(`${name} — semiring axioms`, () => {
    it("⊕ identity: a ⊕ 0 = a", () => {
      for (const a of values) {
        expect(sr.add(a, sr.zero)).toBe(a);
        expect(sr.add(sr.zero, a)).toBe(a);
      }
    });

    it("⊕ commutative: a ⊕ b = b ⊕ a", () => {
      for (const a of values) {
        for (const b of values) {
          expect(sr.add(a, b)).toBe(sr.add(b, a));
        }
      }
    });

    it("⊕ associative: (a ⊕ b) ⊕ c = a ⊕ (b ⊕ c)", () => {
      for (const a of values) {
        for (const b of values) {
          for (const c of values) {
            expect(sr.add(sr.add(a, b), c)).toBe(sr.add(a, sr.add(b, c)));
          }
        }
      }
    });

    it("⊗ identity: a ⊗ 1 = a", () => {
      for (const a of values) {
        expect(sr.mul(a, sr.one)).toBe(a);
        expect(sr.mul(sr.one, a)).toBe(a);
      }
    });

    it("⊗ associative: (a ⊗ b) ⊗ c = a ⊗ (b ⊗ c)", () => {
      for (const a of values) {
        for (const b of values) {
          for (const c of values) {
            expect(sr.mul(sr.mul(a, b), c)).toBe(sr.mul(a, sr.mul(b, c)));
          }
        }
      }
    });

    it("0 annihilates: a ⊗ 0 = 0", () => {
      for (const a of values) {
        expect(sr.mul(a, sr.zero)).toBe(sr.zero);
        expect(sr.mul(sr.zero, a)).toBe(sr.zero);
      }
    });

    it("⊗ distributes over ⊕: a ⊗ (b ⊕ c) = (a ⊗ b) ⊕ (a ⊗ c)", () => {
      for (const a of values) {
        for (const b of values) {
          for (const c of values) {
            expect(sr.mul(a, sr.add(b, c))).toBe(sr.add(sr.mul(a, b), sr.mul(a, c)));
          }
        }
      }
    });
  });
}

verifyAxioms("HardwareAttestationSemiring", HardwareAttestationSemiring, VALUES);

// ── Concrete constants ──────────────────────────────────────────────

describe("HardwareAttestationSemiring — constants", () => {
  it("zero = 0 (absent claim)", () => {
    expect(HardwareAttestationSemiring.zero).toBe(HW_ATTESTATION_NONE);
    expect(HardwareAttestationSemiring.zero).toBe(0);
  });

  it("one = 1 (hardware ideal)", () => {
    expect(HardwareAttestationSemiring.one).toBe(HW_ATTESTATION_HARDWARE);
    expect(HardwareAttestationSemiring.one).toBe(1);
  });

  it("score constants are strictly ordered: hardware > exported > software > none", () => {
    expect(HW_ATTESTATION_HARDWARE).toBeGreaterThan(HW_ATTESTATION_HARDWARE_EXPORTED);
    expect(HW_ATTESTATION_HARDWARE_EXPORTED).toBeGreaterThan(HW_ATTESTATION_SOFTWARE);
    expect(HW_ATTESTATION_SOFTWARE).toBeGreaterThan(HW_ATTESTATION_NONE);
  });
});

// ── scoreAttestation coverage ───────────────────────────────────────

describe("scoreAttestation", () => {
  it("absent claim → zero", () => {
    expect(scoreAttestation(undefined)).toBe(HW_ATTESTATION_NONE);
  });

  it("secure_enclave + key_exported=false → hardware (1.0)", () => {
    const c: HardwareAttestationClaim = { platform: "secure_enclave", key_exported: false };
    expect(scoreAttestation(c)).toBe(HW_ATTESTATION_HARDWARE);
  });

  it("secure_enclave + key_exported absent → hardware (1.0)", () => {
    expect(scoreAttestation({ platform: "secure_enclave" })).toBe(HW_ATTESTATION_HARDWARE);
  });

  it("secure_enclave + key_exported=true → hardware_exported (0.5)", () => {
    expect(scoreAttestation({ platform: "secure_enclave", key_exported: true })).toBe(
      HW_ATTESTATION_HARDWARE_EXPORTED,
    );
  });

  it("tpm is hardware", () => {
    expect(scoreAttestation({ platform: "tpm" })).toBe(HW_ATTESTATION_HARDWARE);
    expect(scoreAttestation({ platform: "tpm", key_exported: true })).toBe(
      HW_ATTESTATION_HARDWARE_EXPORTED,
    );
  });

  it("device_check is hardware", () => {
    expect(scoreAttestation({ platform: "device_check" })).toBe(HW_ATTESTATION_HARDWARE);
    expect(scoreAttestation({ platform: "device_check", key_exported: true })).toBe(
      HW_ATTESTATION_HARDWARE_EXPORTED,
    );
  });

  it("play_integrity is hardware", () => {
    expect(scoreAttestation({ platform: "play_integrity" })).toBe(HW_ATTESTATION_HARDWARE);
  });

  it("software → software (0.1)", () => {
    expect(scoreAttestation({ platform: "software" })).toBe(HW_ATTESTATION_SOFTWARE);
  });

  it("ignores attestation_receipt for scoring (schema bytes, not ranking signal)", () => {
    expect(scoreAttestation({ platform: "secure_enclave", attestation_receipt: "abc" })).toBe(
      HW_ATTESTATION_HARDWARE,
    );
  });
});

// ── Ranking semantics ───────────────────────────────────────────────

describe("HardwareAttestationSemiring — ranking", () => {
  it("parallel routes: hardware beats software (⊕ picks strongest)", () => {
    expect(HardwareAttestationSemiring.add(HW_ATTESTATION_HARDWARE, HW_ATTESTATION_SOFTWARE)).toBe(
      HW_ATTESTATION_HARDWARE,
    );
  });

  it("parallel routes: hardware_exported beats software", () => {
    expect(
      HardwareAttestationSemiring.add(HW_ATTESTATION_HARDWARE_EXPORTED, HW_ATTESTATION_SOFTWARE),
    ).toBe(HW_ATTESTATION_HARDWARE_EXPORTED);
  });

  it("parallel routes: software beats absent", () => {
    expect(HardwareAttestationSemiring.add(HW_ATTESTATION_SOFTWARE, HW_ATTESTATION_NONE)).toBe(
      HW_ATTESTATION_SOFTWARE,
    );
  });

  it("parallel routes: hardware beats hardware_exported", () => {
    expect(
      HardwareAttestationSemiring.add(HW_ATTESTATION_HARDWARE, HW_ATTESTATION_HARDWARE_EXPORTED),
    ).toBe(HW_ATTESTATION_HARDWARE);
  });

  it("sequential chain: hardware-through-software = software (weakest link)", () => {
    expect(HardwareAttestationSemiring.mul(HW_ATTESTATION_HARDWARE, HW_ATTESTATION_SOFTWARE)).toBe(
      HW_ATTESTATION_SOFTWARE,
    );
  });

  it("sequential chain: any link through absent = zero (unknown custody annihilates)", () => {
    expect(HardwareAttestationSemiring.mul(HW_ATTESTATION_HARDWARE, HW_ATTESTATION_NONE)).toBe(
      HW_ATTESTATION_NONE,
    );
    expect(HardwareAttestationSemiring.mul(HW_ATTESTATION_SOFTWARE, HW_ATTESTATION_NONE)).toBe(
      HW_ATTESTATION_NONE,
    );
  });

  it("sequential chain of all-hardware stays hardware", () => {
    expect(HardwareAttestationSemiring.mul(HW_ATTESTATION_HARDWARE, HW_ATTESTATION_HARDWARE)).toBe(
      HW_ATTESTATION_HARDWARE,
    );
  });

  it("attestationRanksAbove matches the max-ordering", () => {
    expect(attestationRanksAbove(HW_ATTESTATION_HARDWARE, HW_ATTESTATION_SOFTWARE)).toBe(true);
    expect(attestationRanksAbove(HW_ATTESTATION_SOFTWARE, HW_ATTESTATION_HARDWARE)).toBe(false);
    expect(attestationRanksAbove(HW_ATTESTATION_HARDWARE, HW_ATTESTATION_HARDWARE)).toBe(false);
  });
});

// ── Composition with other semirings ────────────────────────────────

describe("HardwareAttestationSemiring — product composition", () => {
  it("composes with TrustSemiring via productSemiring", () => {
    // Both are (max, ·, 0, 1) shape — product lifts cleanly.
    const TrustTimesAttestation = productSemiring(TrustSemiring, HardwareAttestationSemiring);
    const a: readonly [number, number] = [0.9, HW_ATTESTATION_HARDWARE];
    const b: readonly [number, number] = [0.7, HW_ATTESTATION_SOFTWARE];
    // Parallel: max per dimension
    expect(TrustTimesAttestation.add(a, b)).toEqual([0.9, HW_ATTESTATION_HARDWARE]);
    // Sequential: trust multiplies, attestation min's
    expect(TrustTimesAttestation.mul(a, b)).toEqual([0.63, HW_ATTESTATION_SOFTWARE]);
  });

  it("zero in either dimension annihilates sequential composition", () => {
    const TrustTimesAttestation = productSemiring(TrustSemiring, HardwareAttestationSemiring);
    // Trust zero makes trust chain zero; attestation stays min.
    const x: readonly [number, number] = [0, HW_ATTESTATION_HARDWARE];
    const y: readonly [number, number] = [0.5, HW_ATTESTATION_HARDWARE];
    const [trustChain, attestChain] = TrustTimesAttestation.mul(x, y);
    expect(trustChain).toBe(0);
    expect(attestChain).toBe(HW_ATTESTATION_HARDWARE);
  });
});

// ── Realistic ranking scenario ──────────────────────────────────────

describe("HardwareAttestationSemiring — scenario: rank candidates", () => {
  interface Agent {
    name: string;
    attestation: HardwareAttestationClaim | undefined;
  }

  const agents: Agent[] = [
    { name: "alice-iphone", attestation: { platform: "secure_enclave", key_exported: false } },
    { name: "bob-pc", attestation: { platform: "tpm" } },
    { name: "carol-backup", attestation: { platform: "secure_enclave", key_exported: true } },
    { name: "dave-node", attestation: { platform: "software" } },
    { name: "eve-unknown", attestation: undefined },
  ];

  it("ranks agents from strongest attestation to weakest", () => {
    const scored = agents
      .map((a) => ({ ...a, score: scoreAttestation(a.attestation) }))
      .sort((a, b) => b.score - a.score);

    expect(scored.map((s) => s.name)).toEqual([
      "alice-iphone", // 1.0
      "bob-pc", // 1.0 (tied with alice on full hardware)
      "carol-backup", // 0.5
      "dave-node", // 0.1
      "eve-unknown", // 0.0
    ]);
  });

  it("picks the hardware-attested winner via ⊕ over all scores", () => {
    const winner = agents
      .map((a) => scoreAttestation(a.attestation))
      .reduce(
        (acc, s) => HardwareAttestationSemiring.add(acc, s),
        HardwareAttestationSemiring.zero,
      );
    expect(winner).toBe(HW_ATTESTATION_HARDWARE);
  });

  it("chain with a software hop degrades to software strength", () => {
    const chain = [
      scoreAttestation({ platform: "secure_enclave" }),
      scoreAttestation({ platform: "software" }),
      scoreAttestation({ platform: "tpm" }),
    ].reduce((acc, s) => HardwareAttestationSemiring.mul(acc, s), HardwareAttestationSemiring.one);
    expect(chain).toBe(HW_ATTESTATION_SOFTWARE);
  });

  it("chain with an unknown hop degrades to zero (no claim)", () => {
    const chain = [
      scoreAttestation({ platform: "secure_enclave" }),
      scoreAttestation(undefined),
      scoreAttestation({ platform: "tpm" }),
    ].reduce((acc, s) => HardwareAttestationSemiring.mul(acc, s), HardwareAttestationSemiring.one);
    expect(chain).toBe(HW_ATTESTATION_NONE);
  });
});
