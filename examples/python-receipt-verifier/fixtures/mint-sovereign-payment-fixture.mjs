/**
 * Regenerates `sovereign-payment-receipt.json` — a sovereign payment receipt
 * (spec/settlement-v1.md §7) signed by the payee through the canonical
 * `signSovereignPaymentReceipt` from @motebit/crypto, the signer the runtime's
 * payee path calls. Never hand-edit the output: re-run this script.
 *
 *   node mint-sovereign-payment-fixture.mjs   # after `pnpm build` of crypto + verifier
 *
 * Deterministic: the payee key is the same FIXED, PUBLIC demo seed as
 * `mint-sovereign-fixture.mjs` (0x01..0x20), every input is a constant, and
 * Ed25519 signing is deterministic, so a re-run reproduces the file byte for
 * byte. The receipt shows both hashes binding the bytes they name:
 * `result_hash` = hex(SHA-256(result)) of the receipt's own payment-record
 * text, and `service_result_hash` = hex(SHA-256(service result)), the paid
 * service's result as the payer asserted it. It must verify under strict
 * hash binding or the script refuses to write.
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..", "..");
const crypto = await import(join(REPO, "packages/crypto/dist/index.js"));
const verifier = await import(join(REPO, "packages/verifier/dist/index.js"));

const SUITE = "motebit-jcs-ed25519-b64-v1";
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");

// PUBLIC demo keys — intentionally committed; nothing to keep secret.
const PAYEE_SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) PAYEE_SEED[i] = i + 1; // 0x01..0x20
const PAYER_SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) PAYER_SEED[i] = i + 33; // 0x21..0x40

const payeePub = await crypto.getPublicKeyBySuite(PAYEE_SEED, SUITE);
const payerPub = await crypto.getPublicKeyBySuite(PAYER_SEED, SUITE);
const payeeId = await crypto.deriveSovereignMotebitId(crypto.bytesToHex(payeePub));
const payerId = await crypto.deriveSovereignMotebitId(crypto.bytesToHex(payerPub));

const prompt = "Summarize the three most-cited papers on Ed25519 batch verification.";
const serviceResult =
  "1. Bernstein et al., High-speed high-security signatures (2011). 2. Chalkias et al., Taming the many EdDSAs (2020). 3. de Valence et al., ZIP 215 (2020).";

const signed = await crypto.signSovereignPaymentReceipt(
  {
    payee_motebit_id: payeeId,
    payee_device_id: "019dc500-0000-7000-a000-0000000000de",
    payer_motebit_id: payerId,
    rail: "solana",
    tx_hash:
      "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW",
    amount_micro: 250000n,
    asset: "USDC",
    service_description: "Literature summary",
    prompt_hash: sha(prompt),
    result_hash: sha(serviceResult),
    tools_used: ["web_search"],
    submitted_at: 1777109000245,
    completed_at: 1777109004871,
  },
  PAYEE_SEED,
  payeePub,
);

const text = JSON.stringify(signed, null, 2) + "\n";
const r = await verifier.verifyArtifact(text, { strictHashBinding: true });
if (!(r.valid && r.sovereign && signed.result_hash === sha(signed.result))) {
  console.error("REFUSING TO WRITE — not strict-valid and sovereign:", JSON.stringify(r));
  process.exit(1);
}
const out = join(HERE, "sovereign-payment-receipt.json");
writeFileSync(out, text);
console.log("OK strict-valid, sovereign:", r.sovereign, "→", out);
