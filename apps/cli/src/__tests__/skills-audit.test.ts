/**
 * `motebit skills audit` — read the durable audit trail
 * (`~/.motebit/skills/audit.log`) and project it for operator inspection.
 *
 * Tests run against a tmp `MOTEBIT_CONFIG_DIR` so each case writes its
 * own audit.log fixture. Handler is sync (no async I/O — `readFileSync`
 * is the canonical CLI pattern; the audit log is small enough that
 * streaming wouldn't change the cost shape).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CliConfig } from "../args.js";

let tmpRoot: string;

function setConfigDir(): string {
  tmpRoot = mkdtempSync(join(tmpdir(), "motebit-cli-audit-test-"));
  process.env["MOTEBIT_CONFIG_DIR"] = tmpRoot;
  return tmpRoot;
}

function writeAuditFixture(lines: string[]): void {
  const skillsDir = join(tmpRoot, "skills");
  mkdirSync(skillsDir, { recursive: true });
  writeFileSync(join(skillsDir, "audit.log"), lines.join("\n") + "\n", "utf-8");
}

interface AuditConfigOpts {
  json?: boolean;
  limit?: number;
  eventType?: string;
}

function makeConfig(positionals: string[], opts: AuditConfigOpts = {}): CliConfig {
  return {
    positionals,
    json: opts.json ?? false,
    limit: opts.limit,
    eventType: opts.eventType,
  } as CliConfig;
}

describe("handleSkillsAudit", () => {
  beforeEach(() => {
    setConfigDir();
    vi.resetModules();
  });

  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
    delete process.env["MOTEBIT_CONFIG_DIR"];
  });

  it("renders empty-state message when audit.log is missing", async () => {
    const { handleSkillsAudit } = await import("../subcommands/skills.js");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    handleSkillsAudit(makeConfig(["skills", "audit"]));
    spy.mockRestore();
    expect(logs.some((line) => line.includes("No audit events recorded"))).toBe(true);
  });

  it("renders most-recent-first across mixed event types", async () => {
    writeAuditFixture([
      JSON.stringify({
        type: "skill_trust_grant",
        skill_name: "alpha",
        skill_version: "1.0.0",
        content_hash: "0".repeat(64),
        at: "2026-05-04T01:00:00Z",
        operator: "did:key:zOp1",
      }),
      JSON.stringify({
        type: "skill_consent_granted",
        skill_name: "beta",
        skill_version: "1.0.0",
        content_hash: "0".repeat(64),
        sensitivity: "medical",
        surface: "web",
        at: "2026-05-04T03:00:00Z",
      }),
      JSON.stringify({
        type: "skill_remove",
        skill_name: "alpha",
        skill_version: "1.0.0",
        content_hash: "0".repeat(64),
        at: "2026-05-04T02:00:00Z",
      }),
    ]);

    const { handleSkillsAudit } = await import("../subcommands/skills.js");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    handleSkillsAudit(makeConfig(["skills", "audit"], { json: true }));

    // JSON mode: one event per line, most-recent-first.
    const events = logs.map((l) => JSON.parse(l));
    expect(events.map((e) => e.skill_name)).toEqual(["beta", "alpha", "alpha"]);
    expect(events[0]!.type).toBe("skill_consent_granted");
    expect(events[1]!.type).toBe("skill_remove");
    expect(events[2]!.type).toBe("skill_trust_grant");
  });

  it("filters by skill name (positional)", async () => {
    writeAuditFixture([
      JSON.stringify({
        type: "skill_trust_grant",
        skill_name: "alpha",
        skill_version: "1.0.0",
        content_hash: "0".repeat(64),
        at: "2026-05-04T01:00:00Z",
      }),
      JSON.stringify({
        type: "skill_trust_grant",
        skill_name: "beta",
        skill_version: "1.0.0",
        content_hash: "0".repeat(64),
        at: "2026-05-04T02:00:00Z",
      }),
    ]);

    const { handleSkillsAudit } = await import("../subcommands/skills.js");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    handleSkillsAudit(makeConfig(["skills", "audit", "alpha"], { json: true }));
    const events = logs.map((l) => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0]!.skill_name).toBe("alpha");
  });

  it("filters by --type", async () => {
    writeAuditFixture([
      JSON.stringify({
        type: "skill_trust_grant",
        skill_name: "alpha",
        skill_version: "1.0.0",
        content_hash: "0".repeat(64),
        at: "2026-05-04T01:00:00Z",
      }),
      JSON.stringify({
        type: "skill_consent_granted",
        skill_name: "beta",
        skill_version: "1.0.0",
        content_hash: "0".repeat(64),
        sensitivity: "medical",
        surface: "web",
        at: "2026-05-04T02:00:00Z",
      }),
    ]);

    const { handleSkillsAudit } = await import("../subcommands/skills.js");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    handleSkillsAudit(
      makeConfig(["skills", "audit"], { eventType: "skill_consent_granted", json: true }),
    );
    const events = logs.map((l) => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("skill_consent_granted");
  });

  it("respects --limit", async () => {
    writeAuditFixture(
      Array.from({ length: 10 }, (_, i) =>
        JSON.stringify({
          type: "skill_trust_grant",
          skill_name: `skill-${i}`,
          skill_version: "1.0.0",
          content_hash: "0".repeat(64),
          // Reverse chronological so the most-recent-first sort is the
          // load-bearing assertion (not just file-order coincidence).
          at: new Date(2026, 4, 4, 0, i, 0).toISOString(),
        }),
      ),
    );

    const { handleSkillsAudit } = await import("../subcommands/skills.js");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    handleSkillsAudit(makeConfig(["skills", "audit"], { limit: 3, json: true }));
    const events = logs.map((l) => JSON.parse(l));
    expect(events).toHaveLength(3);
    // Most-recent-first → indices 9, 8, 7.
    expect(events.map((e) => e.skill_name)).toEqual(["skill-9", "skill-8", "skill-7"]);
  });

  it("skips malformed JSON lines without crashing", async () => {
    writeAuditFixture([
      "not valid json",
      JSON.stringify({
        type: "skill_trust_grant",
        skill_name: "valid",
        skill_version: "1.0.0",
        content_hash: "0".repeat(64),
        at: "2026-05-04T01:00:00Z",
      }),
      "{ malformed",
    ]);

    const { handleSkillsAudit } = await import("../subcommands/skills.js");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((msg: unknown) => {
      logs.push(String(msg));
    });
    handleSkillsAudit(makeConfig(["skills", "audit"], { json: true }));
    const events = logs.map((l) => JSON.parse(l));
    // Only the one well-formed line surfaces; the two malformed lines
    // are silently skipped (a future rotation/compaction pass might
    // surface counts of unparseable lines as a warning).
    expect(events).toHaveLength(1);
    expect(events[0]!.skill_name).toBe("valid");
  });
});
