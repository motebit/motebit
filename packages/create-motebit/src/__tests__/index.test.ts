import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verify } from "@motebit/verify";

const BIN = join(__dirname, "../../dist/index.js");

function run(args: string[], cwd?: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [BIN, ...args], {
      encoding: "utf-8",
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", exitCode: e.status ?? 1 };
  }
}

describe("create-motebit", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `create-motebit-test-${Date.now()}`);
    execFileSync("mkdir", ["-p", testDir]);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // -- version / help --

  it("prints version with --version", () => {
    const { stdout, exitCode } = run(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe("0.1.0");
  });

  it("prints help with --help", () => {
    const { stdout, exitCode } = run(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("create-motebit");
    expect(stdout).toContain("npm create motebit");
    expect(stdout).toContain("verify");
  });

  // -- init --

  it("generates a valid motebit.md", async () => {
    const { stdout, exitCode } = run([], testDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Generated agent identity");
    expect(stdout).toContain("motebit_id");
    expect(stdout).toContain("Ed25519");

    const filePath = join(testDir, "motebit.md");
    expect(existsSync(filePath)).toBe(true);

    // Verify the generated file with @motebit/verify
    const content = readFileSync(filePath, "utf-8");
    const result = await verify(content);
    expect(result.valid).toBe(true);
    expect(result.identity).not.toBeNull();
    expect(result.identity!.spec).toBe("motebit/identity@1.0");
    expect(result.identity!.governance.trust_mode).toBe("guarded");
  });

  it("supports --output flag", async () => {
    const outPath = join(testDir, "custom.md");
    const { exitCode } = run(["--output", outPath], testDir);
    expect(exitCode).toBe(0);
    expect(existsSync(outPath)).toBe(true);

    const content = readFileSync(outPath, "utf-8");
    const result = await verify(content);
    expect(result.valid).toBe(true);
  });

  it("supports -o flag", async () => {
    const outPath = join(testDir, "short.md");
    const { exitCode } = run(["-o", outPath], testDir);
    expect(exitCode).toBe(0);
    expect(existsSync(outPath)).toBe(true);
  });

  it("refuses to overwrite existing motebit.md", () => {
    // Create first
    run([], testDir);
    // Try again — should fail
    const { stdout, exitCode } = run([], testDir);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("already exists");
  });

  // -- verify --

  it("verifies a valid file", () => {
    run([], testDir);
    const filePath = join(testDir, "motebit.md");
    const { stdout, exitCode } = run(["verify", filePath]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("valid");
    expect(stdout).toContain("motebit_id");
  });

  it("rejects a tampered file", () => {
    run([], testDir);
    const filePath = join(testDir, "motebit.md");

    // Tamper with the file
    let content = readFileSync(filePath, "utf-8");
    content = content.replace("guarded", "full");
    const { writeFileSync } = require("node:fs");
    writeFileSync(filePath, content, "utf-8");

    const { stdout, exitCode } = run(["verify", filePath]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("invalid");
  });

  it("handles missing file gracefully", () => {
    const { stdout, exitCode } = run(["verify", "/tmp/does-not-exist.md"]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Could not read");
  });
});
