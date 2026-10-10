/**
 * CI backing for the approval → tool call → receipt defect/control case
 * (`examples/interop/approval-triad/`). The case's public claim is
 * `expected.json`; the Python reader in that directory checks it with no
 * Motebit code. This test checks the SAME claim from the SAME bytes with
 * Motebit's own verifiers, so the claim cannot drift from what our code says:
 *
 *   - signatures: `verifyApprovalDecision` (pinned approver key),
 *     `verifyToolInvocationReceipt` / `verifyExecutionReceipt` (pinned agent
 *     key) from @motebit/crypto — the embedded `public_key` is not trusted;
 *   - relations: the join on approval_id = invocation_id, tool_name,
 *     args_hash, verdict, ordering (resolved_at ≤ started_at), run_id = task_id;
 *   - binding is never evaluated here, so it is never `pass`.
 *
 * It also asserts the CONTROL files are byte-identical to the frozen triad
 * fixtures, and that every case file is exactly what the canonical minter
 * (`mint-cases.mts`, through `signApprovalDecision` /
 * `signToolInvocationReceipt`) produces — no hand-rolled signature can hide.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import {
  bytesToHex,
  getPublicKeyBySuite,
  hexToBytes,
  verifyApprovalDecision,
  verifyExecutionReceipt,
  verifyToolInvocationReceipt,
} from "../../packages/crypto/src/index.js";
import type { ApprovalDecision, ExecutionReceipt } from "../../packages/protocol/src/index.js";
import {
  buildCases,
  CONTROL_SOURCES,
  FROZEN_DIR,
} from "../../examples/interop/approval-triad/mint-cases.mjs";

const CASE_ROOT = resolve(__dirname, "../../examples/interop/approval-triad");

type State = "pass" | "fail" | "not_evaluated";
interface ExpectedCase {
  dir: string;
  files: Record<string, string>;
  verdict: "MATCH" | "MISMATCH" | "INVALID";
  claims: Record<string, State>;
  codes: string[];
  decisive: string | null;
  unjoined?: Record<string, { signature_receipt: State }>;
}
interface Expected {
  pinned_keys: { approver: string; agent: string };
  claims: string[];
  cases: Record<string, ExpectedCase>;
}

const EXPECTED = JSON.parse(readFileSync(join(CASE_ROOT, "expected.json"), "utf8")) as Expected;

const RELATIONS = ["call_id", "tool_name", "args_hash", "verdict", "ordering", "run"] as const;
const SIGNATURES = ["signature_approval", "signature_invocation", "signature_receipt"] as const;

const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");
const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;

async function evaluate(dir: string): Promise<Omit<ExpectedCase, "dir" | "files">> {
  const approverKey = hexToBytes(EXPECTED.pinned_keys.approver);
  const agentKey = hexToBytes(EXPECTED.pinned_keys.agent);
  const approval = readJson(join(dir, "approval.json"));
  const invocation = readJson(join(dir, "invocation.json"));
  const receipt = readJson(join(dir, "receipt.json"));
  const st = (ok: boolean): State => (ok ? "pass" : "fail");

  const claims: Record<string, State> = {
    signature_approval: st(
      await verifyApprovalDecision(approval as unknown as ApprovalDecision, approverKey),
    ),
    signature_invocation: st(
      await verifyToolInvocationReceipt(
        invocation as unknown as Parameters<typeof verifyToolInvocationReceipt>[0],
        agentKey,
      ),
    ),
    signature_receipt: st(
      await verifyExecutionReceipt(receipt as unknown as ExecutionReceipt, agentKey),
    ),
  };
  const sigFailed = SIGNATURES.filter((c) => claims[c] !== "pass");

  if (sigFailed.length > 0) {
    for (const c of RELATIONS) claims[c] = "not_evaluated";
  } else {
    const ok: Record<(typeof RELATIONS)[number], boolean> = {
      call_id: approval.approval_id === invocation.invocation_id,
      tool_name: approval.tool_name === invocation.tool_name,
      args_hash: approval.args_hash === invocation.args_hash,
      verdict: invocation.status !== "completed" || approval.verdict === "approved",
      ordering: (approval.resolved_at as number) <= (invocation.started_at as number),
      run: approval.run_id === invocation.task_id && invocation.task_id === receipt.task_id,
    };
    for (const c of RELATIONS) claims[c] = st(ok[c]);
  }
  claims.binding = "not_evaluated";

  const failed = RELATIONS.filter((c) => claims[c] === "fail");
  const out: Omit<ExpectedCase, "dir" | "files"> =
    sigFailed.length > 0
      ? { verdict: "INVALID", claims, codes: ["signature"], decisive: sigFailed[0]! }
      : failed.length > 0
        ? { verdict: "MISMATCH", claims, codes: [...failed], decisive: failed[0]! }
        : { verdict: "MATCH", claims, codes: [], decisive: null };

  const denyPath = join(dir, "deny-receipt.json");
  if (existsSync(denyPath)) {
    // Task D: an agent-signed refusal with no approval. Outside the join;
    // only its signature is read.
    const deny = readJson(denyPath);
    out.unjoined = {
      "deny-receipt.json": {
        signature_receipt: st(
          await verifyExecutionReceipt(deny as unknown as ExecutionReceipt, agentKey),
        ),
      },
    };
  }
  return out;
}

describe("approval-triad defect/control case", () => {
  it("pins the fixed public demo keys the canonical minter derives", async () => {
    const seed = (start: number): Uint8Array =>
      Uint8Array.from({ length: 32 }, (_, i) => i + start);
    const suite = "motebit-jcs-ed25519-b64-v1" as const;
    expect(EXPECTED.pinned_keys.agent).toBe(bytesToHex(await getPublicKeyBySuite(seed(1), suite)));
    expect(EXPECTED.pinned_keys.approver).toBe(
      bytesToHex(await getPublicKeyBySuite(seed(33), suite)),
    );
  });

  it("CONTROL is byte-identical to the frozen triad fixtures", () => {
    const control = EXPECTED.cases.control!;
    for (const [name, src] of Object.entries(CONTROL_SOURCES)) {
      const frozen = sha256File(join(FROZEN_DIR, src));
      expect(sha256File(join(CASE_ROOT, control.dir, name)), name).toBe(frozen);
      expect(control.files[name], name).toBe(frozen);
    }
  });

  it("every case file is exactly what the canonical minter produces", async () => {
    const built = await buildCases();
    const onDisk: string[] = [];
    for (const c of readdirSync(join(CASE_ROOT, "cases"))) {
      for (const f of readdirSync(join(CASE_ROOT, "cases", c))) onDisk.push(`${c}/${f}`);
    }
    expect(onDisk.sort()).toEqual(Object.keys(built).sort());
    for (const [rel, bytes] of Object.entries(built)) {
      expect(readFileSync(join(CASE_ROOT, "cases", rel), "utf8"), rel).toBe(bytes);
    }
  });

  it("expected.json covers every case directory and states the claim list", () => {
    expect(EXPECTED.claims).toEqual([...SIGNATURES, ...RELATIONS, "binding"]);
    expect(
      Object.values(EXPECTED.cases)
        .map((c) => c.dir)
        .sort(),
    ).toEqual(
      readdirSync(join(CASE_ROOT, "cases"))
        .map((d) => `cases/${d}`)
        .sort(),
    );
  });

  for (const [name, exp] of Object.entries(EXPECTED.cases)) {
    it(`${name}: @motebit/crypto reproduces every field of expected.json`, async () => {
      const dir = join(CASE_ROOT, exp.dir);
      for (const [f, sha] of Object.entries(exp.files)) {
        expect(sha256File(join(dir, f)), `${name}/${f}`).toBe(sha);
      }
      expect(readdirSync(dir).sort()).toEqual(Object.keys(exp.files).sort());
      const { dir: _d, files: _f, ...claim } = exp;
      expect(await evaluate(dir)).toEqual(claim);
      // Binding is never established by this case; a pass would be a false claim.
      expect(exp.claims.binding).toBe("not_evaluated");
    });
  }
});
