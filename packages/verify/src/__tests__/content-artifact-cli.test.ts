/**
 * `motebit-verify content-artifact` subcommand — unit + end-to-end tests.
 *
 * Unit-tests the arg parser, manifest decoder, and failure-reason map.
 * One subprocess test exercises the binary end-to-end via `npx tsx` —
 * confirms the wiring from `parseArgs` → `verifyContentArtifactCli` →
 * `verifyContentArtifact` from `@motebit/crypto` returns exit 0 on a
 * valid round-trip and exit 1 with the expected reason on tampering.
 *
 * The crypto primitive (`verifyContentArtifact` / `signContentArtifact`)
 * is exhaustively tested in `@motebit/crypto`; this file only confirms
 * the CLI surface composes correctly.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { signContentArtifact } from "@motebit/crypto";
import { generateKeypair, bytesToHex } from "@motebit/crypto";

import { parseArgs, decodeManifestInput, describeContentArtifactReason } from "../cli.js";

/**
 * Header-encode a manifest. `state-export.ts` uses canonical-JSON for
 * determinism across implementations; the verifier accepts any
 * JSON-shaped manifest because it re-canonicalizes the unsigned
 * portion for signature verification. Tests use `JSON.stringify` to
 * avoid pulling in `@motebit/encryption` as a devDep.
 */
function manifestToHeader(manifest: object): string {
  return Buffer.from(new TextEncoder().encode(JSON.stringify(manifest))).toString("base64url");
}

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_SRC = resolve(HERE, "..", "cli.ts");

// --- Pure-function unit tests ----------------------------------------------

describe("parseArgs — content-artifact subcommand", () => {
  it("dispatches into verify-content-artifact mode when 'content-artifact' is the first positional", () => {
    const args = parseArgs(["content-artifact", "body.json", "--manifest", "AAAA"]);
    expect(args.mode).toBe("verify-content-artifact");
    expect(args.file).toBe("body.json");
    expect(args.manifest).toBe("AAAA");
  });

  it("rejects when body-file is missing", () => {
    const args = parseArgs(["content-artifact", "--manifest", "AAAA"]);
    expect(args.mode).toBe("help");
    expect(args.usageError).toMatch(/missing body-file/);
  });

  it("rejects when --manifest is missing", () => {
    const args = parseArgs(["content-artifact", "body.json"]);
    expect(args.mode).toBe("help");
    expect(args.usageError).toMatch(/--manifest is required/);
  });

  it("rejects --expect values outside the closed ContentArtifactType registry", () => {
    const args = parseArgs([
      "content-artifact",
      "body.json",
      "--manifest",
      "AAAA",
      "--expect",
      "not-a-real-type",
    ]);
    expect(args.mode).toBe("help");
    expect(args.usageError).toMatch(/unknown --expect value/);
  });

  it("accepts --expect values from the canonical registry", () => {
    const args = parseArgs([
      "content-artifact",
      "body.json",
      "--manifest",
      "AAAA",
      "--expect",
      "audit-trail",
    ]);
    expect(args.mode).toBe("verify-content-artifact");
    expect(args.expectedArtifactType).toBe("audit-trail");
  });

  it("rejects --producer-key values that are not 64 hex chars", () => {
    const tooShort = parseArgs([
      "content-artifact",
      "body.json",
      "--manifest",
      "AAAA",
      "--producer-key",
      "abc",
    ]);
    expect(tooShort.mode).toBe("help");
    expect(tooShort.usageError).toMatch(/64 hex characters/);

    const nonHex = parseArgs([
      "content-artifact",
      "body.json",
      "--manifest",
      "AAAA",
      "--producer-key",
      "Z".repeat(64),
    ]);
    expect(nonHex.mode).toBe("help");
    expect(nonHex.usageError).toMatch(/64 hex characters/);
  });

  it("normalizes --producer-key to lowercase", () => {
    const upperHex = "F".repeat(64);
    const args = parseArgs([
      "content-artifact",
      "body.json",
      "--manifest",
      "AAAA",
      "--producer-key",
      upperHex,
    ]);
    expect(args.mode).toBe("verify-content-artifact");
    expect(args.expectedProducerKey).toBe("f".repeat(64));
  });

  it("does NOT trigger content-artifact mode when 'content-artifact' is not the FIRST positional", () => {
    // The credential-verification flow takes <file> as the single positional;
    // a path literally named "content-artifact" would be unusual, but the
    // subcommand keyword still wins only at position 0. Sanity check.
    const args = parseArgs(["some-credential.json"]);
    expect(args.mode).toBe("verify");
    expect(args.file).toBe("some-credential.json");
  });
});

describe("decodeManifestInput", () => {
  it("decodes a base64url-encoded canonical-JSON manifest (header form)", async () => {
    const producer = await generateKeypair();
    const content = new TextEncoder().encode('{"motebit_id":"x","entries":[]}');
    const manifest = await signContentArtifact(content, {
      artifactType: "audit-trail",
      producer: `did:key:z${bytesToHex(producer.publicKey).slice(0, 16)}`,
      producerPublicKey: producer.publicKey,
      producerPrivateKey: producer.privateKey,
      claimGenerator: "motebit-relay/0.5.2-test",
    });
    const headerValue = manifestToHeader(manifest);
    const decoded = decodeManifestInput(headerValue);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.manifest.artifact_type).toBe("audit-trail");
      expect(decoded.manifest.signature).toBe(manifest.signature);
    }
  });

  it("decodes a manifest passed as a filesystem path to a JSON file", async () => {
    const producer = await generateKeypair();
    const content = new TextEncoder().encode("file-form fixture");
    const manifest = await signContentArtifact(content, {
      artifactType: "memory-export",
      producer: `did:key:z${bytesToHex(producer.publicKey).slice(0, 16)}`,
      producerPublicKey: producer.publicKey,
      producerPrivateKey: producer.privateKey,
      claimGenerator: "motebit-relay/0.5.2-test",
    });
    const tmp = mkdtempSync(join(tmpdir(), "motebit-verify-cli-"));
    try {
      const manifestPath = join(tmp, "manifest.json");
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const decoded = decodeManifestInput(manifestPath);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.manifest.artifact_type).toBe("memory-export");
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects empty and clearly invalid input", () => {
    const empty = decodeManifestInput("");
    expect(empty.ok).toBe(false);

    const garbage = decodeManifestInput("not-a-manifest-not-a-path");
    expect(garbage.ok).toBe(false);
  });
});

describe("describeContentArtifactReason — typed-failure-to-prose map", () => {
  it("returns specific phrasing for every known reason", () => {
    for (const reason of [
      "content_hash_mismatch",
      "signature_invalid",
      "malformed_public_key",
      "malformed_signature",
      "unsupported_suite",
      "producer_key_mismatch",
      "artifact_type_mismatch",
    ]) {
      const phrase = describeContentArtifactReason(reason);
      expect(phrase).not.toBe(reason);
      expect(phrase.length).toBeGreaterThan(0);
    }
  });

  it("falls back to the raw reason for unknown values", () => {
    expect(describeContentArtifactReason("brand_new_reason")).toBe("brand_new_reason");
  });
});

// --- End-to-end subprocess test (one round-trip + one tamper) ---------------

describe("motebit-verify content-artifact — subprocess end-to-end", () => {
  let tmp: string;
  let bodyPath: string;
  let manifestB64: string;
  let tamperedBodyPath: string;
  let producerKeyHex: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "motebit-verify-cli-e2e-"));
    const producer = await generateKeypair();
    producerKeyHex = bytesToHex(producer.publicKey);
    const bodyText = '{"motebit_id":"end-to-end","entries":[]}';
    const bodyBytes = new TextEncoder().encode(bodyText);
    bodyPath = join(tmp, "body.json");
    writeFileSync(bodyPath, bodyBytes);

    const manifest = await signContentArtifact(bodyBytes, {
      artifactType: "audit-trail",
      producer: `did:key:z${producerKeyHex.slice(0, 16)}`,
      producerPublicKey: producer.publicKey,
      producerPrivateKey: producer.privateKey,
      claimGenerator: "motebit-relay/0.5.2-e2e",
    });
    manifestB64 = manifestToHeader(manifest);

    tamperedBodyPath = join(tmp, "body-tampered.json");
    const tampered = new Uint8Array(bodyBytes);
    tampered[0] = tampered[0]! ^ 0x01;
    writeFileSync(tamperedBodyPath, tampered);
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
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  it("exits 0 and prints VERIFIED on a valid round-trip", () => {
    const res = runCli(["content-artifact", bodyPath, "--manifest", manifestB64]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toMatch(/✓ content-artifact VERIFIED/);
    expect(res.stdout).toMatch(/artifact_type\s+audit-trail/);
  });

  it("exits 1 with content_hash_mismatch when the body is tampered", () => {
    const res = runCli(["content-artifact", tamperedBodyPath, "--manifest", manifestB64]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/content_hash_mismatch|body bytes do not match/);
  });

  it("exits 1 with producer_key_mismatch when --producer-key disagrees with the manifest", () => {
    const wrongKey = "0".repeat(64);
    const res = runCli([
      "content-artifact",
      bodyPath,
      "--manifest",
      manifestB64,
      "--producer-key",
      wrongKey,
    ]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/producer_key_mismatch|does not match the value pinned/);
  });

  it("exits 0 when --producer-key matches the manifest's declared key", () => {
    const res = runCli([
      "content-artifact",
      bodyPath,
      "--manifest",
      manifestB64,
      "--producer-key",
      producerKeyHex,
    ]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
  });

  it("exits 1 with artifact_type_mismatch when --expect disagrees", () => {
    const res = runCli([
      "content-artifact",
      bodyPath,
      "--manifest",
      manifestB64,
      "--expect",
      "memory-export",
    ]);
    expect(res.status).toBe(1);
    expect(res.stdout).toMatch(/artifact_type_mismatch|does not match the value required/);
  });

  it("emits structured JSON when --json is set", () => {
    const res = runCli(["content-artifact", bodyPath, "--manifest", manifestB64, "--json"]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    const parsed = JSON.parse(res.stdout) as {
      valid: boolean;
      manifest: { artifact_type: string };
    };
    expect(parsed.valid).toBe(true);
    expect(parsed.manifest.artifact_type).toBe("audit-trail");
  });
});

// --- v1.1 recursive inner-receipt verification (subprocess) -----------------

describe("motebit-verify content-artifact — v1.1 inner-receipt recursion", () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), "motebit-verify-inner-e2e-"));
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
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  it("recursively verifies a v1.1 execution-ledger with inner signed receipts", async () => {
    const { signExecutionReceipt } = await import("@motebit/crypto");

    // Inner delegate's keypair — signs an ExecutionReceipt directly.
    const delegateKp = await generateKeypair();
    const innerReceipt = await signExecutionReceipt(
      {
        task_id: "inner-task-1",
        motebit_id: "delegate-mote-cli",
        device_id: "delegate-device",
        submitted_at: 1000,
        completed_at: 2000,
        status: "completed",
        result: "ok",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: "0".repeat(64),
        result_hash: "1".repeat(64),
        public_key: bytesToHex(delegateKp.publicKey),
      } as unknown as Parameters<typeof signExecutionReceipt>[0],
      delegateKp.privateKey,
    );

    // Relay's keypair — signs the outer ContentArtifactManifest over
    // the JSON body containing signed_receipts.
    const relayKp = await generateKeypair();
    const body = {
      spec: "motebit/execution-ledger@1.1",
      motebit_id: "owner-mote-cli",
      goal_id: "goal-1",
      plan_id: "plan-1",
      started_at: 0,
      completed_at: 3000,
      status: "completed",
      timeline: [],
      steps: [],
      delegation_receipts: [],
      content_hash: "0".repeat(64),
      signed_receipts: [JSON.stringify(innerReceipt)],
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
    const bodyPath = join(tmp, "v1_1-body.json");
    writeFileSync(bodyPath, bodyBytes);

    const manifest = await signContentArtifact(bodyBytes, {
      artifactType: "execution-ledger",
      producer: `did:key:z${bytesToHex(relayKp.publicKey).slice(0, 16)}`,
      producerPublicKey: relayKp.publicKey,
      producerPrivateKey: relayKp.privateKey,
      claimGenerator: "motebit-relay/0.5.2-e2e",
    });
    const manifestB64 = manifestToHeader(manifest);

    const res = runCli(["content-artifact", bodyPath, "--manifest", manifestB64]);
    expect(res.status, `stderr: ${res.stderr}\nstdout: ${res.stdout}`).toBe(0);
    expect(res.stdout).toMatch(/✓ content-artifact VERIFIED/);
    expect(res.stdout).toMatch(/✓ inner receipts 1\/1 VERIFIED/);
    expect(res.stdout).toContain("inner-task-1");
    expect(res.stdout).toContain("delegate-mote-cli");
  });

  it("exits 1 when an inner receipt is tampered (outer still valid)", async () => {
    const { signExecutionReceipt } = await import("@motebit/crypto");
    const delegateKp = await generateKeypair();
    const innerReceipt = await signExecutionReceipt(
      {
        task_id: "inner-tampered",
        motebit_id: "delegate-mote-cli-2",
        device_id: "delegate-device",
        submitted_at: 1000,
        completed_at: 2000,
        status: "completed",
        result: "original-result",
        tools_used: ["web_search"],
        memories_formed: 0,
        prompt_hash: "0".repeat(64),
        result_hash: "1".repeat(64),
        public_key: bytesToHex(delegateKp.publicKey),
      } as unknown as Parameters<typeof signExecutionReceipt>[0],
      delegateKp.privateKey,
    );

    // Tamper the inner receipt's `result` AFTER signing — the receipt's
    // signature was computed over the original. The outer manifest
    // covers the body bytes INCLUDING the tampered inner receipt, so
    // it stays valid; only inner verification catches the lie.
    const tamperedInner = { ...innerReceipt, result: "tampered-result" };

    const relayKp = await generateKeypair();
    const body = {
      spec: "motebit/execution-ledger@1.1",
      motebit_id: "owner-mote-cli",
      goal_id: "goal-tampered",
      plan_id: "plan-1",
      started_at: 0,
      completed_at: 3000,
      status: "completed",
      timeline: [],
      steps: [],
      delegation_receipts: [],
      content_hash: "0".repeat(64),
      signed_receipts: [JSON.stringify(tamperedInner)],
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
    const bodyPath = join(tmp, "v1_1-body-tampered.json");
    writeFileSync(bodyPath, bodyBytes);

    const manifest = await signContentArtifact(bodyBytes, {
      artifactType: "execution-ledger",
      producer: `did:key:z${bytesToHex(relayKp.publicKey).slice(0, 16)}`,
      producerPublicKey: relayKp.publicKey,
      producerPrivateKey: relayKp.privateKey,
      claimGenerator: "motebit-relay/0.5.2-e2e",
    });
    const manifestB64 = manifestToHeader(manifest);

    const res = runCli(["content-artifact", bodyPath, "--manifest", manifestB64]);
    expect(res.status).toBe(1);
    // Outer manifest STILL VERIFIED — the relay signed the bytes-as-
    // delivered. Inner failure is what fails the overall verification.
    expect(res.stdout).toMatch(/✓ content-artifact VERIFIED/);
    expect(res.stdout).toMatch(/✗ inner receipts 0\/1 VERIFIED/);
    expect(res.stdout).toMatch(/signature_invalid/);
  });

  it("stays silent on inner receipts when the body is v1.0 (no field)", async () => {
    const relayKp = await generateKeypair();
    const body = {
      spec: "motebit/execution-ledger@1.0",
      motebit_id: "owner-mote-cli",
      goal_id: "goal-v1-0",
      plan_id: "plan-1",
      started_at: 0,
      completed_at: 3000,
      status: "completed",
      timeline: [],
      steps: [],
      delegation_receipts: [],
      content_hash: "0".repeat(64),
    };
    const bodyBytes = new TextEncoder().encode(JSON.stringify(body));
    const bodyPath = join(tmp, "v1_0-body.json");
    writeFileSync(bodyPath, bodyBytes);

    const manifest = await signContentArtifact(bodyBytes, {
      artifactType: "execution-ledger",
      producer: `did:key:z${bytesToHex(relayKp.publicKey).slice(0, 16)}`,
      producerPublicKey: relayKp.publicKey,
      producerPrivateKey: relayKp.privateKey,
      claimGenerator: "motebit-relay/0.5.2-e2e",
    });

    const res = runCli(["content-artifact", bodyPath, "--manifest", manifestToHeader(manifest)]);
    expect(res.status, `stderr: ${res.stderr}`).toBe(0);
    expect(res.stdout).toMatch(/✓ content-artifact VERIFIED/);
    // No "inner receipts" line on v1.0 bodies — calm software: silent
    // on the verified path when the field doesn't apply.
    expect(res.stdout).not.toMatch(/inner receipts/);
  });
});
