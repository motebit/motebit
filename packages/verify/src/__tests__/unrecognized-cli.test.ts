/**
 * `motebit-verify <file>` exit-code honesty for UNRECOGNIZED artifacts.
 *
 * CLAUDE.md Rule 5: the CLI's exit codes distinguish verified (0) /
 * invalid-but-detected (1) / usage-or-unrecognized (2). An artifact that is not
 * a recognized motebit type is NOT a failed signature — it must exit 2 and
 * render UNRECOGNIZED, so a caller can tell "I can't process this" apart from
 * "this known artifact is forged." End-to-end via `npx tsx` against the binary.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = resolve(HERE, "..", "cli.ts");

function runCli(args: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const result = spawnSync("npx", ["--yes", "tsx", CLI_SRC, ...args], {
    encoding: "utf-8",
    timeout: 30_000,
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("motebit-verify — unrecognized artifact exit code", () => {
  let unknownPath: string;

  beforeAll(() => {
    const tmp = mkdtempSync(join(tmpdir(), "motebit-verify-unknown-"));
    unknownPath = join(tmp, "unknown.json");
    // Well-formed JSON, but not any recognized motebit artifact shape.
    writeFileSync(unknownPath, JSON.stringify({ foo: "bar", baz: 42 }));
  });

  it("exits 2 (unrecognized), NOT 1 (invalid signature), for an unknown artifact", () => {
    const res = runCli([unknownPath]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(2);
  });

  it("renders UNRECOGNIZED, not INVALID", () => {
    const res = runCli([unknownPath]);
    expect(res.stdout).toMatch(/UNRECOGNIZED \(unknown\)/);
    expect(res.stdout).not.toMatch(/INVALID/);
  });

  it("--json reports type 'unknown' with the unrecognized reason", () => {
    const res = runCli([unknownPath, "--json"]);
    const parsed = JSON.parse(res.stdout) as { type: string; valid: boolean; reason?: string };
    expect(parsed.type).toBe("unknown");
    expect(parsed.valid).toBe(false);
    expect(parsed.reason).toBe("unrecognized_artifact_type");
  });
});
