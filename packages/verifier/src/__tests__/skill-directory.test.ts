/**
 * Directory-walker tests for `verifySkillDirectory`. Builds a real
 * signed skill-envelope.json + SKILL.md (+ optional auxiliary files)
 * in a tmp dir, then exercises the happy path and every tamper mode.
 *
 * The verifier's directory walker is the canonical full-verify entry
 * point for skills — sig + body_hash + per-file-hash all on disk. That
 * makes it the tool agentskills.io users run against any skill they
 * downloaded from anywhere; tests cover the same paths.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha512";

import { signSkillEnvelope, hash as sha256Hex, type SkillVerifyResult } from "@motebit/crypto";
import type { SkillEnvelope, SkillManifest, SkillSignature } from "@motebit/protocol";

import { verifyFile, verifySkillDirectory, formatHuman } from "../lib.js";

beforeAll(() => {
  if (!ed.hashes.sha512) {
    ed.hashes.sha512 = (msg: Uint8Array) => sha512(msg);
  }
});

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function makeManifest(sig: SkillSignature): SkillManifest {
  return {
    name: "fixture-skill",
    description: "test fixture skill",
    version: "1.0.0",
    platforms: ["macos", "linux"],
    metadata: { author: "test", category: "software-development", tags: ["test"] },
    motebit: {
      spec_version: "1.0",
      sensitivity: "none",
      hardware_attestation: { required: false, minimum_score: 0 },
      signature: sig,
    },
  };
}

/**
 * Build a signed skill directory at a tmp path. Returns {dir, envelope}.
 * Body content is a deliberately simple SKILL.md so test assertions can
 * focus on hash matching rather than YAML edge cases.
 */
async function buildFixtureDir(opts?: {
  bodyOverride?: string;
  files?: Record<string, Uint8Array>;
}): Promise<{ dir: string; envelope: SkillEnvelope }> {
  const dir = mkdtempSync(join(tmpdir(), "motebit-skill-fixture-"));
  const sk = ed.utils.randomSecretKey();
  const pk = await ed.getPublicKeyAsync(sk);

  const body =
    opts?.bodyOverride ?? "# Fixture\n\n## When to Use\n\nIn tests.\n\n## Procedure\n\n1. step.\n";
  const bodyBytes = new TextEncoder().encode(body);
  const bodyHash = await sha256Hex(bodyBytes);

  const fileEntries: Array<{ path: string; hash: string }> = [];
  for (const [path, bytes] of Object.entries(opts?.files ?? {})) {
    fileEntries.push({ path, hash: await sha256Hex(bytes) });
  }

  const stubSig: SkillSignature = {
    suite: "motebit-jcs-ed25519-b64-v1",
    public_key: bytesToHex(pk),
    value: "AA",
  };

  const unsigned: Omit<SkillEnvelope, "signature"> = {
    spec_version: "1.0",
    skill: { name: "fixture-skill", version: "1.0.0", content_hash: "a".repeat(64) },
    manifest: makeManifest(stubSig),
    body_hash: bodyHash,
    files: fileEntries,
  };
  const envelope = await signSkillEnvelope(unsigned, sk, pk);

  // SKILL.md = `---\n<yaml frontmatter>\n---\n<body>` — frontmatter
  // contents don't matter for body_hash extraction (the verifier slices
  // after the second `---`), so a minimal stub works.
  const skillMd = `---\nname: fixture-skill\nversion: "1.0.0"\n---\n${body}`;
  writeFileSync(join(dir, "SKILL.md"), skillMd);
  writeFileSync(join(dir, "skill-envelope.json"), JSON.stringify(envelope, null, 2));

  for (const [path, bytes] of Object.entries(opts?.files ?? {})) {
    const fullPath = join(dir, path);
    const parent = fullPath.slice(0, fullPath.lastIndexOf("/"));
    mkdirSync(parent, { recursive: true });
    writeFileSync(fullPath, bytes);
  }

  return { dir, envelope };
}

describe("verifySkillDirectory", () => {
  it("returns valid=true on a freshly-built directory (sig + body + 0 files)", async () => {
    const { dir } = await buildFixtureDir();
    const result = await verifySkillDirectory(dir);
    expect(result.type).toBe("skill");
    expect(result.valid).toBe(true);
    expect(result.steps.envelope.valid).toBe(true);
    expect(result.steps.body_hash?.valid).toBe(true);
    expect(result.steps.files).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("verifies per-file hashes when envelope.files[] is non-empty", async () => {
    const fileBytes = new TextEncoder().encode("#!/bin/sh\necho hello\n");
    const { dir } = await buildFixtureDir({ files: { "scripts/run.sh": fileBytes } });
    const result = await verifySkillDirectory(dir);
    expect(result.valid).toBe(true);
    expect(result.steps.files).toHaveLength(1);
    expect(result.steps.files[0]!.valid).toBe(true);
    expect(result.steps.files[0]!.path).toBe("scripts/run.sh");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails body_hash step when SKILL.md body bytes are tampered post-sign", async () => {
    const { dir } = await buildFixtureDir({ bodyOverride: "# Original\n" });
    // Overwrite SKILL.md with a body that doesn't match envelope.body_hash.
    writeFileSync(join(dir, "SKILL.md"), `---\nname: fixture-skill\n---\n# Tampered\n`);
    const result = await verifySkillDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.steps.envelope.valid).toBe(true); // envelope itself untouched
    expect(result.steps.body_hash?.valid).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails file_hash step when an auxiliary file is tampered", async () => {
    const original = new TextEncoder().encode("original\n");
    const { dir } = await buildFixtureDir({ files: { "scripts/run.sh": original } });
    writeFileSync(join(dir, "scripts/run.sh"), "tampered\n");
    const result = await verifySkillDirectory(dir);
    expect(result.valid).toBe(false);
    const fileStep = result.steps.files.find((f) => f.path === "scripts/run.sh");
    expect(fileStep?.valid).toBe(false);
    expect(fileStep?.reason).toBe("hash_mismatch");
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails with reason='missing' when envelope declares a file not on disk", async () => {
    const { dir } = await buildFixtureDir({
      files: { "scripts/run.sh": new TextEncoder().encode("declared\n") },
    });
    rmSync(join(dir, "scripts/run.sh"), { force: true });
    const result = await verifySkillDirectory(dir);
    expect(result.valid).toBe(false);
    const fileStep = result.steps.files.find((f) => f.path === "scripts/run.sh");
    expect(fileStep?.valid).toBe(false);
    expect(fileStep?.reason).toBe("missing");
    expect(fileStep?.actual).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("fails the envelope step when signature bytes are tampered", async () => {
    const { dir, envelope } = await buildFixtureDir();
    const tampered = {
      ...envelope,
      signature: { ...envelope.signature, value: "AA".repeat(32) },
    };
    writeFileSync(join(dir, "skill-envelope.json"), JSON.stringify(tampered, null, 2));
    const result = await verifySkillDirectory(dir);
    expect(result.valid).toBe(false);
    expect(result.steps.envelope.valid).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("verifyFile routes a directory path through verifySkillDirectory", async () => {
    const { dir } = await buildFixtureDir();
    const result = (await verifyFile(dir)) as SkillVerifyResult;
    expect(result.type).toBe("skill");
    expect(result.valid).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns valid=false when --expect mismatches", async () => {
    const { dir } = await buildFixtureDir();
    const result = await verifySkillDirectory(dir, { expectedType: "credential" });
    expect(result.valid).toBe(false);
    expect(result.errors?.[0]?.message).toMatch(/Expected.*credential/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("formatHuman renders the skill checklist with verifier name + per-step status", async () => {
    const { dir } = await buildFixtureDir();
    const result = await verifySkillDirectory(dir);
    const human = formatHuman(result);
    expect(human).toContain("VALID (skill)");
    expect(human).toContain("skill:");
    expect(human).toContain("envelope:");
    expect(human).toContain("body:");
    rmSync(dir, { recursive: true, force: true });
  });
});
