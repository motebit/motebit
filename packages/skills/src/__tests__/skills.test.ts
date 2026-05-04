import { beforeEach, describe, expect, it, vi } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import type { SkillEnvelope, SkillManifest } from "@motebit/protocol";
import { canonicalJson, hash, signSkillEnvelope, signSkillManifest } from "@motebit/crypto";

import {
  InMemorySkillStorageAdapter,
  SkillInstallError,
  SkillParseError,
  SkillRegistry,
  SkillSelector,
  parseSkillFile,
  type SkillAuditSink,
  type SkillRecord,
} from "../index";

if (!ed.hashes.sha512) {
  ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeKeypair() {
  const privateKey = ed.utils.randomSecretKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { privateKey, publicKey };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  return hash(bytes);
}

function makeUnsignedManifest(
  overrides: Partial<{
    name: string;
    description: string;
    sensitivity: SkillManifest["motebit"]["sensitivity"];
    platforms: SkillManifest["platforms"];
  }> = {},
): Omit<SkillManifest, "motebit"> & { motebit: Omit<SkillManifest["motebit"], "signature"> } {
  return {
    name: overrides.name ?? "example-skill",
    description: overrides.description ?? "Example procedure for testing.",
    version: "1.0.0",
    platforms: overrides.platforms ?? ["macos", "linux"],
    metadata: { category: "test", tags: ["example"] },
    motebit: {
      spec_version: "1.0",
      sensitivity: overrides.sensitivity ?? "none",
      hardware_attestation: { required: false, minimum_score: 0 },
    },
  };
}

const TEST_BODY = new TextEncoder().encode(
  "# Example\n\n## When to Use\n\nWhen the test fires.\n\n## Procedure\n\n1. Step.\n",
);

async function makeInstallableSignedSkill(opts: {
  name?: string;
  description?: string;
  sensitivity?: SkillManifest["motebit"]["sensitivity"];
  platforms?: SkillManifest["platforms"];
}): Promise<{
  manifest: SkillManifest;
  envelope: SkillEnvelope;
  body: Uint8Array;
}> {
  const { privateKey, publicKey } = await makeKeypair();
  const unsigned = makeUnsignedManifest(opts);
  const manifest = await signSkillManifest(unsigned, privateKey, publicKey, TEST_BODY);
  const contentBytes = new TextEncoder().encode(canonicalJson(manifest));
  const fullContent = new Uint8Array(contentBytes.length + 1 + TEST_BODY.length);
  fullContent.set(contentBytes, 0);
  fullContent[contentBytes.length] = 0x0a;
  fullContent.set(TEST_BODY, contentBytes.length + 1);
  const contentHash = await sha256Hex(fullContent);
  const bodyHash = await sha256Hex(TEST_BODY);

  const envelope = await signSkillEnvelope(
    {
      spec_version: "1.0",
      skill: { name: manifest.name, version: manifest.version, content_hash: contentHash },
      manifest,
      body_hash: bodyHash,
      files: [],
    },
    privateKey,
    publicKey,
  );

  return { manifest, envelope, body: TEST_BODY };
}

async function makeInstallableUnsignedSkill(opts: {
  name?: string;
  description?: string;
  sensitivity?: SkillManifest["motebit"]["sensitivity"];
  platforms?: SkillManifest["platforms"];
}): Promise<{
  manifest: SkillManifest;
  envelope: SkillEnvelope;
  body: Uint8Array;
}> {
  // Even an "unsigned" skill produces an envelope that IS signed by SOME key
  // (the spec requires the envelope to carry a signature; the manifest's
  // motebit.signature is what's absent). For a fully-unsigned skill we sign
  // the envelope with a throwaway key and omit motebit.signature from the
  // manifest. This reflects the v1 install pipeline reality: the envelope
  // itself always has a signature, but the *manifest's* `motebit.signature`
  // can be absent → the skill is "unsigned" from the agent's perspective.
  //
  // For tests of the truly-unsigned path, we instead skip the envelope
  // signature verification by using an empty manifest signature path. To
  // keep the test surface honest, this helper produces a manifest with NO
  // motebit.signature, signs the envelope with a generated key, and the
  // registry's install path will see provenance derived from the envelope
  // verify (which succeeds), so it counts as `verified`.
  //
  // Stance: a real "unsigned skill" means motebit.signature is absent; the
  // envelope still has its own signature for distribution integrity.
  const { privateKey, publicKey } = await makeKeypair();
  const manifest = makeUnsignedManifest(opts) as SkillManifest;
  const contentBytes = new TextEncoder().encode(canonicalJson(manifest));
  const fullContent = new Uint8Array(contentBytes.length + 1 + TEST_BODY.length);
  fullContent.set(contentBytes, 0);
  fullContent[contentBytes.length] = 0x0a;
  fullContent.set(TEST_BODY, contentBytes.length + 1);
  const contentHash = await sha256Hex(fullContent);
  const bodyHash = await sha256Hex(TEST_BODY);
  const envelope = await signSkillEnvelope(
    {
      spec_version: "1.0",
      skill: { name: manifest.name, version: manifest.version, content_hash: contentHash },
      manifest,
      body_hash: bodyHash,
      files: [],
    },
    privateKey,
    publicKey,
  );
  return { manifest, envelope, body: TEST_BODY };
}

// ---------------------------------------------------------------------------
// parseSkillFile
// ---------------------------------------------------------------------------

describe("parseSkillFile", () => {
  it("parses a well-formed SKILL.md", () => {
    const text = [
      "---",
      "name: hello-world",
      "description: A test skill.",
      "version: 1.0.0",
      "motebit:",
      '  spec_version: "1.0"',
      "---",
      "# Body",
      "",
      "Procedure.",
      "",
    ].join("\n");
    const { manifest, body } = parseSkillFile(text);
    expect(manifest.name).toBe("hello-world");
    expect(manifest.motebit.spec_version).toBe("1.0");
    expect(new TextDecoder().decode(body)).toContain("# Body");
  });

  it("strips BOM and normalizes CRLF to LF", () => {
    const text =
      '﻿---\r\nname: bom-test\r\ndescription: Test.\r\nversion: 1.0.0\r\nmotebit:\r\n  spec_version: "1.0"\r\n---\r\nbody-line\r\n';
    const { manifest, body } = parseSkillFile(text);
    expect(manifest.name).toBe("bom-test");
    // Body must be LF-only
    const decoded = new TextDecoder().decode(body);
    expect(decoded).not.toContain("\r");
    expect(decoded).toContain("body-line");
  });

  it("rejects missing opening delimiter", () => {
    const text = "name: bad\ndescription: x\n";
    expect(() => parseSkillFile(text)).toThrow(SkillParseError);
  });

  it("rejects missing closing delimiter", () => {
    const text =
      '---\nname: bad\ndescription: x\nversion: 1.0.0\nmotebit:\n  spec_version: "1.0"\n# no closer\n';
    expect(() => parseSkillFile(text)).toThrow(SkillParseError);
  });

  it("rejects schema-invalid frontmatter (missing motebit.spec_version)", () => {
    const text = [
      "---",
      "name: schemaless",
      "description: Has no motebit block.",
      "version: 1.0.0",
      "---",
      "body",
    ].join("\n");
    expect(() => parseSkillFile(text)).toThrow(SkillParseError);
  });
});

// ---------------------------------------------------------------------------
// SkillRegistry
// ---------------------------------------------------------------------------

describe("SkillRegistry.install", () => {
  let adapter: InMemorySkillStorageAdapter;
  let audit: ReturnType<typeof vi.fn>;
  let registry: SkillRegistry;

  beforeEach(() => {
    adapter = new InMemorySkillStorageAdapter();
    audit = vi.fn() as unknown as SkillAuditSink & ReturnType<typeof vi.fn>;
    registry = new SkillRegistry(adapter, { audit });
  });

  it("installs a signed skill with provenance `verified`", async () => {
    const { manifest, envelope, body } = await makeInstallableSignedSkill({});
    const result = await registry.install({ kind: "in_memory", manifest, envelope, body });
    expect(result.provenance_status).toBe("verified");
    expect(result.name).toBe("example-skill");
  });

  it("installs an unsigned skill (manifest has no motebit.signature) as `unsigned`", async () => {
    // The envelope IS signed (envelope schema requires signature for
    // distribution integrity), but the manifest itself has no
    // `motebit.signature`. Per spec §7.1, this surfaces as `"unsigned"`
    // provenance — install proceeds (permissive) but the selector's
    // gate rejects auto-load until the operator manually promotes via
    // `registry.trust()`. Pre-fix this collapsed to `"verified"`
    // because deriveProvenance only checked envelope sig; closing
    // that gap is what makes the trust-promotion path live.
    const { manifest, envelope, body } = await makeInstallableUnsignedSkill({});
    expect(manifest.motebit.signature).toBeUndefined();
    const result = await registry.install({ kind: "in_memory", manifest, envelope, body });
    expect(result.provenance_status).toBe("unsigned");
  });

  it("install + trust promotes an unsigned skill to `trusted_unsigned`", async () => {
    // The previously-unreachable path. Install an unsigned skill →
    // `unsigned`. Operator runs `registry.trust(name)` → `index.trusted`
    // flips to true. Subsequent `verify`/`list`/`get` calls report
    // `trusted_unsigned`. Per spec §7.1 the qualifier `[unverified]`
    // remains everywhere the skill surfaces — trust grants are audit
    // events, not cryptographic provenance.
    const { manifest, envelope, body } = await makeInstallableUnsignedSkill({});
    await registry.install({ kind: "in_memory", manifest, envelope, body });
    expect(await registry.verify(manifest.name)).toBe("unsigned");
    await registry.trust(manifest.name, "test-operator");
    expect(await registry.verify(manifest.name)).toBe("trusted_unsigned");
    // List + get reflect the same state.
    const list = await registry.list();
    expect(list.find((r) => r.index.name === manifest.name)?.provenance_status).toBe(
      "trusted_unsigned",
    );
    const got = await registry.get(manifest.name);
    expect(got?.provenance_status).toBe("trusted_unsigned");
  });

  it("untrust reverts a trusted_unsigned skill back to unsigned", async () => {
    const { manifest, envelope, body } = await makeInstallableUnsignedSkill({});
    await registry.install({ kind: "in_memory", manifest, envelope, body });
    await registry.trust(manifest.name);
    expect(await registry.verify(manifest.name)).toBe("trusted_unsigned");
    await registry.untrust(manifest.name);
    expect(await registry.verify(manifest.name)).toBe("unsigned");
  });

  it("signed skill installs as `verified` (manifest sig present + verifies)", async () => {
    // Counter-test: the verified path is unaffected by the unsigned-fix.
    // Manifest has a valid motebit.signature → "verified" regardless of
    // index.trusted (a trust grant on an already-verified skill is a
    // no-op for the displayed status — derivedStatusForEntry's first
    // branch matches before the trust check).
    const { manifest, envelope, body } = await makeInstallableSignedSkill({});
    expect(manifest.motebit.signature).toBeDefined();
    const result = await registry.install({ kind: "in_memory", manifest, envelope, body });
    expect(result.provenance_status).toBe("verified");
  });

  it("rejects install when envelope signature is tampered post-sign", async () => {
    const { manifest, envelope, body } = await makeInstallableSignedSkill({});
    const tamperedEnvelope: SkillEnvelope = {
      ...envelope,
      manifest: { ...envelope.manifest, version: "9.9.9" },
    };
    await expect(
      registry.install({ kind: "in_memory", manifest, envelope: tamperedEnvelope, body }),
    ).rejects.toBeInstanceOf(SkillInstallError);
  });

  it("rejects install on duplicate name without --force", async () => {
    const a = await makeInstallableSignedSkill({ name: "duplicate" });
    const b = await makeInstallableSignedSkill({ name: "duplicate" });
    await registry.install({ kind: "in_memory", ...a });
    await expect(registry.install({ kind: "in_memory", ...b })).rejects.toMatchObject({
      reason: "duplicate_name",
    });
  });

  it("rejects install when manifest.name disagrees with envelope.skill.name", async () => {
    const { manifest, envelope, body } = await makeInstallableSignedSkill({});
    const mismatched: SkillEnvelope = {
      ...envelope,
      skill: { ...envelope.skill, name: "different-name" },
    };
    await expect(
      registry.install({ kind: "in_memory", manifest, envelope: mismatched, body }),
    ).rejects.toMatchObject({ reason: "manifest_envelope_mismatch" });
  });

  it("rejects install when body exceeds size limit", async () => {
    const { manifest, envelope } = await makeInstallableSignedSkill({});
    const huge = new Uint8Array(60 * 1024); // > 50 KB default
    await expect(
      registry.install({ kind: "in_memory", manifest, envelope, body: huge }),
    ).rejects.toMatchObject({ reason: "size_limit_exceeded" });
  });
});

describe("SkillRegistry.trust + audit events", () => {
  it("emits skill_trust_grant audit event on trust()", async () => {
    const adapter = new InMemorySkillStorageAdapter();
    const audit = vi.fn();
    const registry = new SkillRegistry(adapter, { audit });
    const { manifest, envelope, body } = await makeInstallableSignedSkill({});
    await registry.install({ kind: "in_memory", manifest, envelope, body });
    await registry.trust(manifest.name, "did:key:z6Mk-operator");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "skill_trust_grant",
        skill_name: manifest.name,
        operator: "did:key:z6Mk-operator",
      }),
    );
  });

  it("emits skill_remove on remove()", async () => {
    const adapter = new InMemorySkillStorageAdapter();
    const audit = vi.fn();
    const registry = new SkillRegistry(adapter, { audit });
    const { manifest, envelope, body } = await makeInstallableSignedSkill({});
    await registry.install({ kind: "in_memory", manifest, envelope, body });
    await registry.remove(manifest.name);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ type: "skill_remove", skill_name: manifest.name }),
    );
  });
});

// ---------------------------------------------------------------------------
// SkillSelector
// ---------------------------------------------------------------------------

describe("SkillSelector", () => {
  let selector: SkillSelector;

  beforeEach(() => {
    selector = new SkillSelector();
  });

  async function buildRecords(): Promise<SkillRecord[]> {
    const adapter = new InMemorySkillStorageAdapter();
    const registry = new SkillRegistry(adapter);
    for (const opts of [
      { name: "git-commit-help", description: "Help craft good git commit messages." },
      { name: "linter-fix", description: "Fix linter errors and code style." },
      { name: "review-pr", description: "Review a pull request and surface concerns." },
    ]) {
      const { manifest, envelope, body } = await makeInstallableSignedSkill(opts);
      await registry.install({ kind: "in_memory", manifest, envelope, body });
    }
    return registry.list();
  }

  it("ranks skills by relevance to the turn (BM25 over description)", async () => {
    const records = await buildRecords();
    const result = selector.select(records, {
      turn: "help me write a git commit message",
      sessionSensitivity: "none",
      hardwareAttestationScore: 1,
      platform: "macos",
    });
    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.selected[0]?.name).toBe("git-commit-help");
  });

  it("filters disabled skills with reason `disabled`", async () => {
    const adapter = new InMemorySkillStorageAdapter();
    const registry = new SkillRegistry(adapter);
    const { manifest, envelope, body } = await makeInstallableSignedSkill({});
    await registry.install({ kind: "in_memory", manifest, envelope, body });
    await registry.disable(manifest.name);
    const records = await registry.list();
    const result = selector.select(records, {
      turn: "anything",
      sessionSensitivity: "none",
      hardwareAttestationScore: 1,
      platform: "macos",
    });
    expect(result.selected).toHaveLength(0);
    expect(result.filtered).toContainEqual(
      expect.objectContaining({ name: manifest.name, reason: "disabled" }),
    );
  });

  it("filters platform mismatches", async () => {
    const adapter = new InMemorySkillStorageAdapter();
    const registry = new SkillRegistry(adapter);
    const { manifest, envelope, body } = await makeInstallableSignedSkill({
      platforms: ["windows"],
    });
    await registry.install({ kind: "in_memory", manifest, envelope, body });
    const records = await registry.list();
    const result = selector.select(records, {
      turn: "example",
      sessionSensitivity: "none",
      hardwareAttestationScore: 1,
      platform: "macos",
    });
    expect(result.filtered).toContainEqual(
      expect.objectContaining({ reason: "platform_mismatch" }),
    );
  });

  it("filters medical-tier skills regardless of session tier (auto-load wall)", async () => {
    const adapter = new InMemorySkillStorageAdapter();
    const registry = new SkillRegistry(adapter);
    const { manifest, envelope, body } = await makeInstallableSignedSkill({
      sensitivity: "medical",
    });
    await registry.install({ kind: "in_memory", manifest, envelope, body });
    const records = await registry.list();
    const result = selector.select(records, {
      turn: "anything",
      sessionSensitivity: "secret", // even at the highest tier
      hardwareAttestationScore: 1,
      platform: "macos",
    });
    expect(result.selected).toHaveLength(0);
    expect(result.filtered).toContainEqual(
      expect.objectContaining({ reason: "sensitivity_above_session" }),
    );
  });

  it("respects the topK cap", async () => {
    const records = await buildRecords();
    const result = selector.select(records, {
      turn: "code review pull request commit lint fix",
      sessionSensitivity: "none",
      hardwareAttestationScore: 1,
      platform: "macos",
      topK: 1,
    });
    expect(result.selected).toHaveLength(1);
  });

  it("trust grant promotes an unsigned skill to selectable", async () => {
    // Pre-fix this test had to acknowledge that the trust-grant path
    // couldn't be exercised because deriveProvenance only checked the
    // envelope sig, collapsing every install to "verified". With both
    // signatures honored, the path is now real: install an unsigned
    // manifest → "unsigned" → selector blocks → operator trusts →
    // "trusted_unsigned" → selector permits.
    const adapter = new InMemorySkillStorageAdapter();
    const registry = new SkillRegistry(adapter);
    const { manifest, envelope, body } = await makeInstallableUnsignedSkill({});
    await registry.install({ kind: "in_memory", manifest, envelope, body });

    // Before trust grant: provenance is "unsigned" — the selector's
    // provenance gate (per spec §7.1) blocks auto-load.
    const recordsBefore = await registry.list();
    expect(recordsBefore[0]?.provenance_status).toBe("unsigned");
    const beforeResult = selector.select(recordsBefore, {
      turn: "example",
      sessionSensitivity: "none",
      hardwareAttestationScore: 1,
      platform: "macos",
    });
    expect(beforeResult.selected.length).toBe(0);
    // The skill is in `filtered` with the untrusted reason recorded —
    // selector tag for "manifest sig absent and operator hasn't promoted."
    expect(
      beforeResult.filtered.some((f) => f.name === manifest.name && f.reason === "untrusted"),
    ).toBe(true);

    // Operator promotes via trust(). Provenance flips to
    // "trusted_unsigned"; selector now admits.
    await registry.trust(manifest.name, "test-operator");
    const recordsAfter = await registry.list();
    expect(recordsAfter[0]?.provenance_status).toBe("trusted_unsigned");
    const afterResult = selector.select(recordsAfter, {
      turn: "example",
      sessionSensitivity: "none",
      hardwareAttestationScore: 1,
      platform: "macos",
    });
    expect(afterResult.selected.length).toBeGreaterThanOrEqual(1);
  });
});
