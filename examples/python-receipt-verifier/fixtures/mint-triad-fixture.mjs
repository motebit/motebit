/**
 * Regenerates the PAIRED full-governance-triad fixture set — the artifact that
 * makes the whole triad showable as one *linked* story instead of disconnected
 * cards. One sovereign agent + the canonical approver, with REAL correlators
 * (no faked linkage):
 *
 *   approve band (3 linked fixtures for ONE gated call):
 *     triad-approval-decision.json      ApprovalDecision  (approver-signed)
 *       run_id = T, args_hash = H, approval_id = C
 *     triad-tool-invocation-receipt.json ToolInvocationReceipt (agent-signed)
 *       task_id = T, args_hash = H, invocation_id = C   ← same T, H, C
 *     triad-execution-receipt.json      ExecutionReceipt (agent-signed, sovereign)
 *       task_id = T, status completed                   ← same T
 *
 *   deny band (same agent, distinct task):
 *     triad-deny-receipt.json           ExecutionReceipt (agent-signed, sovereign)
 *       task_id = D, status denied
 *
 * The linkage is what's new and honest: `args_hash` ties the human's consent to
 * the EXACT executed call (ApprovalDecision.args_hash === ToolInvocationReceipt
 * .args_hash); `task_id`/`run_id` ties consent → execution (ApprovalDecision
 * .run_id === both receipts' task_id). The execution side is SOVEREIGN (the
 * agent's motebit_id commits to its key); the consent side is approver-signed,
 * verified against the PINNED canonical approver key (never the embedded one —
 * see docs/developer/governance-triad.mdx).
 *
 *   node mint-triad-fixture.mjs   # from this dir, after `pnpm build` of crypto
 *
 * Provenance over magic: both keys are FIXED PUBLIC seeds (agent 0x01..0x20 —
 * the same sovereign demo agent as mint-sovereign-fixture.mjs; approver
 * 0x21..0x40 — the same as mint-approval-decision-fixture.mjs). Reproducible
 * byte-for-byte. Refuses to write unless every signature verifies AND every
 * cross-fixture correlator matches.
 */
import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  deriveSovereignMotebitId,
  hashToolPayload,
  signApprovalDecision,
  verifyApprovalDecision,
  signToolInvocationReceipt,
  verifyToolInvocationReceipt,
  signExecutionReceipt,
  verifyExecutionReceipt,
} from "@motebit/crypto";

const seed = (start) => {
  const s = new Uint8Array(32);
  for (let i = 0; i < 32; i++) s[i] = i + start;
  return s;
};

// Agent (executor) — sovereign: motebit_id commits to this key. Seed 0x01..0x20.
const agentPriv = seed(1);
const agentPub = await ed.getPublicKeyAsync(agentPriv);
const agentPubHex = bytesToHex(agentPub);
const motebitId = await deriveSovereignMotebitId(agentPubHex);

// Approver (the human's device) — seed 0x21..0x40. Published canonical key.
const approverPriv = seed(33);
const approverPub = await ed.getPublicKeyAsync(approverPriv);
const approverPubHex = bytesToHex(approverPub);

const sha = (s) => bytesToHex(sha256(new TextEncoder().encode(s)));
const here = dirname(fileURLToPath(import.meta.url));
const write = (name, obj) => writeFileSync(join(here, name), JSON.stringify(obj, null, 2) + "\n");

// === The shared correlators for the APPROVE-band call ===
const T = "019dc500-0000-7000-c000-000000000a01"; // task / run
const C = "019dc500-0000-7000-c000-0000000000c1"; // the gated tool call (approval_id === invocation_id)
const agentDevice = "019dc500-0000-7000-a000-0000000000de";
const approverDevice = "019dc500-0000-7000-b000-0000000000ab";

// The exact args the human saw and approved — both consent and execution commit
// to THIS hash, which is what proves the executed call is the one approved.
const emailArgs = '{"to":"vendor@example.com","subject":"Q3 contract — signed copy"}';
const H = await hashToolPayload(JSON.parse(emailArgs));
const emailResult = "Email sent to vendor@example.com after your approval.";

// 1. The human's signed consent (approver-signed; verify against PINNED approver key).
const approval = await signApprovalDecision(
  {
    approval_id: C,
    motebit_id: motebitId,
    device_id: approverDevice,
    tool_name: "send_email",
    args_hash: H,
    risk_level: 2,
    verdict: "approved",
    requested_at: 1777109300000,
    resolved_at: 1777109331000,
    run_id: T,
  },
  approverPriv,
  approverPub,
);

// 2. The executed approved call (agent-signed; same args_hash H, same call id C, task T).
const toolReceipt = await signToolInvocationReceipt(
  {
    invocation_id: C,
    task_id: T,
    motebit_id: motebitId,
    device_id: agentDevice,
    tool_name: "send_email",
    started_at: 1777109332000,
    completed_at: 1777109333000,
    status: "completed",
    args_hash: H,
    result_hash: sha(emailResult),
    invocation_origin: "user-tap",
  },
  agentPriv,
  agentPub,
);

// 3. The task that ran after approval (agent-signed, sovereign; same task T).
const execReceipt = await signExecutionReceipt(
  {
    task_id: T,
    motebit_id: motebitId,
    device_id: agentDevice,
    submitted_at: 1777109299000,
    completed_at: 1777109334000,
    status: "completed",
    result: "Sent the Q3 contract to the vendor after you approved the send.",
    tools_used: ["send_email"],
    memories_formed: 0,
    prompt_hash: sha("Send the signed Q3 contract to the vendor."),
    result_hash: sha("Sent the Q3 contract to the vendor after you approved the send."),
    invocation_origin: "user-tap",
  },
  agentPriv,
  agentPub,
);

// 4. Deny band — same agent refuses an over-policy act (distinct task D).
const D = "019dc500-0000-7000-c000-000000000d01";
const denyResult = "Attempted to send $4,800 to a new payee. Denied by policy. No funds moved.";
const denyReceipt = await signExecutionReceipt(
  {
    task_id: D,
    motebit_id: motebitId,
    device_id: agentDevice,
    submitted_at: 1777109400000,
    completed_at: 1777109401000,
    status: "denied",
    result: denyResult,
    tools_used: [],
    memories_formed: 0,
    prompt_hash: sha("Pay the new vendor $4,800."),
    result_hash: sha(denyResult),
    invocation_origin: "user-tap",
  },
  agentPriv,
  agentPub,
);

// === Refuse to write unless every signature verifies AND every correlator matches ===
const checks = [
  ["approval verifies (pinned approver key)", await verifyApprovalDecision(approval, approverPub)],
  ["tool-invocation verifies (agent key)", await verifyToolInvocationReceipt(toolReceipt, agentPub)],
  ["execution verifies (agent key)", await verifyExecutionReceipt(execReceipt, agentPub)],
  ["deny verifies (agent key)", await verifyExecutionReceipt(denyReceipt, agentPub)],
  // Linkage — the whole point.
  ["run_id ↔ task_id (consent → task)", approval.run_id === execReceipt.task_id && approval.run_id === toolReceipt.task_id],
  ["args_hash (consent ↔ exact executed call)", approval.args_hash === toolReceipt.args_hash],
  ["call id (approval_id ↔ invocation_id)", approval.approval_id === toolReceipt.invocation_id],
  ["one agent across the receipts", execReceipt.motebit_id === toolReceipt.motebit_id && execReceipt.motebit_id === motebitId],
  // Tamper — flipping the verdict must break the approval signature.
  ["approval tamper rejected", !(await verifyApprovalDecision({ ...approval, verdict: "denied" }, approverPub))],
];
const failed = checks.filter(([, ok]) => !ok);
if (failed.length > 0) {
  console.error("REFUSING TO WRITE — checks failed:");
  for (const [name] of failed) console.error("  ✗ " + name);
  process.exit(1);
}

write("triad-approval-decision.json", approval);
write("triad-tool-invocation-receipt.json", toolReceipt);
write("triad-execution-receipt.json", execReceipt);
write("triad-deny-receipt.json", denyReceipt);

for (const [name] of checks) console.log("  ✓ " + name);
console.log("");
console.log("Shared correlators:  task/run T =", T, " call C =", C);
console.log("                     args_hash H =", H.slice(0, 16) + "…");
console.log("Agent (sovereign) motebit_id:", motebitId);
console.log("Agent public key (verify receipts against this OR rely on sovereign binding):");
console.log("  " + agentPubHex);
console.log("CANONICAL APPROVER PUBLIC KEY (pin this for the ApprovalDecision):");
console.log("  " + approverPubHex);
