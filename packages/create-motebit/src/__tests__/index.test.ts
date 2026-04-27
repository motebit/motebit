import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const BIN = join(__dirname, "../../dist/index.js");
const PKG = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf-8"));
const VERSION = PKG.version as string;
// The scaffold pins @motebit/crypto to its actual published version, which
// bumps independently from create-motebit (e.g. crypto 1.1.0 + create-motebit
// 1.1.1 in this release). Read crypto's package.json directly — same source
// tsup.config.ts uses to inject __CRYPTO_VERSION__ into the scaffold output.
const CRYPTO_PKG = JSON.parse(
  readFileSync(join(__dirname, "../../../crypto/package.json"), "utf-8"),
);
const CRYPTO_VERSION = CRYPTO_PKG.version as string;

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
    expect(pkg.dependencies).toHaveProperty("@motebit/crypto");
    expect(pkg.dependencies["@motebit/crypto"]).toBe(`^${CRYPTO_VERSION}`);
    // verify script uses the canonical @motebit/verify CLI invocation
    // (not the unscoped `npx motebit-verify` which 404s on npm); same
    // convention as the agent scaffold's verify script.
    expect(pkg.scripts.verify).toContain("@motebit/verify");
    expect(pkg.scripts.verify).toContain("motebit-verify");
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
    expect(identity).toContain("<!-- motebit:sig:motebit-jcs-ed25519-hex-v1:");

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
    expect(existsSync(join(projectDir, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(projectDir, "src", "tools.ts"))).toBe(true);
    expect(existsSync(join(projectDir, "tsconfig.json"))).toBe(true);
    expect(existsSync(join(projectDir, "motebit.md"))).toBe(true);
    expect(existsSync(join(projectDir, "package.json"))).toBe(true);
    expect(existsSync(join(projectDir, ".env.example"))).toBe(true);
    expect(existsSync(join(projectDir, ".gitignore"))).toBe(true);

    // package.json has agent scripts
    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
    expect(pkg.scripts.dev).toBeDefined();
    expect(pkg.scripts.start).toBeDefined();
    expect(pkg.scripts["self-test"]).toContain("--self-test");
    expect(pkg.dependencies).toHaveProperty("@motebit/sdk");
    expect(pkg.dependencies).toHaveProperty("motebit");

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

  // -- agent scaffold runnable-shape regressions --
  //
  // The following tests guard the two findings from the 2026-04-25 --agent
  // walkthrough. Both were silent because release.yml's CI smoke only
  // exercises the default (identity-only) scaffold, never --agent. Either
  // gap reproduces 100% on every fresh install and prevents the agent
  // from ever starting.

  it("agent scaffold's package.json includes @types/node in devDependencies", () => {
    // Without @types/node the TypeScript build immediately fails on the
    // `node:fs` / `node:path` / `node:child_process` imports in
    // src/index.ts. tsconfig has no `types` array, so TS auto-includes
    // any @types/* in node_modules — but that only works if the package
    // is actually installed.
    const subDir = "agent-types-test";
    const { exitCode } = run([subDir, "--agent", "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-types",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    expect(exitCode).toBe(0);

    const pkg = JSON.parse(readFileSync(join(testDir, subDir, "package.json"), "utf-8"));
    expect(pkg.devDependencies["@types/node"]).toBeTruthy();
  });

  it("agent scaffold's entrypoint guards module-level side effects with isMainModule", () => {
    // `motebit serve --tools dist/index.js` re-imports the agent's own
    // entrypoint to discover its tool definitions. Without a main-module
    // guard, that re-import re-fires the spawn block and recursively
    // spawns another `motebit serve`, which re-imports, recursive,
    // forever. The guard makes the spawn block fire only when the file
    // is executed directly.
    const subDir = "agent-guard-test";
    const { exitCode } = run([subDir, "--agent", "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-guard",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    expect(exitCode).toBe(0);

    const indexTs = readFileSync(join(testDir, subDir, "src", "index.ts"), "utf-8");
    expect(indexTs).toContain('import { fileURLToPath } from "node:url";');
    expect(indexTs).toContain("isMainModule");
    expect(indexTs).toMatch(/process\.argv\[1\]\s*===\s*fileURLToPath\(import\.meta\.url\)/);
    // The execFileSync block must be inside the guard, not at top level.
    const guardIdx = indexTs.indexOf("if (isMainModule)");
    const spawnIdx = indexTs.indexOf("execFileSync");
    expect(guardIdx).toBeGreaterThan(0);
    expect(spawnIdx).toBeGreaterThan(guardIdx);
  });

  it("default scaffold writes a README documenting verify commands and motebit_id", () => {
    // Walk gap #5: closing the terminal lost the next-steps. README is
    // the durable record. Must mention both verify paths and the
    // motebit_id (so the README is forensic if config.json drifts).
    const subDir = "default-readme-test";
    run([subDir, "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-readme",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    const readmePath = join(testDir, subDir, "README.md");
    expect(existsSync(readmePath)).toBe(true);
    const readme = readFileSync(readmePath, "utf-8");
    expect(readme).toContain("node verify.js");
    expect(readme).toContain("npx -p @motebit/verify motebit-verify motebit.md");
    expect(readme).toMatch(/motebit_id:\s*[0-9a-f-]+/);
  });

  it("agent scaffold writes a README and includes prestart for npm start safety", () => {
    // Walk gaps #A5 and #A6: README durability + npm start without a
    // prior build used to fail with "Cannot find module dist/index.js".
    // The prestart hook makes npm start build first automatically.
    const subDir = "agent-readme-test";
    run([subDir, "--agent", "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-agent-readme",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    const projectDir = join(testDir, subDir);

    const readmePath = join(projectDir, "README.md");
    expect(existsSync(readmePath)).toBe(true);
    const readme = readFileSync(readmePath, "utf-8");
    expect(readme).toContain("npm run dev");
    expect(readme).toContain("npm run verify");
    expect(readme).toContain("MOTEBIT_API_TOKEN");
    expect(readme).toContain("MOTEBIT_PASSPHRASE");

    const pkg = JSON.parse(readFileSync(join(projectDir, "package.json"), "utf-8"));
    expect(pkg.scripts.prestart).toBe("tsc");
    // `--env-file=.env` is what loads MOTEBIT_PASSPHRASE from .env at runtime.
    // Without it, the scaffolded onboarding chain (.env.example → .env →
    // decrypt) silently breaks: the file exists, contains the right value,
    // but the node process never reads it. See package.json template comment.
    expect(pkg.scripts.start).toBe("node --env-file=.env dist/index.js");
    expect(pkg.scripts.dev).toBe("tsc && node --env-file=.env dist/index.js");
    expect(pkg.engines?.node).toBe(">=20.6.0");
  });

  it("agent scaffold's next-steps output includes a verify step", () => {
    // Walk gap #A7: the agent next-steps used to drop the verify line
    // entirely (default scaffold included it; agent didn't). New users
    // had no canonical pointer to verify their motebit.md before
    // putting it on the network.
    const subDir = "agent-nextsteps-test";
    const { stdout } = run([subDir, "--agent", "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-nextsteps",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    expect(stdout).toContain("npm run verify");
  });

  it("agent scaffold's package.json verify script uses the @motebit/verify CLI", () => {
    // The default scaffold's next-steps were updated in the 2026-04-25
    // identity-clobber-gate commit to use `npx -p @motebit/verify
    // motebit-verify motebit.md`; the agent scaffold's package.json
    // `verify` script must follow the same convention so the unscoped
    // `npx motebit-verify` (which 404s on npm) is never suggested.
    const subDir = "agent-verify-test";
    run([subDir, "--agent", "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pass-verify",
      MOTEBIT_CONFIG_DIR: configDir,
    });
    const pkg = JSON.parse(readFileSync(join(testDir, subDir, "package.json"), "utf-8"));
    expect(pkg.scripts.verify).toContain("@motebit/verify");
    expect(pkg.scripts.verify).toContain("motebit-verify");
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
    // Write a config with existing data — but no motebit_id, so the
    // identity-clobber gate doesn't fire and the default scaffold path
    // can layer the new identity on top.
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

  // -- identity-clobber gate --
  //
  // Regression: --yes mode must refuse to overwrite an existing motebit
  // identity unless --force is passed. The interactive path already
  // prompts; the gap was that automation, CI smokes, and "I just want
  // to try it" users hit --yes and silently lost their existing
  // identity. See gap #2 in the 2026-04-25 first-time-user walkthrough.

  it("refuses to overwrite an existing identity with --yes by default", () => {
    // Seed config with a populated motebit_id (the clobber-prone field).
    mkdirSync(configDir, { recursive: true });
    const existingConfig = {
      motebit_id: "019dc549-0186-7e8f-aba2-72ea76d4a324",
      device_id: "af9aca7a-1b80-4935-997c-a1c871080cf5",
      device_public_key: "7625fe64424a83f6a4c5e10dee1f53ae2ff0a08b28594961d7f970abc416ea10",
      name: "preexisting",
      some_other_field: "must not be touched",
    };
    const configFile = join(configDir, "config.json");
    writeFileSync(configFile, JSON.stringify(existingConfig, null, 2), "utf-8");
    const beforeBytes = readFileSync(configFile, "utf-8");

    const { stdout, exitCode } = run(["my-project", "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pw",
      MOTEBIT_CONFIG_DIR: configDir,
    });

    // Exits non-zero with a message that names both escape hatches.
    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("existing motebit identity");
    expect(stdout).toContain("MOTEBIT_CONFIG_DIR");
    expect(stdout).toContain("--force");

    // Config file unchanged byte-for-byte. The whole point of the gate.
    const afterBytes = readFileSync(configFile, "utf-8");
    expect(afterBytes).toBe(beforeBytes);
  });

  it("--force overrides the gate and replaces the existing identity", () => {
    mkdirSync(configDir, { recursive: true });
    const existingConfig = {
      motebit_id: "019dc549-0186-7e8f-aba2-72ea76d4a324",
      device_id: "af9aca7a-1b80-4935-997c-a1c871080cf5",
      some_other_field: "still preserved",
    };
    const configFile = join(configDir, "config.json");
    writeFileSync(configFile, JSON.stringify(existingConfig), "utf-8");

    const { exitCode } = run(["my-project", "--yes", "--force"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pw",
      MOTEBIT_CONFIG_DIR: configDir,
    });

    expect(exitCode).toBe(0);

    const after = JSON.parse(readFileSync(configFile, "utf-8"));
    // Identity replaced.
    expect(after.motebit_id).not.toBe(existingConfig.motebit_id);
    expect(after.motebit_id).toBeTruthy();
    // Non-identity fields preserved (saveConfig merges, doesn't replace).
    expect(after.some_other_field).toBe("still preserved");
  });

  it("--agent --yes refuses to clobber an existing local agent identity", () => {
    // Self-contained agent identity lives at `<agent>/.motebit/config.json`,
    // not the global `~/.motebit/`. The clobber gate guards the local path:
    // running `--agent --yes` on a directory that already has its own
    // `.motebit/config.json` must refuse without `--force`.
    const agentDir = join(testDir, "my-agent");
    const localConfigDir = join(agentDir, ".motebit");
    mkdirSync(localConfigDir, { recursive: true });
    const existingConfig = {
      motebit_id: "019dc549-0186-7e8f-aba2-72ea76d4a324",
    };
    const localConfigFile = join(localConfigDir, "config.json");
    writeFileSync(localConfigFile, JSON.stringify(existingConfig), "utf-8");
    const beforeBytes = readFileSync(localConfigFile, "utf-8");

    const { stdout, exitCode } = run(["my-agent", "--agent", "--yes"], testDir, {
      MOTEBIT_PASSPHRASE: "test-pw",
      // Note: NO MOTEBIT_CONFIG_DIR override — global config is irrelevant
      // to the agent path now. The gate must fire purely from the local
      // `.motebit/config.json` presence.
    });

    expect(exitCode).not.toBe(0);
    expect(stdout).toContain("existing motebit agent identity");
    const afterBytes = readFileSync(localConfigFile, "utf-8");
    expect(afterBytes).toBe(beforeBytes);
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
