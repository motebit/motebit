import { describe, it, expect } from "vitest";
import { SensitivityLevel, ALL_ACCRUAL_KINDS, type AccrualBasis } from "@motebit/protocol";
import { resolveAccrualAttribution } from "../accrual-attribution";

/**
 * Inc-3 projection tests — the calm, sensitivity-bounded leverage phrase.
 * Doctrine: docs/doctrine/felt-accumulation.md § Disclosure.
 */
const basis = (kind: AccrualBasis["kind"], sensitivity: SensitivityLevel): AccrualBasis => ({
  kind,
  sourceRef: "ref",
  sensitivity,
});

describe("resolveAccrualAttribution", () => {
  it("names the consequence at the open tier (none/personal)", () => {
    expect(resolveAccrualAttribution(basis("recalled_memory", SensitivityLevel.None)).text).toBe(
      "Recalled from what you've told me",
    );
    expect(
      resolveAccrualAttribution(basis("recalled_memory", SensitivityLevel.Personal)).text,
    ).toBe("Recalled from what you've told me");
  });

  it("redacts to existence-of-a-private-draw at the guarded tier (medical and above)", () => {
    for (const tier of [
      SensitivityLevel.Medical,
      SensitivityLevel.Financial,
      SensitivityLevel.Secret,
    ]) {
      expect(resolveAccrualAttribution(basis("recalled_memory", tier)).text).toBe(
        "Acted on a private memory",
      );
    }
  });

  it("personal stays open; medical is the guarded floor (the ladder boundary)", () => {
    expect(resolveAccrualAttribution(basis("trust_edge", SensitivityLevel.Personal)).text).toBe(
      "Trusting a peer you've worked with",
    );
    expect(resolveAccrualAttribution(basis("trust_edge", SensitivityLevel.Medical)).text).toBe(
      "Trusting a private relationship",
    );
  });

  it("every accrual kind has a non-empty phrase at both tiers (no kind renders blank)", () => {
    for (const kind of ALL_ACCRUAL_KINDS) {
      const open = resolveAccrualAttribution(basis(kind, SensitivityLevel.None)).text;
      const guarded = resolveAccrualAttribution(basis(kind, SensitivityLevel.Secret)).text;
      expect(open.length).toBeGreaterThan(0);
      expect(guarded.length).toBeGreaterThan(0);
      // The guarded phrase never names more than the open one (redaction direction).
      expect(guarded.toLowerCase()).toContain("private");
    }
  });

  it("never leaks the leveraged source ref into the phrase", () => {
    const text = resolveAccrualAttribution({
      kind: "recalled_memory",
      sourceRef: "mem_secret_node_id_0xdeadbeef",
      sensitivity: SensitivityLevel.None,
    }).text;
    expect(text).not.toContain("mem_secret_node_id");
  });
});
