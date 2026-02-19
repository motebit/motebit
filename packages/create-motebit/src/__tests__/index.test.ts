import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
    expect(stdout).toContain("Scaffold");
  });

  // -- scaffold in current directory --

  it("scaffolds project in current directory when no arg given", () => {
    const { stdout, exitCode } = run([], testDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Scaffolded");

    // All project files created
    expect(existsSync(join(testDir, "package.json"))).toBe(true);
    expect(existsSync(join(testDir, ".env.example"))).toBe(true);
    expect(existsSync(join(testDir, ".gitignore"))).toBe(true);

    // No identity file — that's the CLI's job
    expect(existsSync(join(testDir, "motebit.md"))).toBe(false);

    // package.json has correct content
    const pkg = JSON.parse(readFileSync(join(testDir, "package.json"), "utf-8"));
    expect(pkg.dependencies).toHaveProperty("motebit");
    expect(pkg.dependencies.motebit).toBe("0.1.0");
    expect(pkg.scripts.chat).toBe("motebit");
    expect(pkg.type).toBe("module");
    expect(pkg.private).toBe(true);

    // .env.example has API key placeholder
    const env = readFileSync(join(testDir, ".env.example"), "utf-8");
    expect(env).toContain("ANTHROPIC_API_KEY");

    // .gitignore has expected entries
    const gi = readFileSync(join(testDir, ".gitignore"), "utf-8");
    expect(gi).toContain("node_modules/");
    expect(gi).toContain(".env");
    expect(gi).toContain("*.key");
  });

  // -- scaffold with directory arg --

  it("scaffolds project in a named subdirectory", () => {
    const subDir = "my-agent";
    const { stdout, exitCode } = run([subDir], testDir);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Scaffolded");
    expect(stdout).toContain(subDir);

    const projectDir = join(testDir, subDir);
    expect(existsSync(join(projectDir, "package.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".env.example"))).toBe(true);
    expect(existsSync(join(projectDir, ".gitignore"))).toBe(true);

    // package.json name matches directory
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
    expect(pkg.name).toBe(subDir);
  });

  // -- existing project guard --

  it("refuses to scaffold over existing package.json", () => {
    writeFileSync(join(testDir, "package.json"), "{}", "utf-8");

    const { stdout, exitCode } = run([], testDir);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("already exists");
  });

  // -- console output --

  it("prints next steps with cd when using directory arg", () => {
    const { stdout } = run(["my-project"], testDir);
    expect(stdout).toContain("cd my-project");
    expect(stdout).toContain("npm install");
    expect(stdout).toContain("npx motebit");
  });

  it("omits cd when scaffolding in current directory", () => {
    const { stdout } = run([], testDir);
    expect(stdout).not.toMatch(/cd \S/);
    expect(stdout).toContain("npm install");
  });

  it("mentions motebit export for daemon mode", () => {
    const { stdout } = run([], testDir);
    expect(stdout).toContain("motebit export");
  });

  // -- verify --

  it("handles missing file gracefully", () => {
    const { stdout, exitCode } = run(["verify", "/tmp/does-not-exist.md"]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Could not read");
  });
});
