/**
 * Refresh scripts/vendor/vercel/vercel.schema.json from Vercel's published
 * schema, stamping its source URL and fetch date into `$comment`. Run by hand
 * (never in CI — the gate must not depend on the network); see
 * scripts/vendor/vercel/README.md.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = "https://openapi.vercel.sh/vercel.json";
const OUT = join(process.cwd(), "scripts/vendor/vercel/vercel.schema.json");

const res = await fetch(SOURCE);
if (!res.ok) throw new Error(`GET ${SOURCE} → ${res.status}`);
const schema = (await res.json()) as Record<string, unknown>;
if (schema == null || typeof schema !== "object" || schema["properties"] == null) {
  throw new Error(`${SOURCE} did not return a JSON schema with properties`);
}
const date = new Date().toISOString().slice(0, 10);
const stamped = {
  $comment: `Vendored verbatim from ${SOURCE}, fetched ${date} by scripts/refresh-vercel-schema.ts. Do not edit by hand; re-run the script.`,
  ...Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$comment")),
};
writeFileSync(OUT, `${JSON.stringify(stamped, null, 2)}\n`);
console.log(`wrote ${OUT} from ${SOURCE} (${date})`);
