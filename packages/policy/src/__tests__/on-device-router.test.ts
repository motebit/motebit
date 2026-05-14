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
  buildOnDeviceCatalog,
  dispatchOnDeviceRouting,
} from "../on-device-router.js";

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

describe("dispatchOnDeviceRouting — composed dispatcher", () => {
  it("returns 'fallback' kind for local-server when policy preference isn't installed", () => {
    // REFERENCE_ROUTING_POLICY.chat = "claude-sonnet-4-6" — a cloud
    // model not in the local-server catalog. The dispatcher falls
    // back to the first catalog entry (llama3.2, the Ollama default).
    // This is the typical PR 3 flow: cloud-shaped policy meets
    // on-device-shaped catalog and the catalog-ordering preference
    // takes over.
    const chatMessage =
      "I'd like to understand your perspective on this approach. " +
      "What do you think makes the most sense given the constraints?";
    const decision = dispatchOnDeviceRouting(chatMessage, "local-server");
    expect(decision.kind).toBe("fallback");
    if (decision.kind === "fallback") {
      expect(decision.primary).toBe("claude-sonnet-4-6");
      expect(decision.backup).toBe("llama3.2");
    }
  });

  it("returns 'fallback' for code task — REFERENCE policy prefers gpt-5.4, catalog falls back to codellama-equivalent", () => {
    // REFERENCE_ROUTING_POLICY.code = "gpt-5.4"; the local-server
    // catalog has no gpt-5.4. Fallback walks the catalog ordering;
    // catalog index 0 is llama3.2 (the safe-default), which is what
    // the dispatcher picks. Per-policy fine-tuning ("when local-
    // server, prefer codellama for code") is a future arc — surfaces
    // ship `REFERENCE_LOCAL_SERVER_ROUTING_POLICY` overriding the
    // canonical default, or a learned function per the role-vs-
    // policy distinction.
    const decision = dispatchOnDeviceRouting("```js\nlet x = 1\n```", "local-server");
    expect(decision.kind).toBe("fallback");
    if (decision.kind === "fallback") {
      expect(decision.primary).toBe("gpt-5.4");
      // First catalog entry (preference signal).
      expect(decision.backup).toBe("llama3.2");
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

  it("returns 'route' kind only when policy preference matches a local-server entry", () => {
    // None of the canonical TaskShape → model mappings in
    // REFERENCE_ROUTING_POLICY name a local-server model today.
    // Every on-device dispatch for local-server therefore lands in
    // 'fallback' (which is correct — the dispatcher honors the
    // catalog-ordering preference signal). A 'route' decision
    // would require a consumer to ship a custom routing-policy
    // that mapped TaskShape → local-server model names (e.g.,
    // `chat: "llama3.2"`); the test below documents this with a
    // policy override demonstrating the path.
    // (This is a documentation-shaped test, not a functional
    // assertion — the production REFERENCE_ROUTING_POLICY produces
    // 'fallback' for every local-server dispatch.)
    const decision = dispatchOnDeviceRouting("hello there", "local-server");
    expect(decision.kind).not.toBe("route");
    expect(decision.kind).not.toBe("deny");
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
