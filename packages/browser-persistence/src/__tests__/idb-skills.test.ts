/**
 * Adapter-contract tests for `IdbSkillStorageAdapter`. Mirrors the shape
 * of `InMemorySkillStorageAdapter`'s tests in `@motebit/skills` — same
 * round-trip / list-ordering / idempotent-remove / enable+trust toggle
 * scenarios — applied through the IDB-backed implementation. The
 * adapter contract is what `SkillRegistry` binds to; if any of these
 * pass for InMemory but fail for IDB, the registry's contract is
 * leaky and downstream surface bugs follow.
 *
 * `fake-indexeddb` polyfills the IDB surface for vitest; the wire
 * format (structured-cloned object rows with `Uint8Array` blob fields)
 * is byte-identical to what runs in a real browser.
 */

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import type { SkillEnvelope, SkillManifest } from "@motebit/protocol";
import type { InstalledSkillIndexEntry, StoredSkill } from "@motebit/skills";

import { openMotebitDB } from "../idb.js";
import { IdbSkillStorageAdapter } from "../idb-skills.js";

// ---------------------------------------------------------------------------
// Fixture builders — synthesize StoredSkill payloads without going through the
// real signing pipeline. The adapter doesn't verify signatures (that's the
// registry's job); it just persists bytes. Tests use literal placeholder
// values for manifest/envelope where the adapter doesn't care about them.
// ---------------------------------------------------------------------------

function makeIndexEntry(
  name: string,
  overrides: Partial<InstalledSkillIndexEntry> = {},
): InstalledSkillIndexEntry {
  return {
    name,
    version: "1.0.0",
    enabled: true,
    trusted: false,
    installed_at: "2026-01-01T00:00:00Z",
    source: "test://" + name,
    content_hash: "0".repeat(64),
    ...overrides,
  };
}

function makeManifest(name: string): SkillManifest {
  return {
    name,
    description: `Test skill ${name}`,
    version: "1.0.0",
    platforms: ["macos", "linux"],
    metadata: { category: "test", tags: [] },
    motebit: {
      spec_version: "1.0",
      sensitivity: "none",
      hardware_attestation: { required: false, minimum_score: 0 },
    },
  } as SkillManifest;
}

function makeEnvelope(name: string): SkillEnvelope {
  // The adapter doesn't verify signatures (the registry does); these
  // fixtures use a placeholder envelope shape that's structurally
  // compatible with `StoredSkill` for round-trip testing.
  return {
    spec_version: "1.0",
    skill: { name, version: "1.0.0", content_hash: "0".repeat(64) },
    manifest: makeManifest(name),
    body_hash: "0".repeat(64),
    files: [],
  } as unknown as SkillEnvelope;
}

function makeStoredSkill(
  name: string,
  overrides: Partial<InstalledSkillIndexEntry> = {},
): StoredSkill {
  return {
    index: makeIndexEntry(name, overrides),
    manifest: makeManifest(name),
    envelope: makeEnvelope(name),
    body: new TextEncoder().encode(`# ${name}\n\nbody bytes\n`),
    files: {
      "scripts/run.sh": new TextEncoder().encode("#!/bin/sh\necho ok\n"),
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("IdbSkillStorageAdapter", () => {
  let adapter: IdbSkillStorageAdapter;

  beforeEach(async () => {
    // Fresh DB per test — no shared state, parallel-safe.
    const db = await openMotebitDB(`test-skills-${crypto.randomUUID()}`);
    adapter = new IdbSkillStorageAdapter(db);
  });

  // -- write + read round-trip ---------------------------------------------

  it("write + read returns byte-identical body and files", async () => {
    const skill = makeStoredSkill("alpha");
    await adapter.write(skill);

    const got = await adapter.read("alpha");
    expect(got).not.toBeNull();
    expect(got!.index).toEqual(skill.index);
    expect(Array.from(got!.body)).toEqual(Array.from(skill.body));
    expect(Object.keys(got!.files)).toEqual(["scripts/run.sh"]);
    expect(Array.from(got!.files["scripts/run.sh"]!)).toEqual(
      Array.from(skill.files["scripts/run.sh"]!),
    );
  });

  it("read returns null for absent skills", async () => {
    const got = await adapter.read("does-not-exist");
    expect(got).toBeNull();
  });

  it("read returns a defensive copy — mutating result does not affect storage", async () => {
    await adapter.write(makeStoredSkill("alpha"));
    const first = await adapter.read("alpha");
    first!.body[0] = 0xff;
    first!.index.enabled = false;

    const second = await adapter.read("alpha");
    expect(second!.body[0]).not.toBe(0xff);
    expect(second!.index.enabled).toBe(true);
  });

  // -- list ordering -------------------------------------------------------

  it("list preserves insertion order", async () => {
    await adapter.write(makeStoredSkill("first"));
    // Force a tiny gap so insertedAt timestamps differ — fake-indexeddb's
    // clock resolution can be very tight.
    await new Promise((r) => setTimeout(r, 2));
    await adapter.write(makeStoredSkill("second"));
    await new Promise((r) => setTimeout(r, 2));
    await adapter.write(makeStoredSkill("third"));

    const list = await adapter.list();
    expect(list.map((e) => e.name)).toEqual(["first", "second", "third"]);
  });

  it("list returns empty array when no skills installed", async () => {
    const list = await adapter.list();
    expect(list).toEqual([]);
  });

  // -- write overwrites preserve insertion order ---------------------------

  it("write of an existing name preserves its original list position", async () => {
    await adapter.write(makeStoredSkill("first"));
    await new Promise((r) => setTimeout(r, 2));
    await adapter.write(makeStoredSkill("second"));
    await new Promise((r) => setTimeout(r, 2));
    await adapter.write(makeStoredSkill("third"));

    // Re-write "first" with new bytes.
    const updated = makeStoredSkill("first", { version: "1.1.0" });
    updated.body = new TextEncoder().encode("# updated body\n");
    await adapter.write(updated);

    const list = await adapter.list();
    expect(list.map((e) => e.name)).toEqual(["first", "second", "third"]);
    const read = await adapter.read("first");
    expect(read!.index.version).toBe("1.1.0");
    expect(new TextDecoder().decode(read!.body)).toBe("# updated body\n");
  });

  // -- remove --------------------------------------------------------------

  it("remove deletes the skill and is idempotent", async () => {
    await adapter.write(makeStoredSkill("alpha"));
    await adapter.remove("alpha");
    expect(await adapter.read("alpha")).toBeNull();

    // Idempotent — second remove is a no-op.
    await expect(adapter.remove("alpha")).resolves.toBeUndefined();
    await expect(adapter.remove("never-existed")).resolves.toBeUndefined();
  });

  // -- setEnabled / setTrusted index-only patches --------------------------

  it("setEnabled flips the index flag without touching bytes", async () => {
    const original = makeStoredSkill("alpha");
    await adapter.write(original);

    await adapter.setEnabled("alpha", false);
    const read = await adapter.read("alpha");
    expect(read!.index.enabled).toBe(false);

    // Bytes untouched.
    expect(Array.from(read!.body)).toEqual(Array.from(original.body));
    expect(Object.keys(read!.files)).toEqual(Object.keys(original.files));
  });

  it("setTrusted flips the index flag without touching bytes", async () => {
    await adapter.write(makeStoredSkill("alpha"));
    await adapter.setTrusted("alpha", true);
    const read = await adapter.read("alpha");
    expect(read!.index.trusted).toBe(true);
  });

  it("setEnabled + setTrusted on a missing skill is a silent no-op", async () => {
    await expect(adapter.setEnabled("missing", false)).resolves.toBeUndefined();
    await expect(adapter.setTrusted("missing", true)).resolves.toBeUndefined();
    expect(await adapter.list()).toEqual([]);
  });
});
