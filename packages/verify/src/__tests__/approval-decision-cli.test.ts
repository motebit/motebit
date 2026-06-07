/**
 * `motebit-verify approval-decision` subcommand — unit + end-to-end tests.
 *
 * The "approve" band of the governance triad made consumable through the public
 * CLI: a signed human-consent `ApprovalDecision` (proof of permission before a
 * gated act) verifies offline against its embedded approver key. Unit-tests the
 * arg parser + failure-reason map; one subprocess block exercises the binary
 * end-to-end via `npx tsx` — confirming the wiring from `parseArgs` →
 * `verifyApprovalDecisionCli` → `verifyApprovalDecision` from `@motebit/crypto`.
 *
 * The crypto primitive itself is exhaustively tested in `@motebit/crypto`; this
 * file only confirms the CLI surface composes correctly.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { signApprovalDecision, generateKeypair, bytesToHex } from "@motebit/crypto";

import { parseArgs, describeApprovalDecisionReason } from "../cli.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = resolve(HERE, "..", "cli.ts");

function makeDecisionBody(overrides?: { verdict?: "approved" | "denied" }) {
  return {
    approval_id: "tc-cli-1",
    motebit_id: "motebit-executor",
    device_id: "device-approver",
    tool_name: "send_money",
    args_hash: "a".repeat(64),
    risk_level: 4,
    verdict: overrides?.verdict ?? ("approved" as const),
    requested_at: 1000,
    resolved_at: 2000,
  };
}

// --- Pure-function unit tests ----------------------------------------------

describe("parseArgs — approval-decision subcommand", () => {
  it("dispatches into verify-approval-decision mode when 'approval-decision' is the first positional", () => {
    const args = parseArgs(["approval-decision", "decision.json"]);
    expect(args.mode).toBe("verify-approval-decision");
    expect(args.file).toBe("decision.json");
  });

  it("rejects when the decision-file is missing", () => {
    const args = parseArgs(["approval-decision"]);
    expect(args.mode).toBe("help");
    expect(args.usageError).toMatch(/missing decision-file/);
  });

  it("rejects --producer-key values that are not 64 hex chars", () => {
    const args = parseArgs(["approval-decision", "d.json", "--producer-key", "abc"]);
    expect(args.mode).toBe("help");
    expect(args.usageError).toMatch(/64 hex characters/);
  });

  it("normalizes --producer-key to lowercase", () => {
    const args = parseArgs(["approval-decision", "d.json", "--producer-key", "F".repeat(64)]);
    expect(args.mode).toBe("verify-approval-decision");
    expect(args.expectedProducerKey).toBe("f".repeat(64));
  });

  it("accepts --expect-verdict approved|denied and rejects anything else", () => {
    const ok = parseArgs(["approval-decision", "d.json", "--expect-verdict", "denied"]);
    expect(ok.mode).toBe("verify-approval-decision");
    expect(ok.expectedVerdict).toBe("denied");

    const bad = parseArgs(["approval-decision", "d.json", "--expect-verdict", "maybe"]);
    expect(bad.mode).toBe("help");
    expect(bad.usageError).toMatch(/approved.*denied/);
  });

  it("does NOT trigger approval-decision mode when the keyword is not the FIRST positional", () => {
    const args = parseArgs(["some-credential.json"]);
    expect(args.mode).toBe("verify");
    expect(args.file).toBe("some-credential.json");
  });
});

describe("describeApprovalDecisionReason — typed-failure-to-prose map", () => {
  it("returns specific phrasing for every known reason", () => {
    for (const reason of [
      "signature_invalid",
      "no_verifying_key",
      "malformed_public_key",
      "producer_key_mismatch",
      "verdict_mismatch",
      "malformed_decision",
    ]) {
      const phrase = describeApprovalDecisionReason(reason);
      expect(phrase).not.toBe(reason);
      expect(phrase.length).toBeGreaterThan(0);
    }
  });

  it("falls back to the raw reason for unknown values", () => {
    expect(describeApprovalDecisionReason("brand_new_reason")).toBe("brand_new_reason");
  });
});

// --- End-to-end subprocess tests --------------------------------------------

describe("motebit-verify approval-decision — subprocess end-to-end", () => {
  let tmp: string;
  let approverKeyHex: string;
  let approvedPath: string;
  let deniedPath: string;
  let noKeyPath: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "motebit-verify-approval-e2e-"));
    const approver = await generateKeypair();
    approverKeyHex = bytesToHex(approver.publicKey);

    // Embeds public_key → self-contained offline verification.
    const approved = await signApprovalDecision(
      makeDecisionBody({ verdict: "approved" }),
      approver.privateKey,
      approver.publicKey,
    );
    approvedPath = join(tmp, "approved.json");
    writeFileSync(approvedPath, JSON.stringify(approved));

    const denied = await signApprovalDecision(
      { ...makeDecisionBody({ verdict: "denied" }), denied_reason: "User denied this tool call." },
      approver.privateKey,
      approver.publicKey,
    );
    deniedPath = join(tmp, "denied.json");
    writeFileSync(deniedPath, JSON.stringify(denied));

    // No embedded public_key → requires --producer-key to verify.
    const noKey = await signApprovalDecision(makeDecisionBody(), approver.privateKey);
    noKeyPath = join(tmp, "no-key.json");
    writeFileSync(noKeyPath, JSON.stringify(noKey));
  });

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

  it("exits 0 and prints VERIFIED on a valid approved decision (offline, embedded key)", () => {
    const res = runCli(["approval-decision", approvedPath]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toMatch(/✓ approval-decision VERIFIED/);
    expect(res.stdout).toMatch(/verdict\s+APPROVED/);
  });

  it("verifies a denied decision and shows the denied_reason", () => {
    const res = runCli(["approval-decision", deniedPath]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toMatch(/verdict\s+DENIED/);
    expect(res.stdout).toMatch(/denied_reason/);
  });

  it("exits 1 with signature_invalid when the verdict is tampered after signing", () => {
    // Flip approved→denied on a signed body; the signature was over "approved".
    const tamperedPath = join(tmp, "tampered.json");
    const signed = JSON.parse(readFileSync(approvedPath, "utf-8")) as Record<string, unknown>;
    writeFileSync(tamperedPath, JSON.stringify({ ...signed, verdict: "denied" }));
    const res = runCli(["approval-decision", tamperedPath]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/signature_invalid|does not verify/);
  });

  it("exits 1 with producer_key_mismatch when --producer-key disagrees with the embedded key", () => {
    const res = runCli(["approval-decision", approvedPath, "--producer-key", "0".repeat(64)]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/producer_key_mismatch|does not match the value pinned/);
  });

  it("exits 0 when --producer-key matches the embedded approver key", () => {
    const res = runCli(["approval-decision", approvedPath, "--producer-key", approverKeyHex]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
  });

  it("exits 1 with verdict_mismatch when --expect-verdict disagrees", () => {
    const res = runCli(["approval-decision", approvedPath, "--expect-verdict", "denied"]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/verdict_mismatch|does not match the value required/);
  });

  it("exits 1 with no_verifying_key when there is no embedded key and no --producer-key", () => {
    const res = runCli(["approval-decision", noKeyPath]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/no_verifying_key|nothing to verify/);
  });

  it("verifies a key-less decision when --producer-key supplies the approver key", () => {
    const res = runCli(["approval-decision", noKeyPath, "--producer-key", approverKeyHex]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toMatch(/✓ approval-decision VERIFIED/);
  });

  it("emits structured JSON when --json is set", () => {
    const res = runCli(["approval-decision", approvedPath, "--json"]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    const parsed = JSON.parse(res.stdout) as { valid: boolean; decision: { verdict: string } };
    expect(parsed.valid).toBe(true);
    expect(parsed.decision.verdict).toBe("approved");
  });
});
