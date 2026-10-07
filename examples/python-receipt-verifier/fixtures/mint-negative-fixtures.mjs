/**
 * Regenerates the NEGATIVE conformance vectors under `negative/` — receipts
 * every implementation MUST reject (scripts/check-receipt-conformance.ts runs
 * them through @motebit/verifier, @motebit/crypto, @motebit/state-export-client
 * and the Python reference, strict and default). Never hand-edit the output:
 * re-run this script.
 *
 *   node mint-negative-fixtures.mjs   # after `pnpm build` of crypto
 *
 * Deterministic: the signer is the FIXED, PUBLIC demo seed shared with
 * `mint-sovereign-fixture.mjs` (0x01..0x20), every input is a constant, and
 * Ed25519 signing is deterministic.
 *
 * result-lone-surrogate.json — `result` holds an unpaired UTF-16 surrogate
 * (U+D800). UTF-8(result) is undefined for it (spec/execution-ledger-v1.md
 * §11.4), so the receipt is invalid however it was signed. It is signed over
 * the JCS bytes a JavaScript signer produces (the surrogate escaped as
 * `\ud800`) with result_hash = hex(SHA-256(UTF-8 with U+FFFD substituted)) —
 * exactly what a lenient JS verifier would accept — so a verifier that
 * substitutes instead of rejecting reads it VALID and fails the gate.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const crypto = await import(join(REPO, "packages/crypto/dist/index.js"));

const SUITE = "motebit-jcs-ed25519-b64-v1";
const SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) SEED[i] = i + 1; // 0x01..0x20 — PUBLIC demo key
const pub = await crypto.getPublicKeyBySuite(SEED, SUITE);
const motebitId = await crypto.deriveSovereignMotebitId(crypto.bytesToHex(pub));

const result = "partial answer \ud800";
const body = {
  task_id: "019dc500-0000-7000-a000-00000000fffd",
  motebit_id: motebitId,
  device_id: "019dc500-0000-7000-a000-0000000000de",
  submitted_at: 1777109000245,
  completed_at: 1777109004871,
  status: "completed",
  result,
  tools_used: [],
  memories_formed: 0,
  prompt_hash: createHash("sha256").update("lone surrogate vector", "utf8").digest("hex"),
  // Node's "utf8" encoding substitutes U+FFFD for the lone surrogate.
  result_hash: createHash("sha256").update(result, "utf8").digest("hex"),
};
const signed = await crypto.signExecutionReceipt(body, SEED, pub);

const outDir = join(HERE, "negative");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, "result-lone-surrogate.json");
// JSON.stringify escapes the lone surrogate as \ud800 — the file is valid JSON.
writeFileSync(out, JSON.stringify(signed, null, 2) + "\n");
console.log("wrote", out);
