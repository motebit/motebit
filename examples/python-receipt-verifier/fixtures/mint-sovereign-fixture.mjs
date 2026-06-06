/**
 * Regenerates `sovereign-receipt.json` — a real, sovereign-rung execution
 * receipt for demos, evals, and the proof-integration tests.
 *
 * Provenance over magic (this is a proof brand): the demo key is a FIXED,
 * PUBLIC seed below — not a secret. Anyone can re-run this, re-derive the
 * same motebit_id, and reproduce the byte-identical signed receipt. The
 * receipt is signed through the canonical `signExecutionReceipt` from
 * @motebit/crypto — never a hand-rolled signer — so it verifies against the
 * exact recipe `@motebit/verifier` checks.
 *
 *   node mint-sovereign-fixture.mjs    # from this directory, after `pnpm build` of crypto+verifier
 *
 * Why sovereign: `deriveSovereignMotebitId(pubHex)` makes the motebit_id the
 * commitment to the genesis key, so `verifyArtifact(...).sovereign === true`
 * offline, with no relay and no chain lookup.
 */
import * as ed from "@noble/ed25519";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deriveSovereignMotebitId, signExecutionReceipt } from "@motebit/crypto";
import { verifyArtifact } from "@motebit/verifier";

// PUBLIC demo key — intentionally committed. This identity exists only to be
// verified by anyone; there is nothing to keep secret about a demo signer.
const DEMO_SEED = new Uint8Array(32);
for (let i = 0; i < 32; i++) DEMO_SEED[i] = i + 1; // 0x01..0x20

const priv = DEMO_SEED;
const pub = await ed.getPublicKeyAsync(priv);
const pubHex = bytesToHex(pub);
const motebitId = await deriveSovereignMotebitId(pubHex);

const prompt =
  "Verify this receipt yourself: signed by a sovereign motebit, checkable offline with no server.";
const result =
  "This receipt was signed by a key the motebit_id itself commits to. Anyone can confirm it in their own browser or terminal with @motebit/verifier and zero trust in any server.";
const sha = (s) => bytesToHex(sha256(new TextEncoder().encode(s)));

const body = {
  task_id: "019dc500-0000-7000-a000-000000000001",
  motebit_id: motebitId,
  device_id: "019dc500-0000-7000-a000-0000000000de",
  invocation_origin: "user-tap",
  submitted_at: 1777109000245,
  completed_at: 1777109000246,
  status: "completed",
  result,
  tools_used: [],
  memories_formed: 0,
  prompt_hash: sha(prompt),
  result_hash: sha(result),
};

const signed = await signExecutionReceipt(body, priv, pub);
const r = await verifyArtifact(JSON.stringify(signed));
if (!(r.valid && r.sovereign)) {
  console.error("REFUSING TO WRITE — not sovereign:", JSON.stringify(r));
  process.exit(1);
}
const out = join(dirname(fileURLToPath(import.meta.url)), "sovereign-receipt.json");
writeFileSync(out, JSON.stringify(signed, null, 2) + "\n");
console.log("OK sovereign:", r.sovereign, "→", out);
