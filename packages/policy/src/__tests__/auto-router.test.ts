/**
 * Auto-router dispatcher tests.
 *
 * The dispatcher is `f(TaskShape × ProviderCapability ×
 * Constraints) → RoutingDecision`. Test coverage:
 *
 *   - Matrix coverage: each `TaskShape` × an unrestricted US
 *     catalog → expected route (validates `REFERENCE_ROUTING_POLICY`
 *     arms reach the dispatcher correctly).
 *   - Constraint paths: jurisdiction filter, cost ceilings.
 *   - Fallback path: preferred model not in catalog → backup.
 *   - Deny path: empty catalog, impossible constraint.
 *   - Balance wrapper: `applyBalanceFilter` shrinks catalog;
 *     dispatcher over the shrunk catalog produces the cheap
 *     fallback.
 *   - Exhaustive coverage: every `TaskShape` from
 *     `ALL_TASK_SHAPES` is exercised at least once.
 *
 * Doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md`
 * § "PR 1 scope."
 */

import { describe, it, expect } from "vitest";
import {
  ALL_TASK_SHAPES,
  type ProviderCapability,
  type RoutingConstraint,
} from "@motebit/protocol";
import {
  dispatchRouting,
  applyBalanceFilter,
  formatRoutingChip,
  REFERENCE_ROUTING_POLICY,
} from "../auto-router.js";

// Catalog mirroring `services/proxy/src/validation.ts`'s MODEL_CONFIG
// (the 11 production models, US-jurisdiction). Test fixtures are kept
// here rather than imported from the proxy to keep the policy package
// self-contained (no upward dependency on services/).
const FULL_CATALOG: readonly ProviderCapability[] = Object.freeze([
  {
    modelName: "claude-opus-4-6",
    host: "anthropic",
    lab: "anthropic",
    jurisdiction: "US",
    inputCostPerMillion: 5.0,
    outputCostPerMillion: 25.0,
  },
  {
    modelName: "claude-sonnet-4-6",
    host: "anthropic",
    lab: "anthropic",
    jurisdiction: "US",
    inputCostPerMillion: 3.0,
    outputCostPerMillion: 15.0,
  },
  {
    modelName: "claude-haiku-4-5-20251001",
    host: "anthropic",
    lab: "anthropic",
    jurisdiction: "US",
    inputCostPerMillion: 1.0,
    outputCostPerMillion: 5.0,
  },
  {
    modelName: "gpt-5.4",
    host: "openai",
    lab: "openai",
    jurisdiction: "US",
    inputCostPerMillion: 2.5,
    outputCostPerMillion: 15.0,
  },
  {
    modelName: "gpt-5.4-mini",
    host: "openai",
    lab: "openai",
    jurisdiction: "US",
    inputCostPerMillion: 0.75,
    outputCostPerMillion: 4.5,
  },
  {
    modelName: "gemini-2.5-pro",
    host: "google",
    lab: "google",
    jurisdiction: "US",
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 10.0,
  },
  {
    modelName: "gemini-2.5-flash-lite",
    host: "google",
    lab: "google",
    jurisdiction: "US",
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.4,
  },
  {
    modelName: "llama-3.3-70b-versatile",
    host: "groq",
    lab: "meta",
    jurisdiction: "US",
    inputCostPerMillion: 0.59,
    outputCostPerMillion: 0.79,
  },
]);

const NO_CONSTRAINTS: RoutingConstraint = Object.freeze({});

describe("dispatchRouting — matrix coverage (TaskShape × REFERENCE_ROUTING_POLICY)", () => {
  // Each TaskShape × unrestricted catalog → policy's preferred model.
  // Exercises every arm of the exhaustive switch.
  it("quick → claude-haiku-4-5-20251001", () => {
    const decision = dispatchRouting(
      "quick",
      FULL_CATALOG,
      NO_CONSTRAINTS,
      REFERENCE_ROUTING_POLICY,
    );
    expect(decision.kind).toBe("route");
    if (decision.kind === "route") {
      expect(decision.model).toBe("claude-haiku-4-5-20251001");
    }
  });

  it("chat → claude-sonnet-4-6", () => {
    const decision = dispatchRouting(
      "chat",
      FULL_CATALOG,
      NO_CONSTRAINTS,
      REFERENCE_ROUTING_POLICY,
    );
    expect(decision.kind).toBe("route");
    if (decision.kind === "route") {
      expect(decision.model).toBe("claude-sonnet-4-6");
    }
  });

  it("reasoning → claude-opus-4-6", () => {
    const decision = dispatchRouting(
      "reasoning",
      FULL_CATALOG,
      NO_CONSTRAINTS,
      REFERENCE_ROUTING_POLICY,
    );
    expect(decision.kind).toBe("route");
    if (decision.kind === "route") {
      expect(decision.model).toBe("claude-opus-4-6");
    }
  });

  it("code → gpt-5.4", () => {
    const decision = dispatchRouting(
      "code",
      FULL_CATALOG,
      NO_CONSTRAINTS,
      REFERENCE_ROUTING_POLICY,
    );
    expect(decision.kind).toBe("route");
    if (decision.kind === "route") {
      expect(decision.model).toBe("gpt-5.4");
    }
  });

  it("research → gemini-2.5-pro", () => {
    const decision = dispatchRouting(
      "research",
      FULL_CATALOG,
      NO_CONSTRAINTS,
      REFERENCE_ROUTING_POLICY,
    );
    expect(decision.kind).toBe("route");
    if (decision.kind === "route") {
      expect(decision.model).toBe("gemini-2.5-pro");
    }
  });

  it("creative → claude-sonnet-4-6", () => {
    const decision = dispatchRouting(
      "creative",
      FULL_CATALOG,
      NO_CONSTRAINTS,
      REFERENCE_ROUTING_POLICY,
    );
    expect(decision.kind).toBe("route");
    if (decision.kind === "route") {
      expect(decision.model).toBe("claude-sonnet-4-6");
    }
  });

  it("math → claude-opus-4-6", () => {
    const decision = dispatchRouting(
      "math",
      FULL_CATALOG,
      NO_CONSTRAINTS,
      REFERENCE_ROUTING_POLICY,
    );
    expect(decision.kind).toBe("route");
    if (decision.kind === "route") {
      expect(decision.model).toBe("claude-opus-4-6");
    }
  });

  it("exhaustive iteration — every ALL_TASK_SHAPES entry produces a valid decision", () => {
    // Doctrinal guarantee: TaskShape is a closed registry; every
    // member has a routing arm. Compile-time enforced by the
    // exhaustive switch + `never` fallthrough; this test confirms
    // runtime parity (no shape silently produces an undefined model).
    for (const shape of ALL_TASK_SHAPES) {
      const decision = dispatchRouting(
        shape,
        FULL_CATALOG,
        NO_CONSTRAINTS,
        REFERENCE_ROUTING_POLICY,
      );
      expect(decision.kind).toBe("route");
      if (decision.kind === "route") {
        expect(decision.model.length).toBeGreaterThan(0);
        expect(decision.reason).toContain(shape);
      }
    }
  });
});

describe("dispatchRouting — fallback path (preferred model not in catalog)", () => {
  it("falls back to the first surviving catalog entry when preferred is filtered out", () => {
    // Catalog WITHOUT the opus model; reasoning task should fall back.
    const noOpus = FULL_CATALOG.filter((c) => c.modelName !== "claude-opus-4-6");
    const decision = dispatchRouting("reasoning", noOpus, NO_CONSTRAINTS, REFERENCE_ROUTING_POLICY);
    expect(decision.kind).toBe("fallback");
    if (decision.kind === "fallback") {
      expect(decision.primary).toBe("claude-opus-4-6");
      expect(decision.backup).toBe(noOpus[0]!.modelName);
      expect(decision.reason).toContain("claude-opus-4-6");
    }
  });

  it("fallback reason carries both the preferred name and the chosen backup", () => {
    const noSonnet = FULL_CATALOG.filter((c) => c.modelName !== "claude-sonnet-4-6");
    const decision = dispatchRouting("chat", noSonnet, NO_CONSTRAINTS, REFERENCE_ROUTING_POLICY);
    expect(decision.kind).toBe("fallback");
    if (decision.kind === "fallback") {
      expect(decision.reason).toMatch(/claude-sonnet-4-6/);
      expect(decision.reason).toMatch(new RegExp(decision.backup));
    }
  });
});

describe("dispatchRouting — deny path (constraints make every entry ineligible)", () => {
  it("empty catalog → deny", () => {
    const decision = dispatchRouting("chat", [], NO_CONSTRAINTS, REFERENCE_ROUTING_POLICY);
    expect(decision.kind).toBe("deny");
    if (decision.kind === "deny") {
      expect(decision.reason).toContain("No catalog entries");
    }
  });

  it("impossible jurisdiction → deny (all entries filtered out)", () => {
    // No EU members in FULL_CATALOG; jurisdiction:"EU" excludes everything.
    const decision = dispatchRouting(
      "chat",
      FULL_CATALOG,
      { jurisdiction: "EU" },
      REFERENCE_ROUTING_POLICY,
    );
    expect(decision.kind).toBe("deny");
  });

  it("impossibly low cost ceiling → deny", () => {
    // No model has $0.0/M input; cap below zero eliminates everything.
    const decision = dispatchRouting(
      "chat",
      FULL_CATALOG,
      { maxInputCostPerMillion: -1 },
      REFERENCE_ROUTING_POLICY,
    );
    expect(decision.kind).toBe("deny");
  });
});

describe("dispatchRouting — jurisdiction filter", () => {
  it("US-only catalog with US constraint → unchanged behavior", () => {
    const decision = dispatchRouting(
      "chat",
      FULL_CATALOG,
      { jurisdiction: "US" },
      REFERENCE_ROUTING_POLICY,
    );
    expect(decision.kind).toBe("route");
    if (decision.kind === "route") {
      expect(decision.model).toBe("claude-sonnet-4-6");
    }
  });

  it("includes a mixed-jurisdiction catalog filter test", () => {
    const mixed: ProviderCapability[] = [
      ...FULL_CATALOG,
      {
        modelName: "deepseek-chat",
        host: "openai",
        lab: "openai",
        jurisdiction: "CN",
        inputCostPerMillion: 0.27,
        outputCostPerMillion: 1.1,
      },
    ];
    const usOnly = dispatchRouting("chat", mixed, { jurisdiction: "US" }, REFERENCE_ROUTING_POLICY);
    expect(usOnly.kind).toBe("route");
    if (usOnly.kind === "route") {
      expect(usOnly.model).toBe("claude-sonnet-4-6"); // Sonnet, not the CN entry
    }
  });
});

describe("dispatchRouting — cost ceiling filter", () => {
  it("low input-cost ceiling filters out premium models; falls back to cheap survivor", () => {
    // Reasoning prefers opus ($5/M input); cap at $1.5/M leaves only
    // claude-haiku ($1), gpt-5.4-mini ($0.75), gemini-flash-lite ($0.1),
    // llama-3.3-70b ($0.59), gemini-pro ($1.25). Opus is filtered → fallback.
    const decision = dispatchRouting(
      "reasoning",
      FULL_CATALOG,
      { maxInputCostPerMillion: 1.5 },
      REFERENCE_ROUTING_POLICY,
    );
    expect(decision.kind).toBe("fallback");
    if (decision.kind === "fallback") {
      expect(decision.primary).toBe("claude-opus-4-6");
      // Backup is the first survivor in catalog order (catalog ordering
      // is the consumer's preference signal).
      expect(decision.backup).toBe("claude-haiku-4-5-20251001");
    }
  });

  it("output-cost ceiling independently filters", () => {
    // Output cap at $5/M output filters opus ($25), sonnet ($15), gpt-5.4
    // ($15), gpt-5.4-mini ($4.5 ok), gemini-pro ($10), gemini-flash-lite
    // ($0.4 ok), haiku ($5 ok at boundary), llama ($0.79 ok).
    const decision = dispatchRouting(
      "chat",
      FULL_CATALOG,
      { maxOutputCostPerMillion: 5.0 },
      REFERENCE_ROUTING_POLICY,
    );
    expect(decision.kind).toBe("fallback");
    if (decision.kind === "fallback") {
      expect(decision.primary).toBe("claude-sonnet-4-6"); // sonnet filtered
      // Backup should be the first survivor in catalog order. Haiku is
      // first in FULL_CATALOG among the surviving entries.
      expect(decision.backup).toBe("claude-haiku-4-5-20251001");
    }
  });
});

describe("applyBalanceFilter — pre-filter the catalog by affordability", () => {
  it("zero balance → empty catalog", () => {
    const filtered = applyBalanceFilter(FULL_CATALOG, 0);
    expect(filtered.length).toBe(0);
  });

  it("negative balance → empty catalog", () => {
    const filtered = applyBalanceFilter(FULL_CATALOG, -100);
    expect(filtered.length).toBe(0);
  });

  it("infinite balance → unchanged catalog", () => {
    const filtered = applyBalanceFilter(FULL_CATALOG, Number.MAX_SAFE_INTEGER);
    expect(filtered.length).toBe(FULL_CATALOG.length);
  });

  it("small balance keeps only the cheapest models", () => {
    // Estimated cost = 500 * input + 1000 * output (in cap-per-million
    // units, which the helper interprets as micro-USD directly). For
    // claude-haiku-4-5-20251001: 500*1 + 1000*5 = 5500. For
    // gemini-2.5-flash-lite: 500*0.1 + 1000*0.4 = 450. For llama:
    // 500*0.59 + 1000*0.79 = 1085. Setting balance to 1500 should keep
    // only the cheapest survivors.
    const filtered = applyBalanceFilter(FULL_CATALOG, 1500);
    const names = filtered.map((c) => c.modelName);
    expect(names).toContain("gemini-2.5-flash-lite");
    expect(names).toContain("llama-3.3-70b-versatile");
    expect(names).not.toContain("claude-opus-4-6"); // 500*5+1000*25 = 27500
  });

  it("composed with dispatchRouting — low balance + reasoning task → cheap fallback", () => {
    // Balance too low for Opus (the policy's reasoning pick); pre-filter
    // shrinks the catalog; dispatchRouting over the shrunk set falls
    // back to whatever survived.
    const balanceFiltered = applyBalanceFilter(FULL_CATALOG, 1500);
    const decision = dispatchRouting(
      "reasoning",
      balanceFiltered,
      NO_CONSTRAINTS,
      REFERENCE_ROUTING_POLICY,
    );
    expect(decision.kind).toBe("fallback");
    if (decision.kind === "fallback") {
      expect(decision.primary).toBe("claude-opus-4-6");
      // Backup is the first survivor in shrunk-catalog order
      expect(balanceFiltered.some((c) => c.modelName === decision.backup)).toBe(true);
    }
  });
});

describe("REFERENCE_ROUTING_POLICY — protocol surface contract", () => {
  it("covers every TaskShape in ALL_TASK_SHAPES", () => {
    for (const shape of ALL_TASK_SHAPES) {
      expect(REFERENCE_ROUTING_POLICY[shape]).toBeDefined();
      expect(typeof REFERENCE_ROUTING_POLICY[shape]).toBe("string");
      expect(REFERENCE_ROUTING_POLICY[shape].length).toBeGreaterThan(0);
    }
  });

  it("is frozen (immutable) per Object.freeze contract", () => {
    expect(Object.isFrozen(REFERENCE_ROUTING_POLICY)).toBe(true);
  });

  // Each known-arm model should be a recognizable production model
  it.each(Object.entries(REFERENCE_ROUTING_POLICY))(
    "%s → %s — model is a non-empty string",
    (shape, model) => {
      expect(model).toBeDefined();
      expect((model as string).length).toBeGreaterThan(0);
      // The protocol doesn't know about specific model names; the
      // policy carries them. Each arm must produce a routable string.
      expect(shape).toBeDefined();
    },
  );
});

describe("RoutingDecision — discriminated union exhaustiveness", () => {
  it("kind discriminator covers route + fallback + deny", () => {
    // Compile-time guarantee + runtime confirmation: every consumer
    // must handle all three. Drift gate `check-routing-decision-
    // coverage` enforces consumer files reference all three at the
    // structural level.
    const route = dispatchRouting("chat", FULL_CATALOG, NO_CONSTRAINTS, REFERENCE_ROUTING_POLICY);
    expect(["route", "fallback", "deny"]).toContain(route.kind);

    const noSonnet = FULL_CATALOG.filter((c) => c.modelName !== "claude-sonnet-4-6");
    const fallback = dispatchRouting("chat", noSonnet, NO_CONSTRAINTS, REFERENCE_ROUTING_POLICY);
    expect(["route", "fallback", "deny"]).toContain(fallback.kind);

    const deny = dispatchRouting("chat", [], NO_CONSTRAINTS, REFERENCE_ROUTING_POLICY);
    expect(["route", "fallback", "deny"]).toContain(deny.kind);
  });
});

describe("formatRoutingChip — chrome narration of routing decisions (PR 4)", () => {
  it("returns the model name for a 'route' decision", () => {
    // Calm-default: the chip surfaces just the model name when the
    // policy preference was available in the catalog. No decoration —
    // routine path doesn't need a visual cue.
    expect(formatRoutingChip({ kind: "route", model: "claude-sonnet-4-6", reason: "ok" })).toBe(
      "claude-sonnet-4-6",
    );
  });

  it("returns the backup model + swap glyph for a 'fallback' decision", () => {
    // The `↺` glyph is the visual cue that something was swapped.
    // Surfaces can hover-reveal `decision.reason` for the full story.
    expect(
      formatRoutingChip({
        kind: "fallback",
        primary: "gpt-5.4",
        backup: "claude-opus-4-7",
        reason: "Policy preferred gpt-5.4 for code, but it's not in the filtered catalog",
      }),
    ).toBe("claude-opus-4-7 ↺");
  });

  it("returns null for a 'deny' decision — no chip rendered (calm-software default)", () => {
    // `deny` means no model was picked; the consumer fell through to
    // its configured default. The chrome doesn't fabricate a label
    // when no routing happened.
    expect(formatRoutingChip({ kind: "deny", reason: "No catalog entries" })).toBeNull();
  });
});
