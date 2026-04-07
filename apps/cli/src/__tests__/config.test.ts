// --- Config load/save + governance field round-trip ---
//
// The CLI's CONFIG_DIR / CONFIG_PATH are computed once from os.homedir() at
// module load time. We override HOME before the very first import so the
// constants point at a temp dir — no real user config is ever touched.

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_GOVERNANCE_CONFIG, type GovernanceConfig } from "@motebit/sdk";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-cli-config-test-"));
const savedHome = process.env["HOME"];
process.env["HOME"] = tmpHome;

// Dynamic import AFTER env override so CONFIG_DIR picks up tmpHome.
// Pinned to a single import — CONFIG_PATH is captured at module load.
type ConfigModule = typeof import("../config.js");
let mod: ConfigModule;

beforeAll(async () => {
  mod = await import("../config.js");
});

beforeEach(() => {
  // Reset config file between tests
  try {
    fs.rmSync(mod.CONFIG_PATH, { force: true });
  } catch {
    // ignore
  }
});

afterAll(() => {
  if (savedHome !== undefined) process.env["HOME"] = savedHome;
  else delete process.env["HOME"];
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

describe("FullConfig.governance", () => {
  it("loads as undefined when absent from config.json", () => {
    mod.saveFullConfig({ name: "no-gov" });
    const loaded = mod.loadFullConfig();
    expect(loaded.name).toBe("no-gov");
    expect(loaded.governance).toBeUndefined();
  });

  it("loads a valid governance block verbatim (camelCase pass-through)", () => {
    const gov: GovernanceConfig = {
      approvalPreset: "cautious",
      persistenceThreshold: 0.8,
      rejectSecrets: true,
      maxCallsPerTurn: 3,
      maxMemoriesPerTurn: 2,
    };
    mod.saveFullConfig({ governance: gov });
    const loaded = mod.loadFullConfig();
    expect(loaded.governance).toEqual(gov);
  });

  it("round-trips: save then load preserves governance exactly", () => {
    const cfg = {
      name: "round-trip",
      governance: { ...DEFAULT_GOVERNANCE_CONFIG, approvalPreset: "autonomous" as const },
    };
    mod.saveFullConfig(cfg);
    const loaded = mod.loadFullConfig();
    expect(loaded.governance).toEqual(cfg.governance);
  });

  it("drops a malformed governance blob so runtime defaults apply", () => {
    fs.mkdirSync(mod.CONFIG_DIR, { recursive: true });
    fs.writeFileSync(
      mod.CONFIG_PATH,
      JSON.stringify({
        name: "bad-gov",
        // missing required fields + wrong type on persistenceThreshold
        governance: { approvalPreset: "balanced", persistenceThreshold: "high" },
      }),
      "utf-8",
    );
    const loaded = mod.loadFullConfig();
    expect(loaded.name).toBe("bad-gov");
    expect(loaded.governance).toBeUndefined();
  });
});
