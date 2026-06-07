/**
 * Regenerates the canonical `approval-decision-*.json` fixtures — real, signed
 * human-consent decisions (the "approve" governance band) for demos, evals, and
 * cold-consume tests.
 *
 * Provenance over magic (this is a proof brand): the approver key is a FIXED,
 * PUBLIC seed below — DISTINCT from the agent/executor seed used by
 * `mint-sovereign-fixture.mjs`, because the approver (the human consenting) is a
 * different party from the agent whose action is gated. Anyone can re-run this
 * and reproduce the byte-identical signed decisions. Signed through the
 * canonical `signApprovalDecision` from @motebit/crypto — never a hand-rolled
 * signer.
 *
 *   node mint-approval-decision-fixture.mjs   # from this dir, after `pnpm build` of crypto
 *
 * IMPORTANT — what a verified ApprovalDecision proves (read before rendering it):
 * unlike a sovereign ExecutionReceipt, `motebit_id` does NOT commit to the
 * approver's key. So `verifyApprovalDecision(decision, key)` proves the decision
 * was signed by whoever holds `key` and is untampered (signature-authentic) — it
 * does NOT prove that key has authority. To verify HONESTLY, pin the CANONICAL
 * APPROVER PUBLIC KEY printed below (do not trust the embedded `public_key`
 * alone — that is circular). See docs/developer/governance-triad.mdx
 * § "What a verified ApprovalDecision proves."
 */
import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  deriveSovereignMotebitId,
  signApprovalDecision,
  verifyApprovalDecision,
} from "@motebit/crypto";

// PUBLIC demo APPROVER key — committed on purpose, distinct from the agent seed
// (0x01..0x20 in mint-sovereign-fixture.mjs). This is the human owner's device
// key that renders consent. Publish its public key so consumers pin against it.
const APPROVER_SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) APPROVER_SEED[i] = i + 33; // 0x21..0x40

const approverPriv = APPROVER_SEED;
const approverPub = await ed.getPublicKeyAsync(approverPriv);
const approverPubHex = bytesToHex(approverPub);

// The EXECUTOR (the agent whose gated action is being approved) is the same
// sovereign demo agent as mint-sovereign-fixture.mjs (seed 0x01..0x20), so the
// fixtures tell one coherent story: the owner consents to their agent's act.
const AGENT_SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) AGENT_SEED[i] = i + 1; // 0x01..0x20
const agentPub = await ed.getPublicKeyAsync(AGENT_SEED);
const motebitId = await deriveSovereignMotebitId(bytesToHex(agentPub));

const sha = (s) => bytesToHex(sha256(new TextEncoder().encode(s)));

const here = dirname(fileURLToPath(import.meta.url));

/** One approval decision: approver consents to (or refuses) a gated tool call. */
const cases = [
  {
    file: "approval-decision-approved.json",
    body: {
      approval_id: "019dc500-0000-7000-b000-000000000a01",
      motebit_id: motebitId,
      device_id: "019dc500-0000-7000-b000-0000000000ap",
      tool_name: "send_email",
      // SHA-256 of the canonical args the approver saw — never the raw args.
      args_hash: sha('{"to":"vendor@example.com","subject":"Q3 contract"}'),
      risk_level: 2,
      verdict: "approved",
      requested_at: 1777109100000,
      resolved_at: 1777109142000,
      run_id: "019dc500-0000-7000-b000-000000000r01",
    },
  },
  {
    file: "approval-decision-denied.json",
    body: {
      approval_id: "019dc500-0000-7000-b000-000000000d01",
      motebit_id: motebitId,
      device_id: "019dc500-0000-7000-b000-0000000000ap",
      tool_name: "send_payment",
      args_hash: sha('{"to":"0xX","amount_usd":4800}'),
      risk_level: 4,
      verdict: "denied",
      requested_at: 1777109200000,
      resolved_at: 1777109230000,
      denied_reason: "Above the owner's approval ceiling — declined.",
      run_id: "019dc500-0000-7000-b000-000000000r02",
    },
  },
];

for (const c of cases) {
  const signed = await signApprovalDecision(c.body, approverPriv, approverPub);
  // Self-verify against the canonical approver key before writing — refuse to
  // emit anything that doesn't verify.
  const ok = await verifyApprovalDecision(signed, approverPub);
  if (!ok) {
    console.error(`REFUSING TO WRITE ${c.file} — does not verify`);
    process.exit(1);
  }
  // Tamper check: flipping the verdict must break the signature.
  const tampered = { ...signed, verdict: signed.verdict === "approved" ? "denied" : "approved" };
  if (await verifyApprovalDecision(tampered, approverPub)) {
    console.error(`REFUSING TO WRITE ${c.file} — tamper did not break verification`);
    process.exit(1);
  }
  writeFileSync(join(here, c.file), JSON.stringify(signed, null, 2) + "\n");
  console.log(`OK ${c.verdict ?? c.body.verdict} → ${c.file}`);
}

console.log("");
console.log("CANONICAL APPROVER PUBLIC KEY (pin this — do not trust the embedded key alone):");
console.log("  " + approverPubHex);
