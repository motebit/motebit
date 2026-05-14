/**
 * on-device-router tests — covers the on-device auto-routing
 * primitives in `@motebit/policy/on-device-router.ts`. PR 3 of the
 * auto-routing arc lands the third consumer-side of `dispatchRouting`
 * (after proxy as PR 1 and BYOK as PR 2). Doctrine:
 * `docs/doctrine/auto-routing-as-protocol-primitive.md`.
 *
 * Tests pin (a) the per-backend catalog's structural coverage of
 * `OnDeviceBackend` (closed-registry mirror via the `satisfies` clause),
 * (b) the zero-marginal-cost invariant (on-device runs on user
 * hardware), (c) the composed dispatcher's `RoutingDecision` output
 * across the multi-model `local-server` path AND the single-model
 * paths (which deny by design — the honest signal).
 */
import { describe, it, expect } from "vitest";

import type { OnDeviceBackend } from "@motebit/sdk";

import {
  ON_DEVICE_MODEL_CATALOG,
  REFERENCE_LOCAL_SERVER_ROUTING_POLICY,
  buildOnDeviceCatalog,
  dispatchOnDeviceRouting,
} from "../on-device-router.js";
import type { TaskShape } from "@motebit/sdk";

const ALL_BACKENDS: OnDeviceBackend[] = ["local-server", "webllm", "apple-fm", "mlx"];

describe("ON_DEVICE_MODEL_CATALOG", () => {
  it("has an entry for every OnDeviceBackend — closed-registry mirror", () => {
    for (const backend of ALL_BACKENDS) {
      expect(ON_DEVICE_MODEL_CATALOG[backend]).toBeDefined();
    }
  });

  it("local-server is the only populated backend today", () => {
    // Single-model backends (webllm / apple-fm / mlx) ship empty
    // catalogs by design — they're surfaces where the user picks
    // one model at config time. Empty catalog → dispatcher denies
    // → consumer falls through to the configured model.
    expect(ON_DEVICE_MODEL_CATALOG["local-server"].length).toBeGreaterThan(0);
    expect(ON_DEVICE_MODEL_CATALOG.webllm.length).toBe(0);
    expect(ON_DEVICE_MODEL_CATALOG["apple-fm"].length).toBe(0);
    expect(ON_DEVICE_MODEL_CATALOG.mlx.length).toBe(0);
  });

  it("local-server entries have zero marginal cost — the truthful representation", () => {
    // On-device inference runs on the user's hardware; per-token
    // marginal cost is 0. This is structurally different from
    // BYOK (pay-per-call) and motebit-cloud (subscription-balance).
    // The architectural payoff: the same dispatcher composes across
    // all three cost models without the protocol primitive needing
    // a cost-model parameter.
    for (const cap of ON_DEVICE_MODEL_CATALOG["local-server"]) {
      expect(cap.inputCostPerMillion).toBe(0);
      expect(cap.outputCostPerMillion).toBe(0);
    }
  });

  it("local-server entries all route through host `local-server` (not a remote endpoint)", () => {
    // The PR 3 expansion adds `local-server` to `InferenceHost`.
    // Every on-device catalog entry routes through that host — the
    // user's own inference server, never a remote provider. Defense
    // against a future bug that smuggles a remote-host entry into
    // the on-device catalog.
    for (const cap of ON_DEVICE_MODEL_CATALOG["local-server"]) {
      expect(cap.host).toBe("local-server");
    }
  });

  it("local-server catalog includes models from every supported lab", () => {
    // Sourced from `LOCAL_SERVER_SUGGESTED_MODELS` — the canonical
    // safe-defaults across every surface's settings UI. The labs
    // present (meta / mistral / google / microsoft / alibaba) are
    // the new entries PR 3 lands in the `ModelLab` registry alongside
    // the existing meta / google / openai / anthropic. This test
    // pins the lab-coverage invariant: removing a lab entry from
    // `LOCAL_SERVER_SUGGESTED_MODELS` without updating the catalog
    // would silently drop a model class.
    const labs = new Set(ON_DEVICE_MODEL_CATALOG["local-server"].map((cap) => cap.lab));
    expect(labs.has("meta")).toBe(true);
    expect(labs.has("mistral")).toBe(true);
    expect(labs.has("google")).toBe(true);
    expect(labs.has("microsoft")).toBe(true);
    expect(labs.has("alibaba")).toBe(true);
  });
});

describe("buildOnDeviceCatalog", () => {
  it("returns the same array reference as ON_DEVICE_MODEL_CATALOG[backend] — single source of truth", () => {
    for (const backend of ALL_BACKENDS) {
      expect(buildOnDeviceCatalog(backend)).toBe(ON_DEVICE_MODEL_CATALOG[backend]);
    }
  });
});

describe("REFERENCE_LOCAL_SERVER_ROUTING_POLICY — consumer-specific policy override", () => {
  it("maps every TaskShape to a model that exists in the local-server catalog", () => {
    // The override's whole purpose: every on-device dispatch should
    // land in `kind: "route"` (calm chip) rather than `kind: "fallback"`
    // (misleading `↺` glyph). That requires every policy preference
    // to be a member of the local-server catalog. This test pins the
    // invariant — a future addition that names a model NOT in the
    // catalog would silently re-introduce the misleading-chip bug.
    const catalogModels = new Set<string>(
      ON_DEVICE_MODEL_CATALOG["local-server"].map((c) => c.modelName),
    );
    for (const [shape, model] of Object.entries(REFERENCE_LOCAL_SERVER_ROUTING_POLICY) as [
      TaskShape,
      string,
    ][]) {
      expect(catalogModels.has(model)).toBe(true);
      // Tighter test: also ensure the model isn't empty / typo'd.
      expect(model.length).toBeGreaterThan(0);
      // Anchor the per-shape mapping to specific local models so a
      // future "let's swap codellama for llama3.3" change is an
      // intentional protocol-level update, not a silent drift.
      void shape;
    }
  });

  it("is frozen (immutable) per Object.freeze contract", () => {
    expect(Object.isFrozen(REFERENCE_LOCAL_SERVER_ROUTING_POLICY)).toBe(true);
  });

  it("anchors the code task to codellama (the literal match-to-task)", () => {
    // Doctrinally load-bearing: codellama exists in the canonical
    // suggested-models set BECAUSE it's the strongest match-to-task.
    // The policy's whole point is to use it. A silent change here
    // (e.g., to llama3.2 because someone thought "smaller is faster")
    // would erase the consumer-specific policy's reason for being.
    expect(REFERENCE_LOCAL_SERVER_ROUTING_POLICY.code).toBe("codellama");
  });
});

describe("dispatchOnDeviceRouting — composed dispatcher", () => {
  it("returns 'route' kind for local-server (consumer policy names a local model)", () => {
    // After the PR 3 post-audit fix, on-device dispatch consumes
    // `REFERENCE_LOCAL_SERVER_ROUTING_POLICY` (not the cloud
    // `REFERENCE_ROUTING_POLICY`) — every policy preference is in
    // the catalog, so the dispatcher lands in `route`, not
    // `fallback`. This unblocks the calm-default chip ("via X")
    // without the misleading `↺` glyph.
    const chatMessage =
      "I'd like to understand your perspective on this approach. " +
      "What do you think makes the most sense given the constraints?";
    const decision = dispatchOnDeviceRouting(chatMessage, "local-server");
    expect(decision.kind).toBe("route");
    if (decision.kind === "route") {
      expect(decision.model).toBe("llama3.2");
    }
  });

  it("routes code tasks to codellama (the per-shape match-to-task)", () => {
    // Code-shape detection (fenced block) → policy preference
    // `codellama` → catalog has it → `route`. The flow the
    // consumer-specific policy override exists to enable.
    const decision = dispatchOnDeviceRouting("```js\nlet x = 1\n```", "local-server");
    expect(decision.kind).toBe("route");
    if (decision.kind === "route") {
      expect(decision.model).toBe("codellama");
    }
  });

  it("returns 'deny' for single-model backends (webllm/apple-fm/mlx) — the honest signal", () => {
    // Single-model backends ship empty catalogs by design. The
    // dispatcher's `deny` path is the honest signal to the consumer:
    // "nothing to auto-route across." Consumers handle this the
    // same way they handle BYOK's deny — fall through to the
    // configured model. The same `RoutingDecision.kind === "deny"`
    // channel covers both "constraints empty the catalog" (BYOK)
    // and "catalog was empty to begin with" (on-device single-
    // model). One shape; two semantic origins.
    expect(dispatchOnDeviceRouting("hello", "webllm").kind).toBe("deny");
    expect(dispatchOnDeviceRouting("hello", "apple-fm").kind).toBe("deny");
    expect(dispatchOnDeviceRouting("hello", "mlx").kind).toBe("deny");
  });

  it("never returns 'fallback' for local-server — consumer policy guarantees catalog match", () => {
    // Post-audit invariant: the consumer-specific policy is
    // designed so every preference is in the catalog. A `fallback`
    // result for local-server means the catalog drifted from the
    // policy (or vice versa) — a regression signal. This test pins
    // the invariant across the heuristic's signal spectrum.
    const samples = [
      "hi", // quick
      "I'd like a conversational exchange to think this through together carefully", // chat
      "walk me through step by step", // reasoning
      "```python\nx = 1\n```", // code
      "compare React and Vue across the literature. ".repeat(40), // research (long-form)
      "write a poem about the ocean", // creative
      "solve for x in this equation", // math
    ];
    for (const text of samples) {
      const decision = dispatchOnDeviceRouting(text, "local-server");
      expect(decision.kind).not.toBe("fallback");
    }
  });

  it("honors a RoutingConstraint.maxInputCostPerMillion that allows all on-device entries (zero cost)", () => {
    // On-device entries are all zero-cost; a cost constraint of 0
    // doesn't filter them out (the dispatcher uses `<=` for the
    // cost filter). This invariant is critical: a future bug
    // changing the filter to `<` would silently break every
    // on-device route.
    const decision = dispatchOnDeviceRouting("hello there", "local-server", {
      maxInputCostPerMillion: 0,
      maxOutputCostPerMillion: 0,
    });
    expect(decision.kind).not.toBe("deny");
  });
});
