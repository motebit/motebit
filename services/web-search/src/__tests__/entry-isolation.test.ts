/**
 * `src/index.ts` is the process entry: importing it boots the service (binds
 * MOTEBIT_PORT, opens ./data) and its boot-failure path calls
 * `process.exit(1)`. Tests that imported pure helpers from it booted one real
 * server per test file; under load two workers raced for port 3200 and the
 * loser surfaced as `process.exit unexpectedly called with "1"` in the
 * pre-push coverage run. Pure logic lives in side-effect-free modules; these
 * tests keep it that way.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi, afterEach } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");
const TESTS = join(SRC, "__tests__");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("web-search entry isolation", () => {
  it("no test imports the boot entry (src/index.ts)", () => {
    const entryImport = /(?:from\s+|import\s*\(\s*)["']\.\.\/index(?:\.js|\.ts)?["']/;
    const offenders = readdirSync(TESTS)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => entryImport.test(readFileSync(join(TESTS, f), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("sub-delegate.ts has no exit path and no boot import", () => {
    const src = readFileSync(join(SRC, "sub-delegate.ts"), "utf8");
    expect(src).not.toMatch(/process\.exit\s*\(/);
    expect(src).not.toMatch(/from\s+["'](?:\.\/index\.js|@motebit\/molecule-runner)["']/);
  });

  it("importing and using sub-delegate.ts never calls process.exit", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const mod = await import("../sub-delegate.js");
    mod.resetSubDelegateCircuitForTest();
    for (let i = 0; i < mod.SUB_DELEGATE_MAX_CONSECUTIVE_FAILURES; i++) {
      mod.recordSubDelegateOutcome(false, 0);
    }
    mod.recordSubDelegateOutcome(true, 0);
    mod.subDelegateClientConfig({
      mcpUrl: "https://read-url.example/mcp",
      callerMotebitId: "a",
      callerDeviceId: "b",
      callerPrivateKey: new Uint8Array(32),
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(exit).not.toHaveBeenCalled();
  });
});
