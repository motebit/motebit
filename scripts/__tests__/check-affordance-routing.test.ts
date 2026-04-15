/**
 * check-affordance-routing probe — positive & negative fixtures.
 *
 * Invokes the gate in `--fixture` mode (scanning only the fixture directory)
 * and asserts:
 *   (a) violation.ts is flagged — its `handleSend` call with a
 *       `required_capabilities` literal matches the anti-pattern regex,
 *   (b) clean.ts is not flagged — it calls `invokeCapability` directly.
 *
 * Holds the drift defense honest: if someone weakens the regex, the
 * violation fixture stops flagging and this test fails.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "check-affordance-routing.ts");

describe("check-affordance-routing (fixture round-trip)", () => {
  it("flags the violation fixture and passes the clean fixture", () => {
    const result = spawnSync("npx", ["tsx", SCRIPT, "--fixture"], { encoding: "utf-8", cwd: ROOT });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout) as { violations: string[] };
    // The violation fixture has multiple triggers (each hint pattern fires on
    // its own line); at least one must reference violation.ts, and none may
    // reference clean.ts.
    expect(parsed.violations.some((v) => v.includes("violation.ts"))).toBe(true);
    expect(parsed.violations.some((v) => v.includes("clean.ts"))).toBe(false);
  });

  it("passes cleanly when scanning the real repo (smoke)", () => {
    const result = spawnSync("npx", ["tsx", SCRIPT], { encoding: "utf-8", cwd: ROOT });
    // Non-zero exit = the real repo's apps/* tripped the gate. That's the
    // build-breaker the doctrine intends, so we assert clean here; if this
    // ever fails, fix the affordance (don't loosen the test).
    expect(result.status).toBe(0);
  });
});
