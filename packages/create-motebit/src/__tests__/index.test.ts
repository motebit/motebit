import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BIN = join(__dirname, "../../dist/index.js");
const PKG = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const VERSION = PKG.version as string;

function run(
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
): { stdout: string; stderr: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [BIN, ...args], {
      encoding: "utf-8",
      cwd,
      env: { ...process.env, NO_COLOR: "1", ...env },
    });
    return { stdout, stderr: "", exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", exitCode: e.status ?? 1 };
  }
}

describe("create-motebit", () => {
  let testDir: string;
  let configDir: string;

  beforeEach(() => {
    testDir = join(
      tmpdir(),
      `create-motebit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    configDir = join(testDir, ".motebit-config");
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // -- version / help --

  it("prints version with --version", () => {
    const { stdout, exitCode } = run(["--version"]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(VERSION);
  });

  it("prints help with --help", () => {
    const { stdout, exitCode } = run(["--help"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("create-motebit");
    expect(stdout).toContain("npm create motebit");
    expect(stdout).toContain("verify");
    expect(stdout).toContain("--yes");
    expect(stdout).toContain("MOTEBIT_PASSPHRASE");
  });

  // -- scaffold with --yes --

  it("scaffolds project with --yes and MOTEBIT_PASSPHRASE", () => {
    const subDir = "my-agent";
    const { stdout, exitCode } = run([subDir, "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-123",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Created");
    expect(stdout).toContain(subDir);

    const projectDir = join(testDir, subDir);

    // All project files created
    expect(existsSync(join(projectDir, "package.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".env.example"))).toBe(true);
    expect(existsSync(join(projectDir, ".gitignore"))).toBe(true);
    expect(existsSync(join(projectDir, "motebit.md"))).toBe(true);

    // verify.js created
    expect(existsSync(join(projectDir, "verify.js"))).toBe(true);

    // package.json has correct content
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
    expect(pkg.dependencies).toHaveProperty("@motebit/verify");
    expect(pkg.dependencies["@motebit/verify"]).toBe("^0.4.0");
    expect(pkg.scripts.verify).toContain("create-motebit verify");
    expect(pkg.type).toBe("module");
    expect(pkg.private).toBe(true);
    expect(pkg.name).toBe(subDir);

    // .env.example has API key placeholder
    const env = readFileSync(join(projectDir, ".env.example"), "utf-8");
    expect(env).toContain("ANTHROPIC_API_KEY");

    // .gitignore has expected entries
    const gi = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(gi).toContain("node_modules/");
    expect(gi).toContain(".env");
    expect(gi).toContain("*.key");

    // motebit.md exists and contains spec
    const identity = readFileSync(join(projectDir, "motebit.md"), "utf-8");
    expect(identity).toContain("motebit/identity@1.0");
    expect(identity).toContain("<!-- motebit:sig:Ed25519:");

    // Config was written
    const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(config.motebit_id).toBeTruthy();
    expect(config.device_id).toBeTruthy();
    expect(config.device_public_key).toBeTruthy();
    expect(config.cli_encrypted_key).toBeTruthy();
    expect(config.cli_encrypted_key.ciphertext).toBeTruthy();
    expect(config.cli_encrypted_key.nonce).toBeTruthy();
    expect(config.cli_encrypted_key.tag).toBeTruthy();
    expect(config.cli_encrypted_key.salt).toBeTruthy();
    expect(config.default_provider).toBe("anthropic");
  });

  // -- agent scaffold --

  it("scaffolds agent project with --agent --yes", () => {
    const subDir = "test-service";
    const { stdout, exitCode } = run([subDir, "--agent", "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-123",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Agent created");

    const projectDir = join(testDir, subDir);

    // Agent-specific files
    expect(existsSync(join(projectDir, "src", "tools.ts"))).toBe(true);
    expect(existsSync(join(projectDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(projectDir, "motebit.md"))).toBe(true);
    expect(existsSync(join(projectDir, "package.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".env.example"))).toBe(true);
    expect(existsSync(join(projectDir, ".gitignore"))).toBe(true);

    // package.json has agent scripts
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
    expect(pkg.scripts.dev).toContain("--direct");
    expect(pkg.scripts.dev).not.toContain("--self-test");
    expect(pkg.scripts.dev).toContain("--tools");
    expect(pkg.scripts.start).toContain("--direct");
    expect(pkg.scripts.start).toContain("--self-test");
    expect(pkg.dependencies).toHaveProperty("@motebit/sdk");
    expect(pkg.devDependencies).toHaveProperty("motebit");

    // tools.ts has echo tool
    const tools = readFileSync(join(projectDir, "src", "tools.ts"), "utf-8");
    expect(tools).toContain("echo");
    expect(tools).toContain("ToolDefinition");

    // tsconfig targets ES2022 + Node16
    const tsconfig = JSON.parse(readFileSync(join(projectDir, "tsconfig.json"), "utf-8"));
    expect(tsconfig.compilerOptions.module).toBe("Node16");

    // motebit.md is a service identity
    const identity = readFileSync(join(projectDir, "motebit.md"), "utf-8");
    expect(identity).toContain("motebit/identity@1.0");
    expect(identity).toContain('type: "service"');

    // .gitignore includes dist/
    const gi = readFileSync(join(projectDir, ".gitignore"), "utf-8");
    expect(gi).toContain("dist/");

    // .env.example has relay vars
    const env = readFileSync(join(projectDir, ".env.example"), "utf-8");
    expect(env).toContain("MOTEBIT_SYNC_URL");
    expect(env).toContain("MOTEBIT_API_TOKEN");
  });

  it("--yes without MOTEBIT_PASSPHRASE fails", () => {
    const { exitCode, stdout } = run(["my-agent", "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("MOTEBIT_PASSPHRASE");
  });

  // -- existing project guard --

  it("refuses to scaffold over existing package.json", () => {
    writeFileSync(join(testDir, "package.json"), "{}", "utf-8");

    const { stdout, exitCode } = run(["--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    expect(exitCode).toBe(1);
    expect(stdout).toContain("already exists");
  });

  // -- console output --

  it("prints next steps with cd when using directory arg", () => {
    const { stdout } = run(["my-project", "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pw",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    expect(stdout).toContain("cd my-project");
    expect(stdout).toContain("npm install");
    expect(stdout).toContain("node verify.js");
  });

  it("shows Motebit ID in output", () => {
    const { stdout } = run(["my-project", "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pw",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    expect(stdout).toContain("Motebit ID:");
  });

  it("shows config path in output", () => {
    const { stdout } = run(["my-project", "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pw",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    expect(stdout).toContain("config.json");
  });

  // -- config merge --

  it("preserves existing config fields when writing identity", () => {
    // Write a config with existing data
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({ some_custom_field: "preserved", temperature: 0.7 }),
      "utf-8",
    );

    run(["my-project", "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pw",
      MOTEBIT_CONFIG_DIR: configDir,
    });

    const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(config.some_custom_field).toBe("preserved");
    expect(config.temperature).toBe(0.7);
    expect(config.motebit_id).toBeTruthy();
  });

  // -- verify --

  it("handles missing file gracefully", () => {
    const { stdout, exitCode } = run(["verify", "/tmp/does-not-exist.md"]);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Could not read");
  });

  it("verifies a generated motebit.md", () => {
    // First scaffold
    run(["my-project", "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pw",
      MOTEBIT_CONFIG_DIR: configDir,
    });

    const identityPath = join(testDir, "my-project", "motebit.md");
    expect(existsSync(identityPath)).toBe(true);

    // Then verify
    const { stdout, exitCode } = run(["verify", identityPath]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("valid");
    expect(stdout).toContain("motebit_id");
    expect(stdout).toContain("trust_mode");
  });

  // -- rotate --

  it("rotates key with --yes", () => {
    // Scaffold first
    const subDir = "rotate-test";
    run([subDir, "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-rotate",
      MOTEBIT_CONFIG_DIR: configDir,
    });

    const identityPath = join(testDir, subDir, "motebit.md");
    expect(existsSync(identityPath)).toBe(true);

    // Read old public key from config
    const configBefore = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    const oldKey = configBefore.device_public_key as string;

    // Rotate
    const { stdout, exitCode } = run(["rotate", identityPath, "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-rotate",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Key rotated successfully");
    expect(stdout).toContain("rotations");

    // Config should have a different public key
    const configAfter = JSON.parse(readFileSync(join(configDir, "config.json"), "utf-8"));
    expect(configAfter.device_public_key).not.toBe(oldKey);

    // Verify the rotated identity
    const { stdout: verifyOut, exitCode: verifyExit } = run(["verify", identityPath]);
    expect(verifyExit).toBe(0);
    expect(verifyOut).toContain("valid");
  });

  it("rotate on missing file fails gracefully", () => {
    const { stdout, exitCode } = run(
      ["rotate", join(testDir, "nonexistent.md"), "--yes"],
      testDir,
      {
        MOTEBIT_PASSPHRASE: "test-pass",
        MOTEBIT_CONFIG_DIR: configDir,
      },
    );
    expect(exitCode).toBe(1);
    expect(stdout).toContain("Could not read");
  });

  it("rotate shows old and new key in output", () => {
    // Scaffold first
    const subDir = "rotate-keys-test";
    run([subDir, "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-keys",
      MOTEBIT_CONFIG_DIR: configDir,
    });

    const identityPath = join(testDir, subDir, "motebit.md");

    // Rotate
    const { stdout, exitCode } = run(
      ["rotate", identityPath, "--yes", "--reason", "scheduled rotation"],
      testDir,
      {
        MOTEBIT_PASSPHRASE: "test-pass-keys",
        MOTEBIT_CONFIG_DIR: configDir,
      },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("old key");
    expect(stdout).toContain("new key");
    expect(stdout).toContain("scheduled rotation");
  });

  it("double rotation preserves succession chain integrity", () => {
    const subDir = "double-rotate-test";
    run([subDir, "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-double",
      MOTEBIT_CONFIG_DIR: configDir,
    });

    const identityPath = join(testDir, subDir, "motebit.md");

    // Read original public key
    const original = readFileSync(identityPath, "utf-8");
    const origKeyMatch = original.match(/public_key:\s*"([0-9a-f]+)"/);
    expect(origKeyMatch).not.toBeNull();
    const key0 = origKeyMatch![1]!;

    // First rotation
    run(["rotate", identityPath, "--yes", "--reason", "first"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-double",
      MOTEBIT_CONFIG_DIR: configDir,
    });

    const afterFirst = readFileSync(identityPath, "utf-8");
    // Succession record should contain the original key as old_public_key
    expect(afterFirst).toContain(`old_public_key: "${key0}"`);
    // Extract key1
    const key1Match = afterFirst.match(/^ {2}public_key: "([0-9a-f]+)"/m);
    expect(key1Match).not.toBeNull();
    const key1 = key1Match![1]!;
    expect(key1).not.toBe(key0);

    // Second rotation
    const { exitCode } = run(["rotate", identityPath, "--yes", "--reason", "second"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-double",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    expect(exitCode).toBe(0);

    const afterSecond = readFileSync(identityPath, "utf-8");

    // First succession record must still have key0 as old_public_key (not corrupted)
    expect(afterSecond).toContain(`old_public_key: "${key0}"`);
    // First succession record must still have key1 as new_public_key
    expect(afterSecond).toContain(`new_public_key: "${key1}"`);
    // Second succession record must have key1 as old_public_key
    // The identity public_key should be key2 (neither key0 nor key1)
    const key2Match = afterSecond.match(/^ {2}public_key: "([0-9a-f]+)"/m);
    expect(key2Match).not.toBeNull();
    const key2 = key2Match![1]!;
    expect(key2).not.toBe(key0);
    expect(key2).not.toBe(key1);

    // Verify the file is still valid
    const { exitCode: verifyExit } = run(["verify", identityPath]);
    expect(verifyExit).toBe(0);
  });

  it("rotation creates backup file", () => {
    const subDir = "backup-test";
    run([subDir, "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-backup",
      MOTEBIT_CONFIG_DIR: configDir,
    });

    const identityPath = join(testDir, subDir, "motebit.md");
    const backupPath = `${identityPath}.backup`;

    // Rotate
    run(["rotate", identityPath, "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-backup",
      MOTEBIT_CONFIG_DIR: configDir,
    });

    // Backup should exist with the original content
    expect(existsSync(backupPath)).toBe(true);
    const backup = readFileSync(backupPath, "utf-8");
    const rotated = readFileSync(identityPath, "utf-8");
    expect(backup).not.toBe(rotated);
    // Backup should NOT contain succession (it's the pre-rotation version)
    expect(backup).not.toContain("succession:");
  });
});
