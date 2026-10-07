// Generate a fresh, validly signed motebit.md with the repo's own generator
// (`@motebit/identity-file`), for the Action's CI smoke job. Run after
// `pnpm --filter @motebit/identity-file... build`.
//
//   node packages/github-action/test/generate-identity.mjs <out-path>
//
// Prints `motebit_id=<id>` and `public_key=<hex>` on stdout so the job can
// assert the Action's outputs against them.
import { writeFileSync } from "node:fs";
import { generate } from "../../identity-file/dist/index.js";
import { generateKeypair } from "../../crypto/dist/index.js";

const out = process.argv[2];
if (!out) {
  console.error("usage: generate-identity.mjs <out-path>");
  process.exit(2);
}
const kp = await generateKeypair();
const publicKeyHex = Buffer.from(kp.publicKey).toString("hex");
const motebitId = crypto.randomUUID();
const file = await generate(
  { motebitId, ownerId: "github-action-smoke", publicKeyHex },
  kp.privateKey,
);
writeFileSync(out, file);
console.log(`motebit_id=${motebitId}`);
console.log(`public_key=${publicKeyHex}`);
