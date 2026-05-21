/**
 * Closed-matrix exhaustiveness for the sensitivity gate's truth table.
 *
 * `sensitivity-routing.test.ts` covers the gate with hand-picked
 * (sensitivity × providerMode × fire-site) examples. The architectural
 * lock missing from that surface is **exhaustive enumeration of the
 * closed matrix against an explicit truth table** — drift in the gate's
 * decision logic (a new mode introduced, an existing tier silently
 * downgraded, "unset" mapped to "on-device" by accident) flips a cell;
 * this test asserts every cell matches a declared contract.
 *
 * The truth table is the doctrine made structural. Per CLAUDE.md
 * principle "Fail-closed privacy" / "Medical/financial/secret never
 * reach external AI":
 *
 *   Verdict matrix — 5 sensitivity levels × 4 provider-mode states
 *
 *   |               | on-device | motebit-cloud | byok  | unset |
 *   | ------------- | --------- | ------------- | ----- | ----- |
 *   | none          | ALLOW     | ALLOW         | ALLOW | ALLOW |
 *   | personal      | ALLOW     | ALLOW         | ALLOW | ALLOW |
 *   | medical       | ALLOW     | DENY          | DENY  | DENY  |
 *   | financial     | ALLOW     | DENY          | DENY  | DENY  |
 *   | secret        | ALLOW     | DENY          | DENY  | DENY  |
 *
 * Total cells: 20. ALLOW: 11. DENY: 9. The gate's source-of-truth is
 * `MotebitRuntime.assertSensitivityPermitsAiCall` at line ≈3763 of
 * `motebit-runtime.ts`; the deny predicate is `sensitive &&
 * !providerIsSovereign()` where `sensitive = rank(effective) >=
 * rank(Medical)` and `providerIsSovereign() = providerMode ===
 * "on-device"`.
 *
 * Sibling pattern to `check-typed-truth-perception` (#80) and
 * `check-property-test-floor` (#106): closed-registry-with-explicit-
 * declaration. Drift in the gate's decision logic that flips any
 * cell fails this test with a precise per-cell error message;
 * adding a new `SensitivityLevel` or `ProviderMode` arm REQUIRES
 * updating the table here, not just the gate.
 *
 * Per `docs/doctrine/evals-as-attestations.md` § "What ships now",
 * this is testing-only discipline under existing package surfaces.
 */

import { describe, expect, it } from "vitest";
import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  SovereignTierRequiredError,
} from "../index";
import { ALL_SENSITIVITY_LEVELS, SensitivityLevel } from "@motebit/sdk";
import type { ProviderMode } from "@motebit/sdk";

type ProviderModeOrUnset = ProviderMode | "unset";

const ALL_PROVIDER_MODES: ReadonlyArray<ProviderModeOrUnset> = [
  "on-device",
  "motebit-cloud",
  "byok",
  "unset",
];

type Verdict = "allow" | "deny";

/**
 * The declared truth table — every cell explicit. This is the doctrine
 * made structural; the gate's source-of-truth in `motebit-runtime.ts`
 * must agree with this table for every cell, or the doctrine ("Medical
 * /financial/secret never reach external AI") quietly drifts.
 *
 * Updating this table is the doctrine moment. A future change to the
 * gate's logic — a new `SensitivityLevel`, a new `ProviderMode`, a
 * different sovereign-mode predicate — requires editing this table
 * AND naming WHY in the commit message.
 */
const TRUTH_TABLE: Readonly<
  Record<SensitivityLevel, Readonly<Record<ProviderModeOrUnset, Verdict>>>
> = {
  [SensitivityLevel.None]: {
    "on-device": "allow",
    "motebit-cloud": "allow",
    byok: "allow",
    unset: "allow",
  },
  [SensitivityLevel.Personal]: {
    "on-device": "allow",
    "motebit-cloud": "allow",
    byok: "allow",
    unset: "allow",
  },
  [SensitivityLevel.Medical]: {
    "on-device": "allow",
    "motebit-cloud": "deny",
    byok: "deny",
    unset: "deny",
  },
  [SensitivityLevel.Financial]: {
    "on-device": "allow",
    "motebit-cloud": "deny",
    byok: "deny",
    unset: "deny",
  },
  [SensitivityLevel.Secret]: {
    "on-device": "allow",
    "motebit-cloud": "deny",
    byok: "deny",
    unset: "deny",
  },
};

function makeRuntime(): MotebitRuntime {
  return new MotebitRuntime(
    { motebitId: "test-mote", tickRateHz: 0 },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
}

/**
 * Probe the gate at a single (sensitivity, mode) cell via the
 * `sendMessage` entry point. Returns the actual verdict so we can
 * compare to the declared truth table.
 */
async function probeCell(
  sensitivity: SensitivityLevel,
  mode: ProviderModeOrUnset,
): Promise<Verdict> {
  const r = makeRuntime();
  if (mode !== "unset") r.setProviderMode(mode);
  r.setSessionSensitivity(sensitivity);
  try {
    await r.sendMessage("test-input");
    // Gate didn't throw a SovereignTierRequiredError. The call may
    // still reject downstream (no provider configured) — that's allow.
    return "allow";
  } catch (err) {
    if (err instanceof SovereignTierRequiredError) return "deny";
    // Some other downstream failure ("AI not initialized" etc.) — the
    // GATE allowed; downstream failure is orthogonal to gate verdict.
    return "allow";
  }
}

// ── Property 1 — every cell matches the declared truth table ────────

describe("sensitivity gate: closed-matrix exhaustiveness", () => {
  it("every (SensitivityLevel × ProviderMode) cell matches the declared truth table", async () => {
    const mismatches: string[] = [];
    for (const sensitivity of ALL_SENSITIVITY_LEVELS) {
      for (const mode of ALL_PROVIDER_MODES) {
        const expected = TRUTH_TABLE[sensitivity][mode];
        const actual = await probeCell(sensitivity, mode);
        if (actual !== expected) {
          mismatches.push(`  (${sensitivity}, ${mode}): expected ${expected}, got ${actual}`);
        }
      }
    }
    if (mismatches.length > 0) {
      throw new Error(
        `Gate matrix drift — ${mismatches.length} cell(s) disagree with the declared truth table:\n${mismatches.join("\n")}\n\nFix: either align the gate's decision logic in motebit-runtime.ts::assertSensitivityPermitsAiCall with the truth table above, OR update the truth table (with a commit message naming the doctrinal reason). Doctrine: CLAUDE.md "Fail-closed privacy" — medical/financial/secret never reach external AI.`,
      );
    }
  });

  it("matrix size is 20 cells (5 levels × 4 modes) — closed-registry shape", () => {
    expect(ALL_SENSITIVITY_LEVELS.length).toBe(5);
    expect(ALL_PROVIDER_MODES.length).toBe(4);
    let cells = 0;
    for (const s of ALL_SENSITIVITY_LEVELS) {
      for (const m of ALL_PROVIDER_MODES) {
        if (TRUTH_TABLE[s][m] === "allow" || TRUTH_TABLE[s][m] === "deny") cells++;
      }
    }
    expect(cells).toBe(20);
  });

  it("verdict counts match the declared doctrine — 11 allow + 9 deny", () => {
    let allow = 0;
    let deny = 0;
    for (const s of ALL_SENSITIVITY_LEVELS) {
      for (const m of ALL_PROVIDER_MODES) {
        if (TRUTH_TABLE[s][m] === "allow") allow++;
        else deny++;
      }
    }
    expect(allow).toBe(11);
    expect(deny).toBe(9);
  });
});

// ── Property 2 — gate is monotonic in sensitivity at fixed mode ─────

describe("sensitivity gate: monotonic in sensitivity at fixed provider mode", () => {
  // For any fixed provider mode, raising sensitivity can only flip
  // allow → deny, never deny → allow. Catches a regression where a
  // future tier insertion is positioned incorrectly in the ladder.
  it("at any fixed mode, the deny-set is monotonic non-decreasing as sensitivity rises", () => {
    for (const mode of ALL_PROVIDER_MODES) {
      let seenDeny = false;
      for (const sensitivity of ALL_SENSITIVITY_LEVELS) {
        const verdict = TRUTH_TABLE[sensitivity][mode];
        if (verdict === "deny") {
          seenDeny = true;
        } else if (seenDeny) {
          throw new Error(
            `Truth-table inversion: mode=${mode}, sensitivity=${sensitivity} is allow but a lower-ranked tier was deny. Sensitivity gate must be monotonic in tier.`,
          );
        }
      }
    }
  });
});

// ── Property 3 — on-device mode is the universal sovereign ─────────

describe("sensitivity gate: on-device permits every tier", () => {
  // The doctrine's escape hatch: an on-device provider has no leakage
  // surface, so every sensitivity tier MUST be permitted. If this row
  // ever has a deny, the sovereignty escape hatch is broken.
  it("on-device mode allows all 5 sensitivity tiers", () => {
    for (const sensitivity of ALL_SENSITIVITY_LEVELS) {
      expect(TRUTH_TABLE[sensitivity]["on-device"]).toBe("allow");
    }
  });
});

// ── Property 4 — unset is fail-closed for sensitive tiers ──────────

describe("sensitivity gate: unset provider mode fails closed at sensitive tiers", () => {
  // A surface that forgets to declare its provider mode cannot
  // silently bypass the gate. This is the "fail-closed default" half
  // of the doctrine — the gate treats unset as external.
  it("unset denies medical/financial/secret (matches non-sovereign modes)", () => {
    expect(TRUTH_TABLE[SensitivityLevel.Medical].unset).toBe("deny");
    expect(TRUTH_TABLE[SensitivityLevel.Financial].unset).toBe("deny");
    expect(TRUTH_TABLE[SensitivityLevel.Secret].unset).toBe("deny");
  });

  it("unset still allows none/personal (gate is no-op at low tiers)", () => {
    expect(TRUTH_TABLE[SensitivityLevel.None].unset).toBe("allow");
    expect(TRUTH_TABLE[SensitivityLevel.Personal].unset).toBe("allow");
  });
});
