/**
 * Differential, property-based harness: every DEFAULT-mode receipt verifier
 * returns, for every receipt in the corpus, a verdict byte-identical — `valid`,
 * the error list, every field, or the same thrown message — to the base the
 * branch forked from (merge-base 4571d3b42, recorded in the golden).
 *
 *   paths:  crypto.verify (object / JSON string / expectedType), crypto.verifyReceipt
 *           (no options / {} / strictHashBinding:false), crypto.verifyReceiptVerdict,
 *           verifier.verifyArtifact (object / JSON string), verifier.verifyFile,
 *           and the runtime/relay signature check (crypto.verifyExecutionReceipt)
 *   corpus: every key spelling (hex in any case, partially-parseable pairs like
 *           "ag" / " a" / "+a" / "-a" / "zz", short / long, non-string, arrays)
 *           × every delegation_receipts shape ([], [null], non-objects, bad /
 *           keyless / lenient-key / lone-surrogate children, chains to the cap),
 *           plus a seeded fast-check sample over text (unpaired surrogates
 *           included), missing / extra fields, suites, signatures and result_hash
 *           (apps/cli/src/__tests__/helpers/default-verdict-corpus.ts)
 *
 * Strict hash binding is NOT in scope: it may reject what the base accepted.
 * The default may not change a single byte of a verdict until a major release
 * (docs/design/payment-receipt-wellformed-stop-condition.md §3).
 *
 * The golden is written by apps/cli/scripts/default-verdict-base-oracle.ts from
 * a built base checkout. Never regenerate it to make a cell pass.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import * as cryptoLib from "@motebit/crypto";
import { describe, expect, it } from "vitest";

import {
  DEFAULT_PATHS,
  FUZZ_RUNS,
  FUZZ_SEED,
  buildDefaultVerdictCorpus,
  digestOf,
  runDefaultPaths,
  short,
  type DefaultVerifierLibs,
  type Golden,
} from "./helpers/default-verdict-corpus.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..", "..");
const GOLDEN = JSON.parse(
  readFileSync(join(HERE, "fixtures", "default-verdict.base-verdicts.json"), "utf8"),
) as Golden;

const libs: DefaultVerifierLibs = {
  crypto: cryptoLib as unknown as DefaultVerifierLibs["crypto"],
  verifier: (await import(
    pathToFileURL(join(REPO, "packages", "verifier", "src", "index.ts")).href
  )) as DefaultVerifierLibs["verifier"],
};

const corpus = await buildDefaultVerdictCorpus();

describe("default-mode verdicts are byte-identical to the base", () => {
  it("the corpus is the one the golden was recorded from", () => {
    expect(GOLDEN.fuzz_seed).toBe(FUZZ_SEED);
    expect(GOLDEN.fuzz_runs).toBe(FUZZ_RUNS);
    expect(GOLDEN.paths).toEqual([...DEFAULT_PATHS]);
    expect(corpus.map((c) => c.name).sort()).toEqual(Object.keys(GOLDEN.cells).sort());
  });

  it.each(corpus.map((c) => [c.name, c.receipt] as const))("%s", async (name, receipt) => {
    const cell = GOLDEN.cells[name];
    expect(cell, `case ${name} missing from the golden`).toBeDefined();
    const [receiptDigest, digests, summaryIdx] = cell!;
    expect(short(digestOf(receipt)), "corpus receipt drifted from the golden").toBe(receiptDigest);
    const head = await runDefaultPaths(libs, receipt);
    const diverged = DEFAULT_PATHS.flatMap((p, i) =>
      short(head[p].digest) === digests[i]
        ? []
        : [`${p}\n    base: ${GOLDEN.summaries[summaryIdx[i]!]}\n    head: ${head[p].summary}`],
    );
    expect(diverged, `default verdict diverges from base on ${name}`).toEqual([]);
  });
});
