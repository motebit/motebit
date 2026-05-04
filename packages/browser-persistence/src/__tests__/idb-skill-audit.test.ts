/**
 * `IdbSkillAuditSink` contract tests.
 *
 * Locks the persistence + recall behavior of the IDB-backed audit log
 * for skill events — the durable trail that closes the consent-gate
 * arc's runtime gap. Mirrors the existing `IdbToolAuditSink` test
 * pattern (append-only, preload window, per-key filter).
 */

import "fake-indexeddb/auto";
import { beforeEach, describe, expect, it } from "vitest";
import type { SkillAuditEvent } from "@motebit/skills";

import { openMotebitDB } from "../idb.js";
import { IdbSkillAuditSink } from "../idb-skill-audit.js";

function makeTrustEvent(name: string, at: string): SkillAuditEvent {
  return {
    type: "skill_trust_grant",
    skill_name: name,
    skill_version: "1.0.0",
    content_hash: "0".repeat(64),
    at,
  };
}

function makeConsentEvent(name: string, at: string): SkillAuditEvent {
  return {
    type: "skill_consent_granted",
    skill_name: name,
    skill_version: "1.0.0",
    content_hash: "0".repeat(64),
    sensitivity: "medical",
    surface: "web",
    at,
  };
}

describe("IdbSkillAuditSink", () => {
  let sink: IdbSkillAuditSink;

  beforeEach(async () => {
    const db = await openMotebitDB(`test-skill-audit-${crypto.randomUUID()}`);
    sink = new IdbSkillAuditSink(db);
  });

  it("record persists the event and exposes it via getAll", async () => {
    const event = makeConsentEvent("alpha", "2026-05-04T00:00:00Z");
    await sink.record(event);
    const all = sink.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({
      type: "skill_consent_granted",
      skill_name: "alpha",
      sensitivity: "medical",
      surface: "web",
    });
  });

  it("getAll returns most-recent-first order", async () => {
    await sink.record(makeTrustEvent("first", "2026-05-04T00:00:00Z"));
    await sink.record(makeTrustEvent("second", "2026-05-04T00:00:01Z"));
    await sink.record(makeTrustEvent("third", "2026-05-04T00:00:02Z"));
    const names = sink.getAll().map((e) => e.skill_name);
    expect(names).toEqual(["third", "second", "first"]);
  });

  it("querySkill filters by skill_name", async () => {
    await sink.record(makeTrustEvent("alpha", "2026-05-04T00:00:00Z"));
    await sink.record(makeConsentEvent("beta", "2026-05-04T00:00:01Z"));
    await sink.record(makeConsentEvent("alpha", "2026-05-04T00:00:02Z"));
    const alphaEvents = sink.querySkill("alpha");
    expect(alphaEvents).toHaveLength(2);
    expect(alphaEvents.every((e) => e.skill_name === "alpha")).toBe(true);
  });

  it("preload reads recent events from IDB on a fresh sink", async () => {
    // Persist via the first sink, then verify a second sink sees them
    // after preload. Mirrors the bootstrap-time path: surface opens, IDB
    // already has prior events, panel needs them in cache.
    const dbName = `test-preload-${crypto.randomUUID()}`;
    const db1 = await openMotebitDB(dbName);
    const sink1 = new IdbSkillAuditSink(db1);
    await sink1.record(makeTrustEvent("alpha", "2026-05-04T00:00:00Z"));
    await sink1.record(makeConsentEvent("beta", "2026-05-04T00:00:01Z"));

    const db2 = await openMotebitDB(dbName);
    const sink2 = new IdbSkillAuditSink(db2);
    expect(sink2.getAll()).toHaveLength(0);
    await sink2.preload();
    const loaded = sink2.getAll();
    expect(loaded).toHaveLength(2);
    expect(loaded[0]?.skill_name).toBe("beta");
  });

  it("record returns a Promise so callers can await durability", async () => {
    // Adapter wraps the call in try/catch — needs the await to surface
    // IDB failures. Counter-test: if `record` were sync fire-and-forget,
    // a future change that swallowed errors would break the audit
    // contract silently.
    const event = makeConsentEvent("alpha", "2026-05-04T00:00:00Z");
    const promise = sink.record(event);
    expect(promise).toBeInstanceOf(Promise);
    await promise;
  });

  it("getAll returns a defensive copy — mutating the result does not affect the sink", async () => {
    await sink.record(makeTrustEvent("alpha", "2026-05-04T00:00:00Z"));
    const first = sink.getAll();
    first.push(makeTrustEvent("attacker", "2099-01-01T00:00:00Z"));
    expect(sink.getAll()).toHaveLength(1);
    expect(sink.getAll()[0]?.skill_name).toBe("alpha");
  });
});
