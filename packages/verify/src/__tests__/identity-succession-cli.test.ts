/**
 * `motebit-verify <motebit.md>` — an identity file is intact only when its
 * signature AND its succession chain verify (`identityVerifyOutcome`, the
 * same rule `motebit verify` and `create-motebit verify` apply). A file
 * re-signed by a key its chain never legitimately reaches has a valid
 * signature and is NOT intact: INVALID, exit 1 — never `VALID (identity)`.
 * End-to-end via `npx tsx` against the binary.
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

// A motebit.md validly signed by its current key, whose one succession link
// carries forged (all-zero) signatures — the chain never reaches that key.
// Signature-valid, NOT intact. (The same fixture create-motebit's tests use.)
const FORGED_CHAIN_MOTEBIT_MD = [
  "---",
  'spec: "motebit/identity@1.0"',
  'motebit_id: "019e2aa5-7649-7fa3-ab27-2e4d9d4f0ffb"',
  'created_at: "2026-01-15T00:00:00.000Z"',
  'owner_id: "owner"',
  "identity:",
  '  algorithm: "Ed25519"',
  '  public_key: "fe6f3a57e46193242ed0c260cc8d8728a7f29dcb82b3f90e07cdeaea298f99a0"',
  "governance:",
  '  trust_mode: "guarded"',
  '  max_risk_auto: "R1_DRAFT"',
  '  require_approval_above: "R1_DRAFT"',
  '  deny_above: "R4_MONEY"',
  "  operator_mode: false",
  "privacy:",
  '  default_sensitivity: "personal"',
  "  retention_days:",
  "    none: 365",
  "    personal: 90",
  "    medical: 30",
  "    financial: 30",
  "    secret: 7",
  "  fail_closed: true",
  "memory:",
  "  half_life_days: 7",
  "  confidence_threshold: 0.3",
  "  per_turn_limit: 5",
  "devices: []",
  "succession:",
  '  - old_public_key: "994ea5575436a6d23700b5e768c825a41a8fd542fe8fbefd23de103e63d4bcf5"',
  '    new_public_key: "fe6f3a57e46193242ed0c260cc8d8728a7f29dcb82b3f90e07cdeaea298f99a0"',
  "    timestamp: 1768435200000",
  '    old_key_signature: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"',
  '    new_key_signature: "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000"',
  '    suite: "motebit-jcs-ed25519-hex-v1"',
  "---",
  "<!-- motebit:sig:motebit-jcs-ed25519-hex-v1:28dc8a5c6dd17ba441835c70a11a55bf12f9743747cf4bef6b14268c5cf8b17420cd74196d317c4366bb42355d2324fea88686a20a63d166bf4b44aa3dee600e -->",
  "",
].join("\n");

describe("motebit-verify — identity file with a forged succession chain", () => {
  let forgedPath: string;

  beforeAll(() => {
    const tmp = mkdtempSync(join(tmpdir(), "motebit-verify-forged-chain-"));
    forgedPath = join(tmp, "motebit.md");
    writeFileSync(forgedPath, FORGED_CHAIN_MOTEBIT_MD);
  });

  it("exits 1 (invalid), never 0", () => {
    const res = runCli([forgedPath]);
    expect(res.status, `stdout: ${res.stdout}\nstderr: ${res.stderr}`).toBe(1);
  });

  it("renders INVALID (identity) with the succession reason, never VALID", () => {
    const res = runCli([forgedPath]);
    expect(res.stdout).toMatch(/^INVALID \(identity\)/);
    expect(res.stdout).toMatch(/succession chain invalid/i);
    expect(res.stdout).not.toMatch(/^VALID/m);
  });

  it("--json reports valid: false", () => {
    const res = runCli([forgedPath, "--json"]);
    const parsed = JSON.parse(res.stdout) as { type: string; valid: boolean };
    expect(parsed.type).toBe("identity");
    expect(parsed.valid).toBe(false);
  });
});
