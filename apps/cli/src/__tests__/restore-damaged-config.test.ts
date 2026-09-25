// --- `motebit restore` over a damaged config — BOTH of its reads ---
//
// Restore is where `doctor` sends a user whose config cannot be read, so it
// must survive that config and rebuild it — while keeping the damaged bytes.
// It reads config twice: once to plan (reset / fresh / replace) and once,
// after the passphrase prompts, to commit. An earlier fix guarded only one of
// the two. Each read is exercised here on its own: damage present from the
// start (the plan's read), and damage that appears while the user types (the
// commit's read).

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-cli-restore-damage-"));
const savedDir = process.env["MOTEBIT_CONFIG_DIR"];
process.env["MOTEBIT_CONFIG_DIR"] = tmpDir;

const SEED = "4f".repeat(32);
const PASS = "correct horse battery staple";
const CONFIG = path.join(tmpDir, "config.json");

// Prompts in order: seed, new passphrase, confirmation. `onPassphrase` runs at
// the first passphrase prompt — i.e. between restore's two config reads.
let onPassphrase: (() => void) | null = null;
vi.mock("../identity.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../identity.js")>();
  let calls = 0;
  return {
    ...actual,
    promptPassphrase: vi.fn(async () => {
      calls++;
      if (calls % 3 === 1) return SEED;
      if (calls % 3 === 2) onPassphrase?.();
      return PASS;
    }),
  };
});

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${String(code)})`);
  }
}

type RestoreModule = typeof import("../subcommands/restore.js");
let restore: RestoreModule;

beforeAll(async () => {
  restore = await import("../subcommands/restore.js");
});

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { recursive: true });
  onPassphrase = null;
  vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    throw new Exit(typeof code === "number" ? code : undefined);
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (savedDir !== undefined) process.env["MOTEBIT_CONFIG_DIR"] = savedDir;
  else delete process.env["MOTEBIT_CONFIG_DIR"];
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function runRestore(): Promise<number | undefined> {
  try {
    await restore.handleRestore({ positionals: ["restore"] } as unknown as Parameters<
      RestoreModule["handleRestore"]
    >[0]);
  } catch (err) {
    if (err instanceof Exit) return err.code;
    throw err;
  }
  return undefined;
}

function backups(): string[] {
  return fs.readdirSync(tmpDir).filter((f) => f.startsWith("config.json.clobbered-"));
}

function expectRestoredConfig(): void {
  const cfg = JSON.parse(fs.readFileSync(CONFIG, "utf-8")) as Record<string, unknown>;
  expect(typeof cfg["motebit_id"]).toBe("string");
  expect(cfg["cli_encrypted_key"]).toBeTruthy();
  expect(fs.statSync(CONFIG).mode & 0o777).toBe(0o600);
}

describe("restore over a damaged config", () => {
  it("damage present at the PLAN read: restore completes and keeps the damaged bytes", async () => {
    const damaged = '{ "cli_encrypted_key": { "ciphertext": "ab';
    fs.writeFileSync(CONFIG, damaged, { mode: 0o644 });
    expect(await runRestore()).toBe(0);
    expectRestoredConfig();
    const kept = backups();
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, kept[0]!), "utf-8")).toBe(damaged);
  });

  it("damage appearing before the COMMIT read: restore completes and keeps the damaged bytes", async () => {
    // Healthy (absent) at the plan read; damaged by the time of the commit read.
    onPassphrase = () => fs.writeFileSync(CONFIG, "[]");
    expect(await runRestore()).toBe(0);
    expectRestoredConfig();
    const kept = backups();
    expect(kept).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, kept[0]!), "utf-8")).toBe("[]");
  });

  it("an aborted restore leaves the damaged file exactly where it was", async () => {
    // The plan's read must not move or rewrite anything: the user may stop.
    fs.writeFileSync(CONFIG, "{");
    const mock = (await import("../identity.js")).promptPassphrase as ReturnType<typeof vi.fn>;
    mock.mockImplementationOnce(async () => SEED).mockImplementationOnce(async () => "");
    expect(await runRestore()).toBe(1);
    expect(fs.readFileSync(CONFIG, "utf-8")).toBe("{");
    expect(backups()).toEqual([]);
  });

  it("every config read in restore goes through the damage-tolerant loader", () => {
    // Structural: the withdrawn fix guarded one of two reads. A third direct
    // read added later would reopen the hole this closes.
    const src = fs.readFileSync(path.join(__dirname, "..", "subcommands", "restore.ts"), "utf-8");
    expect(src.match(/loadFullConfig\(\)/g)).toHaveLength(1); // inside loadConfigForRestore
    expect((src.match(/loadConfigForRestore\(\)/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
