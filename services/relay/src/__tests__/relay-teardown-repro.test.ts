/**
 * Deterministic reproduction of the relay suite's teardown flake:
 * `EnvironmentTeardownError: [vitest-worker]: Closing rpc while
 * "onUserConsoleLog" was pending`, blamed on a random short file while every
 * test passed. See `fixtures/teardown-after-close.fixture.ts` for how the
 * window is pinned; this runs it in its own vitest process (twice — the
 * error is fatal to the run, so one clean pass is not proof) and requires a
 * clean exit.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const RELAY_ROOT = resolve(import.meta.dirname, "../..");
const FIXTURE = "src/__tests__/fixtures/teardown-after-close.fixture.ts";

function runFixture(): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "relay-teardown-repro-"));
  try {
    const config = join(dir, "vitest.config.mjs");
    writeFileSync(
      config,
      `export default { test: { root: ${JSON.stringify(RELAY_ROOT)}, include: [${JSON.stringify(FIXTURE)}], pool: "forks" } };\n`,
    );
    const res = spawnSync(
      process.execPath,
      [join(RELAY_ROOT, "node_modules/vitest/vitest.mjs"), "run", "--config", config],
      { cwd: RELAY_ROOT, encoding: "utf8", timeout: 120_000, env: { ...process.env, CI: "1" } },
    );
    return { status: res.status, output: `${res.stdout}\n${res.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("relay teardown: nothing a test relay started outlives close()", () => {
  it("a file that opens and closes a test relay tears down clean", { timeout: 300_000 }, () => {
    for (let i = 0; i < 2; i++) {
      const { status, output } = runFixture();
      expect(output).not.toContain("EnvironmentTeardownError");
      expect(output).toContain("1 passed");
      expect(status).toBe(0);
    }
  });
});
