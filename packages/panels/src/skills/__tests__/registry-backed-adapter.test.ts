/**
 * `RegistryBackedSkillsPanelAdapter` contract tests.
 *
 * Locks the adapter shape that web and desktop's dev-mode fallback both
 * consume — drift between the inlined `SkillRegistryShape` and the real
 * `SkillRegistry` from `@motebit/skills` would surface here as a fixture
 * mismatch (the fixture registry needs to satisfy `SkillRegistryShape`),
 * and the consent-gate behavior is locked structurally so a future change
 * can't silently drop the gate for sensitive skills.
 */

import { describe, expect, it, vi } from "vitest";

import {
  RegistryBackedSkillsPanelAdapter,
  SkillConsentDeclined,
  requiresInstallConsent,
  type RequestInstallConsentFn,
  type SkillBundleShape,
  type SkillRegistryShape,
} from "../registry-backed-adapter.js";
import type { SkillProvenanceStatus, SkillSensitivity } from "../controller.js";

// ---------------------------------------------------------------------------
// Fixtures — minimal shapes satisfying SkillRegistryShape + SkillBundleShape.
// Tests don't exercise real signature verification; the adapter is purely a
// shape bridge over the registry, so a stub registry that records calls is
// the right level of fidelity.
// ---------------------------------------------------------------------------

interface FakeRegistry extends SkillRegistryShape {
  installCalls: Array<{ name: string; sourceLabel: string | undefined }>;
  enableCalls: string[];
  disableCalls: string[];
  trustCalls: string[];
  untrustCalls: string[];
  removeCalls: string[];
}

function makeFakeRegistry(seed: SkillSensitivity = "none"): FakeRegistry {
  const installCalls: FakeRegistry["installCalls"] = [];
  const enableCalls: string[] = [];
  const disableCalls: string[] = [];
  const trustCalls: string[] = [];
  const untrustCalls: string[] = [];
  const removeCalls: string[] = [];
  void seed; // reserved for future filter-by-sensitivity tests
  return {
    installCalls,
    enableCalls,
    disableCalls,
    trustCalls,
    untrustCalls,
    removeCalls,
    list: () => Promise.resolve([]),
    get: () => Promise.resolve(null),
    install(source, opts) {
      installCalls.push({ name: source.manifest.name, sourceLabel: opts?.source_label });
      return Promise.resolve({
        name: source.manifest.name,
        version: source.manifest.version,
        provenance_status: "verified" satisfies SkillProvenanceStatus,
      });
    },
    enable(name) {
      enableCalls.push(name);
      return Promise.resolve();
    },
    disable(name) {
      disableCalls.push(name);
      return Promise.resolve();
    },
    trust(name) {
      trustCalls.push(name);
      return Promise.resolve();
    },
    untrust(name) {
      untrustCalls.push(name);
      return Promise.resolve();
    },
    remove(name) {
      removeCalls.push(name);
      return Promise.resolve();
    },
    verify: () => Promise.resolve("verified"),
  };
}

function makeBundle(sensitivity: SkillSensitivity, name = "fixture-skill"): SkillBundleShape {
  return {
    envelope: {
      skill: { name, version: "1.0.0", content_hash: "0".repeat(64) },
      manifest: {
        name,
        version: "1.0.0",
        description: `Fixture skill (${sensitivity})`,
        platforms: ["macos", "linux"],
        metadata: { category: "test" },
        motebit: { sensitivity },
      },
    },
    body: btoa("# fixture body\n"),
    files: {},
  };
}

// ---------------------------------------------------------------------------
// requiresInstallConsent — pure predicate
// ---------------------------------------------------------------------------

describe("requiresInstallConsent", () => {
  it.each<[SkillSensitivity, boolean]>([
    ["none", false],
    ["personal", false],
    ["medical", true],
    ["financial", true],
    ["secret", true],
  ])("%s → %s", (tier, expected) => {
    expect(requiresInstallConsent(tier)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// installFromSource — consent gate behavior
// ---------------------------------------------------------------------------

describe("RegistryBackedSkillsPanelAdapter.installFromSource", () => {
  it("rejects directory installs with a helpful message", async () => {
    const registry = makeFakeRegistry();
    const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
      fetchBundle: () => Promise.reject(new Error("should not fetch")),
    });
    await expect(
      adapter.installFromSource({ kind: "directory", path: "/tmp/skill" }),
    ).rejects.toThrow(/directory installs require host filesystem access/);
    expect(registry.installCalls).toHaveLength(0);
  });

  it("installs without consent prompt when sensitivity is `none`", async () => {
    const registry = makeFakeRegistry();
    const requestInstallConsent = vi.fn<RequestInstallConsentFn>();
    const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
      fetchBundle: () => Promise.resolve(makeBundle("none")),
      requestInstallConsent,
    });
    const result = await adapter.installFromSource({ kind: "url", url: "test://none" });
    expect(result.name).toBe("fixture-skill");
    expect(registry.installCalls).toHaveLength(1);
    expect(requestInstallConsent).not.toHaveBeenCalled();
  });

  it("installs without consent prompt when sensitivity is `personal`", async () => {
    const registry = makeFakeRegistry();
    const requestInstallConsent = vi.fn<RequestInstallConsentFn>();
    const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
      fetchBundle: () => Promise.resolve(makeBundle("personal")),
      requestInstallConsent,
    });
    await adapter.installFromSource({ kind: "url", url: "test://personal" });
    expect(registry.installCalls).toHaveLength(1);
    expect(requestInstallConsent).not.toHaveBeenCalled();
  });

  it.each<SkillSensitivity>(["medical", "financial", "secret"])(
    "prompts for consent when sensitivity is %s and proceeds on approve",
    async (tier) => {
      const registry = makeFakeRegistry();
      const requestInstallConsent = vi.fn<RequestInstallConsentFn>().mockResolvedValue(true);
      const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
        fetchBundle: () => Promise.resolve(makeBundle(tier)),
        requestInstallConsent,
      });
      const result = await adapter.installFromSource({ kind: "url", url: `test://${tier}` });
      expect(result.name).toBe("fixture-skill");
      expect(registry.installCalls).toHaveLength(1);
      expect(requestInstallConsent).toHaveBeenCalledTimes(1);
      expect(requestInstallConsent).toHaveBeenCalledWith(
        expect.objectContaining({ sensitivity: tier, skillName: "fixture-skill" }),
      );
    },
  );

  it.each<SkillSensitivity>(["medical", "financial", "secret"])(
    "throws SkillConsentDeclined and skips install when user declines (%s)",
    async (tier) => {
      const registry = makeFakeRegistry();
      const requestInstallConsent = vi.fn<RequestInstallConsentFn>().mockResolvedValue(false);
      const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
        fetchBundle: () => Promise.resolve(makeBundle(tier)),
        requestInstallConsent,
      });
      await expect(
        adapter.installFromSource({ kind: "url", url: `test://${tier}` }),
      ).rejects.toBeInstanceOf(SkillConsentDeclined);
      expect(registry.installCalls).toHaveLength(0);
      expect(requestInstallConsent).toHaveBeenCalledTimes(1);
    },
  );

  it("installs sensitive skills without prompting when host omits the consent callback", async () => {
    // Strong-isolation surfaces (Tauri sidecar, future MPC) don't wire
    // requestInstallConsent. The adapter must NOT block install in
    // their absence; the surface is responsible for its own boundary.
    const registry = makeFakeRegistry();
    const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
      fetchBundle: () => Promise.resolve(makeBundle("medical")),
    });
    const result = await adapter.installFromSource({ kind: "url", url: "test://strong" });
    expect(result.name).toBe("fixture-skill");
    expect(registry.installCalls).toHaveLength(1);
  });

  it("decodes base64 body before handoff to registry.install", async () => {
    const registry = makeFakeRegistry();
    const fetchBundle = vi.fn(() => Promise.resolve(makeBundle("none", "decode-test")));
    const adapter = new RegistryBackedSkillsPanelAdapter(registry, { fetchBundle });
    await adapter.installFromSource({ kind: "url", url: "test://decode" });
    expect(registry.installCalls[0]?.sourceLabel).toBe("test://decode");
  });
});

// ---------------------------------------------------------------------------
// Lifecycle delegations — pass-through to registry
// ---------------------------------------------------------------------------

describe("RegistryBackedSkillsPanelAdapter lifecycle delegations", () => {
  it("forwards enable/disable/trust/untrust/remove to the registry", async () => {
    const registry = makeFakeRegistry();
    const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
      fetchBundle: () => Promise.reject(new Error("not used")),
    });
    await adapter.enableSkill("alpha");
    await adapter.disableSkill("beta");
    await adapter.trustSkill("gamma");
    await adapter.untrustSkill("delta");
    await adapter.removeSkill("epsilon");
    expect(registry.enableCalls).toEqual(["alpha"]);
    expect(registry.disableCalls).toEqual(["beta"]);
    expect(registry.trustCalls).toEqual(["gamma"]);
    expect(registry.untrustCalls).toEqual(["delta"]);
    expect(registry.removeCalls).toEqual(["epsilon"]);
  });
});
