#!/usr/bin/env node
/**
 * Main-verdict oracle for the payment-receipt well-formed-text harness
 * (apps/cli/src/__tests__/payment-receipt-wellformed-harness.test.ts).
 *
 * Replays the harness's deterministic legacy corpus against a BUILT checkout
 * of origin/main and records, per cell, the verdict of every library path
 * whose default must stay identical to main. The output is committed as
 * apps/cli/src/__tests__/fixtures/payment-receipt-wellformed.main-verdicts.json.
 *
 * Regenerate (only when the corpus changes, never to make a cell green):
 *   git worktree add /tmp/main origin/main
 *   (cd /tmp/main && pnpm install --frozen-lockfile && pnpm turbo run build --filter=@motebit/verifier...)
 *   WF_DUMP_CORPUS=/tmp/corpus.json pnpm --filter motebit exec vitest run payment-receipt-wellformed-harness
 *   node apps/cli/scripts/wellformed-main-oracle.mjs /tmp/main /tmp/corpus.json \
 *     apps/cli/src/__tests__/fixtures/payment-receipt-wellformed.main-verdicts.json
 *
 * The lib-path runner below mirrors `runLibPaths` in the harness line for
 * line; a drift between the two shows up as every cell mismatching.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [mainRoot, corpusPath, outPath] = process.argv.slice(2);
if (!mainRoot || !corpusPath || !outPath) {
  console.error("usage: wellformed-main-oracle.mjs <main-checkout> <corpus.json> <out.json>");
  process.exit(2);
}

const crypto = await import(pathToFileURL(join(mainRoot, "packages/crypto/dist/index.js")).href);
const verifier = await import(
  pathToFileURL(join(mainRoot, "packages/verifier/dist/index.js")).href
);

function stableStringify(v) {
  if (v instanceof Uint8Array) return JSON.stringify(`u8:${Buffer.from(v).toString("hex")}`);
  if (typeof v === "bigint") return JSON.stringify(`bigint:${v.toString()}`);
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v)
    .filter((k) => v[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
}
const digestOf = (v) => createHash("sha256").update(stableStringify(v), "utf8").digest("hex");

async function settle(fn) {
  try {
    const value = await fn();
    return { digest: digestOf(value), summary: summarize(value) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { digest: digestOf({ threw: message }), summary: `threw: ${message}` };
  }
}

function summarize(value) {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value && typeof value === "object") {
    if ("valid" in value) {
      const errs = (value.errors ?? []).map((e) => e.message).join(" | ");
      return `valid=${String(value.valid)}${errs ? ` errors=${errs}` : ""}`;
    }
    if ("integrity" in value) return `integrity=${String(value.integrity)}`;
  }
  return stableStringify(value).slice(0, 200);
}

// Mirror of runLibPaths in the harness.
async function runLibPaths(receipt) {
  const clone = () => JSON.parse(JSON.stringify(receipt));
  return {
    "verifier.verifyArtifact(default)": await settle(() => verifier.verifyArtifact(clone())),
    "crypto.verify(default)": await settle(() => crypto.verify(clone())),
    "crypto.verifyReceiptVerdict": await settle(() => crypto.verifyReceiptVerdict(clone())),
    "runtime/relay verifyExecutionReceipt": await settle(() => {
      const r = clone();
      return crypto.verifyExecutionReceipt(r, crypto.hexToBytes(r.public_key));
    }),
  };
}

const corpus = JSON.parse(readFileSync(corpusPath, "utf8"));
const cells = {};
for (const { cell, receipt, receiptDigest } of corpus) {
  cells[cell] = { receiptDigest, paths: await runLibPaths(receipt) };
}
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: mainRoot, encoding: "utf8" }).trim();
writeFileSync(outPath, `${JSON.stringify({ origin_main: sha, cells }, null, 2)}\n`);
console.log(`wrote ${Object.keys(cells).length} cells from origin/main ${sha}`);
