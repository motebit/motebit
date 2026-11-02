/**
 * `motebit-verify` command bodies, driven IN-PROCESS through the real `main()`.
 *
 * The coverage-graduation lever (coverage-graduation.json, `@motebit/verify`):
 * the subprocess suites prove the binary end-to-end, but v8 in the test process
 * cannot see a child process, so the command bodies — `main()`,
 * `verifyContentArtifactCli`, `verifyApprovalDecisionCli` — measured as
 * uncovered. `runMain` (./helpers/run-main.ts) reproduces the entry-point
 * condition in-process instead of adding a seam to `cli.ts`: the same parser,
 * the same command bodies, the same `@motebit/verifier` / `@motebit/crypto`
 * calls run, and the test asserts the CLI's actual contract — exit code
 * (0 verified / 1 invalid-but-detected / 2 usage-or-I/O, CLAUDE.md Rule 5),
 * the stream each message lands on, and the named reason it gives.
 *
 * Fixtures are minted here with the real signers (`signExecutionReceipt`,
 * `signContentArtifact`, `signApprovalDecision`) plus the package's own
 * committed `examples/sample-receipt.json`; every "invalid" case is a real
 * forgery or a real policy mismatch, never a mocked verdict.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  bytesToHex,
  generateKeypair,
  signApprovalDecision,
  signContentArtifact,
  signExecutionReceipt,
} from "@motebit/crypto";

import { LENIENT_WARNING } from "../cli.js";
import { runMain } from "./helpers/run-main.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLE_RECEIPT = resolve(HERE, "..", "..", "examples", "sample-receipt.json");
const PKG_VERSION = (
  JSON.parse(readFileSync(resolve(HERE, "..", "..", "package.json"), "utf-8")) as {
    version: string;
  }
).version;

const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const toHeader = (manifest: object): string =>
  Buffer.from(JSON.stringify(manifest), "utf-8").toString("base64url");

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "motebit-verify-inproc-"));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function write(name: string, data: string | Uint8Array): string {
  const p = join(tmp, name);
  writeFileSync(p, data);
  return p;
}

// ---------------------------------------------------------------------------
// main(): help / version / usage
// ---------------------------------------------------------------------------

describe("main — help, version, usage errors", () => {
  it("--version prints the package version on stdout and exits 0", async () => {
    const r = await runMain(["--version"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(`${PKG_VERSION}\n`);
    expect(r.stderr).toBe("");
  });

  it("--help prints the usage text on stdout and exits 0", async () => {
    const r = await runMain(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("USAGE");
    expect(r.stdout).toContain("motebit-verify content-artifact <body-file>");
    expect(r.stdout).toContain("EXIT CODES");
    expect(r.stderr).toBe("");
  });

  it("a usage error goes to stderr with the reason and the help, exit 2, nothing on stdout", async () => {
    const r = await runMain(["--no-such-flag", "x.json"]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^motebit-verify: unknown flag: --no-such-flag\n\n/);
    expect(r.stderr).toContain("USAGE");
  });

  it("no arguments at all is a usage error (exit 2), never a silent success", async () => {
    const r = await runMain([]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/missing file argument/);
  });

  it("content-artifact --help prints help (exit 0) instead of verifying", async () => {
    const r = await runMain(["content-artifact", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("CONTENT-ARTIFACT MODE");
  });

  it("approval-decision --help prints help (exit 0) instead of verifying", async () => {
    const r = await runMain(["approval-decision", "--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("APPROVAL-DECISION MODE");
  });

  it("a subcommand usage error is exit 2 on stderr", async () => {
    const r = await runMain(["content-artifact", "body.json"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/content-artifact: --manifest is required/);
  });
});

// ---------------------------------------------------------------------------
// main(): default verify mode
// ---------------------------------------------------------------------------

describe("main — verify mode", () => {
  let goodReceipt: string;
  let unboundReceipt: string;
  let forgedReceipt: string;
  let throwingReceipt: string;
  let unknownArtifact: string;
  let aaidFile: string;

  beforeAll(async () => {
    const kp = await generateKeypair();
    const body = (result: string, resultHash: string) =>
      ({
        task_id: "inproc-task",
        motebit_id: "inproc-mote",
        device_id: "inproc-device",
        submitted_at: 1_000,
        completed_at: 2_000,
        status: "completed",
        result,
        tools_used: [],
        memories_formed: 0,
        prompt_hash: "a".repeat(64),
        result_hash: resultHash,
        public_key: bytesToHex(kp.publicKey),
      }) as unknown as Parameters<typeof signExecutionReceipt>[0];

    const good = await signExecutionReceipt(body("ok", sha256Hex("ok")), kp.privateKey);
    goodReceipt = write("good-receipt.json", JSON.stringify(good));

    // Signed correctly, but result_hash does not bind result.
    const unbound = await signExecutionReceipt(body("ok", "0".repeat(64)), kp.privateKey);
    unboundReceipt = write("unbound-receipt.json", JSON.stringify(unbound));

    // Signed, then the result is altered: the signature no longer covers it.
    forgedReceipt = write("forged-receipt.json", JSON.stringify({ ...good, result: "forged" }));

    // A receipt whose delegation chain holds a null entry: the signature-only
    // (--lenient) verifier throws on it rather than returning a verdict.
    const withNull = await signExecutionReceipt(
      {
        ...(body("ok", sha256Hex("ok")) as object),
        delegation_receipts: [null],
      } as unknown as Parameters<typeof signExecutionReceipt>[0],
      kp.privateKey,
    );
    throwingReceipt = write("null-delegation-receipt.json", JSON.stringify(withNull));

    unknownArtifact = write("unknown.json", JSON.stringify({ foo: "bar" }));
    aaidFile = write("aaid.bin", new Uint8Array([0x30, 0x03, 0x02, 0x01, 0x01]));
  });

  it("`example` verifies the bundled sample receipt (exit 0)", async () => {
    const r = await runMain(["example"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^VALID \(receipt\)/);
    expect(r.stderr).toBe("");
  });

  it("`example --json` emits the structured verdict for the bundled sample", async () => {
    const r = await runMain(["example", "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      type: string;
      valid: boolean;
      receipt?: { task_id?: string };
    };
    expect(parsed.type).toBe("receipt");
    expect(parsed.valid).toBe(true);
    // It is the committed sample that was verified, not some other file.
    const sample = JSON.parse(readFileSync(SAMPLE_RECEIPT, "utf-8")) as { task_id: string };
    expect(parsed.receipt?.task_id).toBe(sample.task_id);
  });

  it("verifies a freshly signed receipt (exit 0) with --expect receipt and --clock-skew", async () => {
    const r = await runMain([goodReceipt, "--expect", "receipt", "--clock-skew", "30"]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^VALID \(receipt\)/);
  });

  it("--expect of the wrong type fails a valid receipt (exit 1)", async () => {
    const r = await runMain([goodReceipt, "--expect", "credential", "--json"]);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout) as { valid: boolean };
    expect(parsed.valid).toBe(false);
  });

  it("a forged receipt is INVALID (exit 1)", async () => {
    const r = await runMain([forgedReceipt]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^INVALID \(receipt\)/);
  });

  it("strict by default: an unbound result_hash is INVALID (exit 1), no lenient warning", async () => {
    const r = await runMain([unboundReceipt]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain(LENIENT_WARNING);
  });

  it("--lenient accepts the unbound receipt (exit 0) and warns on stderr", async () => {
    const r = await runMain([unboundReceipt, "--lenient"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe(`${LENIENT_WARNING}\n`);
  });

  it("--lenient on a non-receipt prints no receipt warning", async () => {
    const r = await runMain([unknownArtifact, "--lenient"]);
    expect(r.stderr).toBe("");
  });

  it("an unrecognized artifact exits 2, not 1", async () => {
    const r = await runMain([unknownArtifact]);
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/UNRECOGNIZED/);
  });

  it("a missing file is an I/O error: exit 2, `cannot read` on stderr", async () => {
    const missing = join(tmp, "does-not-exist.json");
    const r = await runMain([missing]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(new RegExp(`^motebit-verify: cannot read ${missing}: `));
    expect(r.stdout).toBe("");
  });

  it("a verifier throw on content it read is INVALID (exit 1), not an I/O error", async () => {
    const r = await runMain([throwingReceipt, "--lenient"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/^motebit-verify: invalid: the verifier threw: /);
    expect(r.stdout).toBe("");
  });

  it("an unreadable --android-attestation-application-id is exit 2 before any verification", async () => {
    const missing = join(tmp, "no-aaid.bin");
    const r = await runMain([goodReceipt, "--android-attestation-application-id", missing]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/cannot read --android-attestation-application-id at /);
    expect(r.stdout).toBe("");
  });

  it("platform overrides (--bundle-id, --rp-id, --android-attestation-application-id) leave the software path intact", async () => {
    const r = await runMain([
      goodReceipt,
      "--bundle-id",
      "com.example.app",
      "--rp-id",
      "example.com",
      "--android-attestation-application-id",
      aaidFile,
      "--json",
    ]);
    expect(r.code, r.stderr).toBe(0);
    expect((JSON.parse(r.stdout) as { valid: boolean }).valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// content-artifact subcommand
// ---------------------------------------------------------------------------

describe("main — content-artifact", () => {
  let producerHex: string;
  let bodyPath: string;
  let tamperedBodyPath: string;
  let manifestB64: string;
  let manifestFile: string;
  let invocationManifestB64: string;
  let relay: Awaited<ReturnType<typeof generateKeypair>>;

  const signManifest = async (
    bytes: Uint8Array,
    artifactType: Parameters<typeof signContentArtifact>[1]["artifactType"],
    extra?: Partial<Parameters<typeof signContentArtifact>[1]>,
  ) =>
    signContentArtifact(bytes, {
      artifactType,
      producer: `did:key:z${producerHex.slice(0, 16)}`,
      producerPublicKey: relay.publicKey,
      producerPrivateKey: relay.privateKey,
      claimGenerator: "motebit-relay/inproc-test",
      ...extra,
    });

  const innerReceipt = async (taskId: string) => {
    const kp = await generateKeypair();
    return signExecutionReceipt(
      {
        task_id: taskId,
        motebit_id: `delegate-${taskId}`,
        device_id: "delegate-device",
        submitted_at: 1_000,
        completed_at: 2_000,
        status: "completed",
        result: "inner-result",
        tools_used: [],
        memories_formed: 0,
        prompt_hash: "0".repeat(64),
        result_hash: sha256Hex("inner-result"),
        public_key: bytesToHex(kp.publicKey),
      } as unknown as Parameters<typeof signExecutionReceipt>[0],
      kp.privateKey,
    );
  };

  const ledgerBody = (signedReceipts?: string[]) => ({
    spec: signedReceipts ? "motebit/execution-ledger@1.1" : "motebit/execution-ledger@1.0",
    motebit_id: "owner-mote",
    goal_id: "goal-1",
    plan_id: "plan-1",
    started_at: 0,
    completed_at: 3_000,
    status: "completed",
    timeline: [],
    steps: [],
    delegation_receipts: [],
    content_hash: "0".repeat(64),
    ...(signedReceipts && { signed_receipts: signedReceipts }),
  });

  beforeAll(async () => {
    relay = await generateKeypair();
    producerHex = bytesToHex(relay.publicKey);
    const bytes = new TextEncoder().encode('{"motebit_id":"inproc","entries":[]}');
    bodyPath = write("ca-body.json", bytes);
    const tampered = new Uint8Array(bytes);
    tampered[0] = tampered[0]! ^ 0x01;
    tamperedBodyPath = write("ca-body-tampered.json", tampered);
    const manifest = await signManifest(bytes, "audit-trail");
    manifestB64 = toHeader(manifest);
    manifestFile = write("ca-manifest.json", JSON.stringify(manifest));
    invocationManifestB64 = toHeader(
      await signManifest(bytes, "audit-trail", {
        invocation: { task_id: "task-xyz", receipt_id: "rcpt-xyz" },
      }),
    );
  });

  it("verifies a header-form manifest (exit 0), human output", async () => {
    const r = await runMain(["content-artifact", bodyPath, "--manifest", manifestB64]);
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^✓ content-artifact VERIFIED/);
    expect(r.stdout).toContain(`producer_key     ${producerHex}`);
    expect(r.stdout).toContain("artifact_type    audit-trail");
    expect(r.stdout).not.toMatch(/inner receipts/);
  });

  it("verifies a file-form manifest with a matching (upper-case) --producer-key and --expect", async () => {
    const r = await runMain([
      "content-artifact",
      bodyPath,
      "--manifest",
      manifestFile,
      "--producer-key",
      producerHex.toUpperCase(),
      "--expect",
      "audit-trail",
    ]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
  });

  it("--json on a valid manifest carries the manifest fields and the invocation cross-reference", async () => {
    const r = await runMain([
      "content-artifact",
      bodyPath,
      "--manifest",
      invocationManifestB64,
      "--json",
    ]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      valid: boolean;
      reason?: string;
      manifest: { producer_public_key: string; invocation?: { task_id?: string } };
      inner_receipts?: unknown;
    };
    expect(parsed.valid).toBe(true);
    expect(parsed.reason).toBeUndefined();
    expect(parsed.manifest.producer_public_key).toBe(producerHex);
    expect(parsed.manifest.invocation?.task_id).toBe("task-xyz");
    expect(parsed.inner_receipts).toBeUndefined();
  });

  it("--json without an invocation omits the field", async () => {
    const r = await runMain(["content-artifact", bodyPath, "--manifest", manifestB64, "--json"]);
    const parsed = JSON.parse(r.stdout) as { manifest: Record<string, unknown> };
    expect("invocation" in parsed.manifest).toBe(false);
  });

  it("tampered body bytes: content_hash_mismatch, exit 1 (human)", async () => {
    const r = await runMain(["content-artifact", tamperedBodyPath, "--manifest", manifestB64]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^✗ content-artifact INVALID — body bytes do not match/);
  });

  it("tampered body bytes: --json carries reason content_hash_mismatch", async () => {
    const r = await runMain([
      "content-artifact",
      tamperedBodyPath,
      "--manifest",
      manifestB64,
      "--json",
    ]);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout) as { valid: boolean; reason: string };
    expect(parsed).toMatchObject({ valid: false, reason: "content_hash_mismatch" });
  });

  it("pinned --producer-key that differs: producer_key_mismatch, exit 1 (human)", async () => {
    const r = await runMain([
      "content-artifact",
      bodyPath,
      "--manifest",
      manifestB64,
      "--producer-key",
      "b".repeat(64),
    ]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/does not match the value pinned via --producer-key/);
  });

  it("pinned --producer-key that differs: --json names both keys", async () => {
    const r = await runMain([
      "content-artifact",
      bodyPath,
      "--manifest",
      manifestB64,
      "--producer-key",
      "b".repeat(64),
      "--json",
    ]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      valid: false,
      reason: "producer_key_mismatch",
      expected_producer_public_key: "b".repeat(64),
      actual_producer_public_key: producerHex,
    });
  });

  it("--expect of a different artifact type: artifact_type_mismatch, exit 1 (human)", async () => {
    const r = await runMain([
      "content-artifact",
      bodyPath,
      "--manifest",
      manifestB64,
      "--expect",
      "memory-export",
    ]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/artifact_type does not match the value required via --expect/);
  });

  it("--expect of a different artifact type: --json names both types", async () => {
    const r = await runMain([
      "content-artifact",
      bodyPath,
      "--manifest",
      manifestB64,
      "--expect",
      "memory-export",
      "--json",
    ]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      valid: false,
      reason: "artifact_type_mismatch",
      expected_artifact_type: "memory-export",
      actual_artifact_type: "audit-trail",
    });
  });

  it("an unreadable body file is exit 2 (I/O), never a verdict", async () => {
    const r = await runMain([
      "content-artifact",
      join(tmp, "no-body.json"),
      "--manifest",
      manifestB64,
    ]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^motebit-verify: cannot read body-file /);
    expect(r.stdout).toBe("");
  });

  it("an undecodable --manifest is exit 2 with the decoder's reason", async () => {
    const r = await runMain(["content-artifact", bodyPath, "--manifest", "!!!not-a-manifest!!!"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^motebit-verify: --manifest is /);
    expect(r.stdout).toBe("");
  });

  it("a manifest with no producer_public_key under --producer-key fails closed (exit 2, nothing on stdout)", async () => {
    // Malformed manifest: the CLI's pre-crypto pin reads producer_public_key
    // and throws. The entry point's top-level catch turns it into exit 2 — it
    // must never fall through to a verdict, and above all never exit 0.
    const r = await runMain([
      "content-artifact",
      bodyPath,
      "--manifest",
      toHeader({ artifact_type: "audit-trail" }),
      "--producer-key",
      producerHex,
    ]);
    expect(r.code).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^motebit-verify: /);
  });

  it("v1.1 execution-ledger: inner receipts are verified and listed (exit 0)", async () => {
    const inner = await innerReceipt("inner-ok");
    const bytes = new TextEncoder().encode(JSON.stringify(ledgerBody([JSON.stringify(inner)])));
    const p = write("ledger-v11.json", bytes);
    const m = toHeader(await signManifest(bytes, "execution-ledger"));
    const r = await runMain(["content-artifact", p, "--manifest", m]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/✓ inner receipts 1\/1 VERIFIED/);
    expect(r.stdout).toMatch(/ {2}✓ inner-ok {2}motebit=delegate-inner-ok/);
  });

  it("v1.1 execution-ledger --json carries inner_receipts", async () => {
    const inner = await innerReceipt("inner-json");
    const bytes = new TextEncoder().encode(JSON.stringify(ledgerBody([JSON.stringify(inner)])));
    const p = write("ledger-v11-json.json", bytes);
    const m = toHeader(await signManifest(bytes, "execution-ledger"));
    const r = await runMain(["content-artifact", p, "--manifest", m, "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as {
      valid: boolean;
      inner_receipts: { allValid: boolean; totalCount: number };
    };
    expect(parsed.valid).toBe(true);
    expect(parsed.inner_receipts).toMatchObject({ allValid: true, totalCount: 1 });
  });

  it("v1.1 execution-ledger with a forged inner receipt: outer valid, overall exit 1", async () => {
    const inner = await innerReceipt("inner-bad");
    const forged = { ...inner, result: "forged" };
    const bytes = new TextEncoder().encode(JSON.stringify(ledgerBody([JSON.stringify(forged)])));
    const p = write("ledger-v11-forged.json", bytes);
    const m = toHeader(await signManifest(bytes, "execution-ledger"));
    const human = await runMain(["content-artifact", p, "--manifest", m]);
    expect(human.code).toBe(1);
    expect(human.stdout).toMatch(/^✓ content-artifact VERIFIED/);
    expect(human.stdout).toMatch(/✗ inner receipts 0\/1 VERIFIED/);
    expect(human.stdout).toMatch(
      / {2}✗ inner-bad {2}motebit=delegate-inner-bad {2}reason=signature_invalid {2}detail=\S/,
    );

    const json = await runMain(["content-artifact", p, "--manifest", m, "--json"]);
    expect(json.code).toBe(1);
    const parsed = JSON.parse(json.stdout) as {
      valid: boolean;
      inner_receipts: { allValid: boolean };
    };
    expect(parsed.valid).toBe(false);
    expect(parsed.inner_receipts.allValid).toBe(false);
  });

  it("v1.1 execution-ledger with an unparseable inner entry: listed as malformed_json, exit 1", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(ledgerBody(["{not a receipt"])));
    const p = write("ledger-v11-unparseable.json", bytes);
    const m = toHeader(await signManifest(bytes, "execution-ledger"));
    const r = await runMain(["content-artifact", p, "--manifest", m]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(
      / {2}✗ <unparseable> {2}motebit=<unparseable> {2}reason=malformed_json {2}detail=\S/,
    );
  });

  it("v1.0 execution-ledger (no signed_receipts) stays silent on inner receipts", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify(ledgerBody()));
    const p = write("ledger-v10.json", bytes);
    const m = toHeader(await signManifest(bytes, "execution-ledger"));
    const r = await runMain(["content-artifact", p, "--manifest", m]);
    expect(r.code).toBe(0);
    expect(r.stdout).not.toMatch(/inner receipts/);
  });

  it("an execution-ledger whose body is not JSON: outer verdict stands, inner audit skipped", async () => {
    const bytes = new TextEncoder().encode("not json at all");
    const p = write("ledger-not-json.txt", bytes);
    const m = toHeader(await signManifest(bytes, "execution-ledger"));
    const r = await runMain(["content-artifact", p, "--manifest", m]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^✓ content-artifact VERIFIED/);
    expect(r.stdout).not.toMatch(/inner receipts/);
  });

  it("an INVALID execution-ledger manifest never audits the inner receipts", async () => {
    const inner = await innerReceipt("inner-skip");
    const bytes = new TextEncoder().encode(JSON.stringify(ledgerBody([JSON.stringify(inner)])));
    const m = toHeader(await signManifest(bytes, "execution-ledger"));
    const tampered = new Uint8Array(bytes);
    tampered[tampered.length - 2] = tampered[tampered.length - 2]! ^ 0x01;
    const p = write("ledger-v11-outer-tampered.json", tampered);
    const r = await runMain(["content-artifact", p, "--manifest", m, "--json"]);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout) as { valid: boolean; inner_receipts?: unknown };
    expect(parsed.valid).toBe(false);
    expect(parsed.inner_receipts).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// approval-decision subcommand
// ---------------------------------------------------------------------------

describe("main — approval-decision", () => {
  let approverHex: string;
  let approvedPath: string;
  let deniedPath: string;
  let noKeyPath: string;
  let tamperedPath: string;
  let runIdPath: string;

  const decisionBody = (verdict: "approved" | "denied") => ({
    approval_id: "inproc-approval",
    motebit_id: "motebit-executor",
    device_id: "device-approver",
    tool_name: "send_money",
    args_hash: "a".repeat(64),
    risk_level: 4,
    verdict,
    requested_at: 1_000,
    resolved_at: 2_000,
  });

  beforeAll(async () => {
    const approver = await generateKeypair();
    approverHex = bytesToHex(approver.publicKey);
    const approved = await signApprovalDecision(
      decisionBody("approved"),
      approver.privateKey,
      approver.publicKey,
    );
    approvedPath = write("ad-approved.json", JSON.stringify(approved));
    const denied = await signApprovalDecision(
      { ...decisionBody("denied"), denied_reason: "User denied this tool call." },
      approver.privateKey,
      approver.publicKey,
    );
    deniedPath = write("ad-denied.json", JSON.stringify(denied));
    const noKey = await signApprovalDecision(decisionBody("approved"), approver.privateKey);
    noKeyPath = write("ad-no-key.json", JSON.stringify(noKey));
    tamperedPath = write("ad-tampered.json", JSON.stringify({ ...approved, tool_name: "rm_rf" }));
    const withRun = await signApprovalDecision(
      { ...decisionBody("approved"), run_id: "run-42" },
      approver.privateKey,
      approver.publicKey,
    );
    runIdPath = write("ad-run-id.json", JSON.stringify(withRun));
  });

  it("verifies an approved decision (exit 0), human output", async () => {
    const r = await runMain(["approval-decision", approvedPath]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^✓ approval-decision VERIFIED/);
    expect(r.stdout).toContain("verdict          APPROVED");
    expect(r.stdout).toContain(`approver_key     ${approverHex}`);
    expect(r.stdout).not.toContain("denied_reason");
  });

  it("a denied decision prints its denied_reason and verifies (exit 0)", async () => {
    const r = await runMain(["approval-decision", deniedPath, "--expect-verdict", "denied"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("verdict          DENIED");
    expect(r.stdout).toContain("denied_reason    User denied this tool call.");
  });

  it("--json on a denied decision carries denied_reason; run_id is omitted when absent", async () => {
    const r = await runMain(["approval-decision", deniedPath, "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { valid: boolean; decision: Record<string, unknown> };
    expect(parsed.valid).toBe(true);
    expect(parsed.decision.verdict).toBe("denied");
    expect(parsed.decision.denied_reason).toBe("User denied this tool call.");
    expect("run_id" in parsed.decision).toBe(false);
    expect(parsed.decision.public_key).toBe(approverHex);
  });

  it("--json carries run_id when present and omits denied_reason when absent", async () => {
    const r = await runMain(["approval-decision", runIdPath, "--json"]);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout) as { decision: Record<string, unknown> };
    expect(parsed.decision.run_id).toBe("run-42");
    expect("denied_reason" in parsed.decision).toBe(false);
  });

  it("a matching (upper-case) --producer-key pin verifies", async () => {
    const r = await runMain([
      "approval-decision",
      approvedPath,
      "--producer-key",
      approverHex.toUpperCase(),
    ]);
    expect(r.code).toBe(0);
  });

  it("a decision with no embedded key verifies against --producer-key and prints that key", async () => {
    const r = await runMain(["approval-decision", noKeyPath, "--producer-key", approverHex]);
    expect(r.code, r.stdout).toBe(0);
    expect(r.stdout).toContain(`approver_key     ${approverHex}`);
  });

  it("no embedded key and no --producer-key: no_verifying_key, exit 1", async () => {
    const r = await runMain(["approval-decision", noKeyPath, "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({ valid: false, reason: "no_verifying_key" });
  });

  it("a different pinned key: producer_key_mismatch names both keys, exit 1", async () => {
    const r = await runMain([
      "approval-decision",
      approvedPath,
      "--producer-key",
      "c".repeat(64),
      "--json",
    ]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      valid: false,
      reason: "producer_key_mismatch",
      expected_public_key: "c".repeat(64),
      actual_public_key: approverHex,
    });
  });

  it("--expect-verdict on the other value: verdict_mismatch, exit 1 (human)", async () => {
    const r = await runMain(["approval-decision", approvedPath, "--expect-verdict", "denied"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(
      /^✗ approval-decision INVALID — the decision's verdict does not match the value required via --expect-verdict/,
    );
  });

  it("--expect-verdict mismatch --json names both verdicts", async () => {
    const r = await runMain([
      "approval-decision",
      approvedPath,
      "--expect-verdict",
      "denied",
      "--json",
    ]);
    expect(JSON.parse(r.stdout)).toEqual({
      valid: false,
      reason: "verdict_mismatch",
      expected_verdict: "denied",
      actual_verdict: "approved",
    });
  });

  it("a tampered decision: signature_invalid, exit 1", async () => {
    const r = await runMain(["approval-decision", tamperedPath]);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^✗ approval-decision INVALID — signature does not verify/);
  });

  it("a decision signed by a different key than the pinned one is rejected (exit 1)", async () => {
    const other = await generateKeypair();
    const r = await runMain([
      "approval-decision",
      noKeyPath,
      "--producer-key",
      bytesToHex(other.publicKey),
      "--json",
    ]);
    expect(r.code).toBe(1);
    expect((JSON.parse(r.stdout) as { reason: string }).reason).toBe("signature_invalid");
  });

  it("malformed decisions (no verdict, null, a scalar) are malformed_decision, exit 1", async () => {
    for (const [name, content] of [
      ["ad-no-verdict.json", JSON.stringify({ approval_id: "x" })],
      ["ad-null.json", "null"],
      ["ad-scalar.json", "42"],
    ] as const) {
      const r = await runMain(["approval-decision", write(name, content), "--json"]);
      expect(r.code, name).toBe(1);
      expect(JSON.parse(r.stdout), name).toEqual({ valid: false, reason: "malformed_decision" });
    }
  });

  it("an unreadable or non-JSON decision file is exit 2 (I/O), never a verdict", async () => {
    for (const p of [join(tmp, "ad-missing.json"), write("ad-not-json.json", "{not json")]) {
      const r = await runMain(["approval-decision", p]);
      expect(r.code, p).toBe(2);
      expect(r.stderr).toMatch(/^motebit-verify: cannot read approval-decision /);
      expect(r.stdout).toBe("");
    }
  });
});
