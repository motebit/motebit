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
import type { SkillAuditEvent } from "@motebit/skills";

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
      // The adapter only ever calls install with `kind: "in_memory"` —
      // the directory/git/url paths in `SkillInstallSource` are upstream
      // resolution kinds the registry's fs-adapter handles, not the
      // shape that crosses the registry's install boundary. Narrow.
      if (source.kind !== "in_memory") {
        return Promise.reject(new Error(`unexpected install kind in test: ${source.kind}`));
      }
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
  // Adapter never inspects the envelope's signature or spec_version —
  // they're forwarded verbatim into registry.install and the registry
  // verifies them via @motebit/crypto. The test casts past the
  // strict envelope shape because the fixture's only purpose is to
  // exercise the consent-gate dispatch on `manifest.motebit.sensitivity`.
  return {
    submitter_motebit_id: "did:key:zTestSubmitter",
    envelope: {
      spec_version: "1.0",
      skill: { name, version: "1.0.0", content_hash: "0".repeat(64) },
      manifest: {
        name,
        version: "1.0.0",
        description: `Fixture skill (${sensitivity})`,
        platforms: ["macos", "linux"],
        metadata: { category: "test" },
        motebit: { spec_version: "1.0", sensitivity },
      },
      body_hash: "0".repeat(64),
      files: [],
      signature: {
        suite: "motebit-jcs-ed25519-b64-v1",
        public_key: "0".repeat(64),
        value: "fixture",
      },
    },
    body: btoa("# fixture body\n"),
    files: {},
    submitted_at: 1_700_000_000_000,
    featured: false,
  } as SkillBundleShape;
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
// Audit emission — `skill_consent_granted` after a sensitive-tier install
// ---------------------------------------------------------------------------

describe("RegistryBackedSkillsPanelAdapter audit emission", () => {
  it("emits skill_consent_granted to the audit sink after a sensitive install resolves", async () => {
    const registry = makeFakeRegistry();
    const events: SkillAuditEvent[] = [];
    const audit = vi.fn((event: SkillAuditEvent) => {
      events.push(event);
    });
    const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
      fetchBundle: () => Promise.resolve(makeBundle("medical")),
      requestInstallConsent: () => Promise.resolve(true),
      audit,
      surface: "test-surface",
    });
    await adapter.installFromSource({ kind: "url", url: "test://medical" });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "skill_consent_granted",
      skill_name: "fixture-skill",
      skill_version: "1.0.0",
      content_hash: "0".repeat(64),
      sensitivity: "medical",
      surface: "test-surface",
    });
    expect(typeof events[0]!.at).toBe("string");
    expect(new Date(events[0]!.at).getTime()).not.toBeNaN();
  });

  it("does NOT emit skill_consent_granted when sensitivity is below the consent threshold", async () => {
    const registry = makeFakeRegistry();
    const audit = vi.fn();
    const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
      fetchBundle: () => Promise.resolve(makeBundle("personal")),
      requestInstallConsent: () => Promise.resolve(true),
      audit,
      surface: "test-surface",
    });
    await adapter.installFromSource({ kind: "url", url: "test://personal" });
    expect(audit).not.toHaveBeenCalled();
  });

  it("does NOT emit skill_consent_granted when consent is declined", async () => {
    // Decline path throws SkillConsentDeclined before install runs; no
    // consent grant existed to record. Counter-test: a future change that
    // accidentally emits on decline would create a false-positive trail.
    const registry = makeFakeRegistry();
    const audit = vi.fn();
    const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
      fetchBundle: () => Promise.resolve(makeBundle("medical")),
      requestInstallConsent: () => Promise.resolve(false),
      audit,
      surface: "test-surface",
    });
    await expect(
      adapter.installFromSource({ kind: "url", url: "test://decline" }),
    ).rejects.toBeInstanceOf(SkillConsentDeclined);
    expect(audit).not.toHaveBeenCalled();
  });

  it("tags the consent event with `surface: 'unknown'` when host omits the surface option", async () => {
    const registry = makeFakeRegistry();
    const events: SkillAuditEvent[] = [];
    const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
      fetchBundle: () => Promise.resolve(makeBundle("financial")),
      requestInstallConsent: () => Promise.resolve(true),
      audit: (event) => {
        events.push(event);
      },
    });
    await adapter.installFromSource({ kind: "url", url: "test://no-surface" });
    expect(events[0]).toMatchObject({ surface: "unknown" });
  });

  it("audit-sink failure does NOT block the install — install resolves regardless", async () => {
    // Best-effort durability: losing an audit record is better than
    // losing a user's explicit approval. The adapter logs + continues.
    const registry = makeFakeRegistry();
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const adapter = new RegistryBackedSkillsPanelAdapter(registry, {
      fetchBundle: () => Promise.resolve(makeBundle("medical")),
      requestInstallConsent: () => Promise.resolve(true),
      audit: () => Promise.reject(new Error("disk full")),
      surface: "test-surface",
    });
    const result = await adapter.installFromSource({ kind: "url", url: "test://audit-fails" });
    expect(result.name).toBe("fixture-skill");
    expect(registry.installCalls).toHaveLength(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("skill_consent_granted audit emit failed"),
      expect.any(Error),
    );
    consoleSpy.mockRestore();
  });

  it("does NOT emit when registry.install fails — no false approval trail", async () => {
    // Order matters: emit only after install resolves. If install
    // fails (size limit, manifest mismatch, verification failure on a
    // tampered envelope), the user's intent never landed, so no
    // consent record should exist.
    const events: SkillAuditEvent[] = [];
    const failingRegistry: SkillRegistryShape = {
      ...makeFakeRegistry(),
      install: () => Promise.reject(new Error("size_limit_exceeded: too big")),
    };
    const adapter = new RegistryBackedSkillsPanelAdapter(failingRegistry, {
      fetchBundle: () => Promise.resolve(makeBundle("secret")),
      requestInstallConsent: () => Promise.resolve(true),
      audit: (event) => {
        events.push(event);
      },
      surface: "test-surface",
    });
    await expect(
      adapter.installFromSource({ kind: "url", url: "test://install-fails" }),
    ).rejects.toThrow(/size_limit_exceeded/);
    expect(events).toHaveLength(0);
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
