// create-motebit writes the SAME config.json the motebit CLI keeps its
// identity key in, so it obeys the same three rules — tested here directly
// against the helper, and end to end through the built bin in index.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConfigDamagedError,
  readConfigFile,
  writeConfigFile,
  writeFileAtomic,
} from "../config-file.js";

let dir: string;
let cfg: string;
const mode = (p: string) => statSync(p).mode & 0o777;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "create-motebit-config-file-"));
  cfg = join(dir, "config.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const DAMAGED = ['{ "cli_encrypted_key": {', "", "null", "[]", "3", '"x"'];

describe("rule 1 — absence is not damage", () => {
  it("absent reads as {}", () => {
    expect(readConfigFile(cfg)).toEqual({});
  });

  it.each(DAMAGED)("refuses %j, bytes untouched", (body) => {
    writeFileSync(cfg, body);
    expect(() => readConfigFile(cfg)).toThrow(ConfigDamagedError);
    expect(readFileSync(cfg, "utf-8")).toBe(body);
  });

  it("refuses an unreadable path", () => {
    mkdirSync(cfg);
    expect(() => readConfigFile(cfg)).toThrow(ConfigDamagedError);
  });
});

describe("rule 2 — damage is never overwritten", () => {
  it.each(DAMAGED)("a write over %j keeps it as config.json.clobbered-*", (body) => {
    writeFileSync(cfg, body);
    const kept = writeConfigFile(cfg, { motebit_id: "m-new" });
    expect(kept).not.toBeNull();
    expect(kept!).toMatch(/config\.json\.clobbered-/);
    expect(readFileSync(kept!, "utf-8")).toBe(body);
    expect(mode(kept!)).toBe(0o600);
    expect(readConfigFile<{ motebit_id?: string }>(cfg).motebit_id).toBe("m-new");
  });

  it("a write over a healthy config makes no backup", () => {
    writeConfigFile(cfg, { motebit_id: "m-1" });
    expect(writeConfigFile(cfg, { motebit_id: "m-2" })).toBeNull();
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });

  it("refuses when the damage cannot be preserved", () => {
    mkdirSync(cfg);
    writeFileSync(join(cfg, "inside"), "x");
    expect(() => writeConfigFile(cfg, { motebit_id: "m-1" })).toThrow(/could not preserve/);
    expect(readFileSync(join(cfg, "inside"), "utf-8")).toBe("x");
  });
});

describe("rule 3 — atomic, owner-only", () => {
  it("writes 0600, even under a permissive umask", () => {
    const prev = process.umask(0o000);
    try {
      writeConfigFile(cfg, { motebit_id: "m-1" });
    } finally {
      process.umask(prev);
    }
    expect(mode(cfg)).toBe(0o600);
  });

  it("a pre-existing 0644 config is tightened on read and ends 0600 after a write", () => {
    writeFileSync(cfg, "{}");
    chmodSync(cfg, 0o644);
    readConfigFile(cfg);
    expect(mode(cfg)).toBe(0o600);
    chmodSync(cfg, 0o644);
    writeConfigFile(cfg, {});
    expect(mode(cfg)).toBe(0o600);
  });

  it("creates the directory for a scaffolded agent's own .motebit/", () => {
    const agentCfg = join(dir, "agent", ".motebit", "config.json");
    writeConfigFile(agentCfg, { motebit_id: "m-agent" });
    expect(mode(agentCfg)).toBe(0o600);
  });

  it("removes the scratch file when the replacement fails after staging", () => {
    const target = join(dir, "occupied.json");
    mkdirSync(target);
    writeFileSync(join(target, "x"), "x");
    expect(() => writeFileAtomic(target, '{"secret":1}', 0o600)).toThrow();
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("leaves no scratch file on success", () => {
    writeConfigFile(cfg, { a: 1 });
    writeConfigFile(cfg, { a: 2 });
    expect(readdirSync(dir)).toEqual(["config.json"]);
  });
});
