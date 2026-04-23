/**
 * check-tool-modes probe — smoke test against the real repo.
 *
 * The gate scans `packages/tools/src/builtins` and `apps/desktop/src`
 * for `ToolDefinition` literals and requires every one to declare a
 * `mode:` field. This test confirms the current repo state passes —
 * the build-breaker fires iff someone ships a new ToolDefinition
 * without tagging it.
 *
 * Holding the drift defense honest: if someone weakens the extraction
 * regex (say, by tightening it to require `ToolDefinition<T>`), the
 * gate silently matches fewer literals and the check stops protecting
 * anything. A sibling test against a fixture with a known-missing tag
 * would catch that; for now the smoke test + manual negative-path
 * verification (temp-delete a mode tag, confirm gate fires) is the
 * coverage.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "check-tool-modes.ts");

describe("check-tool-modes (smoke)", () => {
  it("passes against the real repo — every ToolDefinition declares a mode", () => {
    const result = spawnSync("npx", ["tsx", SCRIPT], { encoding: "utf-8", cwd: ROOT });
    // Non-zero exit = a real builtin ships without a mode tag. That's the
    // build-breaker the doctrine intends, so we assert clean here; if this
    // ever fails, add the tag (don't loosen the test).
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("every scanned ToolDefinition declares a mode");
  });
});
