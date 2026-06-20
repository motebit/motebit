/**
 * check-browser-surface-buffer-polyfill probe — positive & negative fixtures.
 *
 * Invokes the gate in `--fixture` mode (scanning only the fixture tree) and
 * asserts BOTH correctness axes:
 *   (a) the gate BITES — `missing-all` (wallet-solana but no polyfill) is flagged
 *       for all three parts;
 *   (b) the gate stays SILENT on correct code — neither canonical placement
 *       (`web-style`, assignment in index.html; `src-style`, assignment in a src/
 *       module) is flagged, and `no-solana` (not a trigger) is not flagged.
 *
 * `check-gates-effective` already proves axis (a) for the real tree. Axis (b) —
 * no false positive on a correct-but-differently-shaped config — is the axis the
 * first cut of this gate got wrong (it scanned only src/ and false-flagged the
 * real apps/web, whose assignment is in index.html). This test makes "accepts
 * either placement" an executable assertion, not a thing checked once by hand:
 * a gate that fails on correct code is itself a bug.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "check-browser-surface-buffer-polyfill.ts");

interface Finding {
  app: string;
  missing: string[];
}

function flaggedApps(): Finding[] {
  const result = spawnSync("npx", ["tsx", SCRIPT, "--fixture"], { encoding: "utf-8", cwd: ROOT });
  expect(result.status).toBe(0);
  return (JSON.parse(result.stdout) as { flagged: Finding[] }).flagged;
}

describe("check-browser-surface-buffer-polyfill (fixture round-trip)", () => {
  it("BITES: flags a triggered surface missing all three polyfill parts", () => {
    const flagged = flaggedApps();
    const missingAll = flagged.find((f) => f.app === "missing-all");
    expect(missingAll).toBeDefined();
    // All three parts are reported missing.
    expect(missingAll!.missing.length).toBe(3);
  });

  it("NO FALSE POSITIVE: accepts the index.html placement (web-style)", () => {
    // The exact regression guard — the first cut scanned only src/ and would
    // flag this correct fixture.
    expect(flaggedApps().some((f) => f.app === "web-style")).toBe(false);
  });

  it("NO FALSE POSITIVE: accepts the src/ module placement (src-style)", () => {
    expect(flaggedApps().some((f) => f.app === "src-style")).toBe(false);
  });

  it("does not trigger on a Vite surface that never reaches wallet-solana", () => {
    expect(flaggedApps().some((f) => f.app === "no-solana")).toBe(false);
  });

  it("passes cleanly when scanning the real repo (smoke)", () => {
    const result = spawnSync("npx", ["tsx", SCRIPT], { encoding: "utf-8", cwd: ROOT });
    // Non-zero = a real browser surface lost its Buffer polyfill. Fix the
    // surface (don't loosen the test).
    expect(result.status).toBe(0);
  });
});
