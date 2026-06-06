/**
 * Regenerates the outcome-shaped sovereign demo receipts — receipts whose
 * `result` is real, recognizable work (the thing a buyer would delegate), not a
 * statement about cryptography. The proof (sovereign rung, Ed25519) is the quiet
 * backing under a recognizable act — see docs/doctrine/agency-proof-integration.md.
 *
 * Same FIXED, PUBLIC demo identity as sovereign-receipt.json (one demo agent,
 * different acts). Signed through the canonical `signExecutionReceipt` — never
 * hand-rolled — so each verifies against the exact recipe `@motebit/verifier`
 * checks. Fully reproducible:
 *
 *   node mint-demo-receipts.mjs   # from this directory, after `pnpm build` of crypto+verifier
 *
 * These are FROZEN vectors: consumers byte-match them. Never edit in place — a
 * changed receipt gets a new filename.
 */
import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deriveSovereignMotebitId, signExecutionReceipt } from "@motebit/crypto";
import { verifyArtifact } from "@motebit/verifier";

const DEMO_SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) DEMO_SEED[i] = i + 1; // public demo key, 0x01..0x20

const pub = await ed.getPublicKeyAsync(DEMO_SEED);
const motebitId = await deriveSovereignMotebitId(bytesToHex(pub));
const sha = (s) => bytesToHex(sha256(new TextEncoder().encode(s)));

const RECEIPTS = [
  {
    file: "sovereign-receipt-stripe-audit.json",
    task_id: "019dc500-0000-7000-a000-00000000a17d",
    prompt:
      "Audit last month's Stripe payouts against the ledger and flag every mismatch over $50.",
    result:
      "Audited 1,284 Stripe payouts against the ledger for May 2026. Flagged 3 mismatches over $50 (total $214.37). Paused before exporting the report — held for your approval, nothing sent or changed.",
    tools_used: ["browser", "stripe.payouts.read", "ledger.read"],
    memories_formed: 1,
  },
  {
    file: "sovereign-receipt-email-approval.json",
    task_id: "019dc500-0000-7000-a000-00000000e3a1",
    prompt: "Reply to the vendor about the invoice discrepancy.",
    result:
      "Drafted an outbound email to billing@acme.example re: invoice #4471 ($214.37 discrepancy) and queued it for your approval. Not sent — outbound send is gated behind your permission.",
    tools_used: ["browser", "email.draft"],
    memories_formed: 0,
  },
  {
    // The "acts autonomously, within bounds" pole — status: completed, no gate hit.
    file: "sovereign-receipt-research-complete.json",
    task_id: "019dc500-0000-7000-a000-00000000c0de",
    prompt:
      "Research the top 10 competitors in vertical SaaS billing and compile a comparison sheet with pricing and gaps.",
    result:
      "Researched 10 vertical-SaaS billing competitors and compiled a comparison sheet (10 rows, 6 columns: pricing, tiers, gaps). Completed and saved to the workspace — read-only sources, nothing sent or changed.",
    tools_used: ["browser", "web.search"],
    status: "completed",
    memories_formed: 1,
  },
  {
    // The "refuses to cross the line" pole — status: denied by policy. The
    // strongest 'constrained enough to trust' artifact: the agent's own signed
    // receipt attests it blocked itself.
    file: "sovereign-receipt-payment-denied.json",
    task_id: "019dc500-0000-7000-a000-00000000dead",
    prompt: "Pay the $1,200 vendor invoice.",
    result:
      "Attempted to send $1,200 to an unverified payee. Denied by policy — payee not on your allowlist and the amount exceeds the $500 auto-approve cap. No funds moved.",
    tools_used: ["browser"],
    status: "denied",
    memories_formed: 0,
  },
];

const here = dirname(fileURLToPath(import.meta.url));
for (const R of RECEIPTS) {
  const body = {
    task_id: R.task_id,
    motebit_id: motebitId,
    device_id: "019dc500-0000-7000-a000-0000000000de",
    invocation_origin: "user-tap",
    submitted_at: 1777109000245,
    completed_at: 1777109000246,
    status: R.status ?? "completed",
    result: R.result,
    tools_used: R.tools_used,
    memories_formed: R.memories_formed,
    prompt_hash: sha(R.prompt),
    result_hash: sha(R.result),
  };
  const signed = await signExecutionReceipt(body, DEMO_SEED, pub);
  const v = await verifyArtifact(JSON.stringify(signed));
  if (!(v.valid && v.sovereign)) {
    console.error("REFUSING to write (not sovereign):", R.file);
    process.exit(1);
  }
  writeFileSync(join(here, R.file), JSON.stringify(signed, null, 2) + "\n");
  console.log("OK", R.file, "sovereign:", v.sovereign);
}
