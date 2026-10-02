/**
 * Regenerate `src/sample-receipt.json` — the receipt.computer on-load sample.
 * Deterministic: same public demo seeds → byte-identical file. Refuses to write
 * a receipt that does not verify.
 *
 *   pnpm --filter @motebit/verify-web mint-sample
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { verifyReceiptDocument } from "@motebit/state-export-client";
import { buildSampleReceipt, serializeSample } from "../src/sample-build.js";

const receipt = await buildSampleReceipt();
const text = serializeSample(receipt);
const view = await verifyReceiptDocument(text);
if (!view.integrity || view.binding !== "sovereign") {
  console.error("REFUSING TO WRITE — sample does not verify sovereign:", JSON.stringify(view));
  process.exit(1);
}
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "sample-receipt.json");
writeFileSync(out, text);
console.log("OK →", out);
