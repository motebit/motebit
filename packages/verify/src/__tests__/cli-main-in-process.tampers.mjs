#!/usr/bin/env node
// Tamper check for the in-process `motebit-verify` command-body tests
// (cli-main-in-process.test.ts, cli-bin-invocation.test.ts).
//
// These tests were written to graduate @motebit/verify's coverage
// (coverage-graduation.json). Coverage only says a line RAN; each entry below
// breaks one CLI behaviour in src/cli.ts and names the test that must go red,
// proving the new tests assert the behaviour rather than merely execute it.
// The shared runner (scripts/lib/tamper-runner.ts) applies each entry in an
// isolated copy of the tree; the working tree is never touched.
//
//   node packages/verify/src/__tests__/cli-main-in-process.tampers.mjs
//
// Run from anywhere; paths resolve relative to this file.

import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runTampers } from "../../../../scripts/lib/tamper-runner.ts";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "..");
const root = join(pkg, "..", "..");
const CLI = relative(root, join(pkg, "src", "cli.ts"));
const MAIN_TEST = relative(pkg, join(here, "cli-main-in-process.test.ts"));
const BIN_TEST = relative(pkg, join(here, "cli-bin-invocation.test.ts"));

const TAMPERS = [
  {
    // Rule 5: an unrecognized artifact is "can't process", not "bad signature".
    name: "unrecognized artifact exits 1 instead of 2",
    from: 'if (result.type === "unknown") return 2;',
    to: 'if (result.type === "unknown") return 1;',
    red: "main — verify mode an unrecognized artifact exits 2, not 1",
  },
  {
    // An unreadable file is an I/O error (2), never an invalid verdict (1).
    name: "a missing file reads as invalid (1) instead of I/O (2)",
    from: "process.stderr.write(`motebit-verify: cannot read ${args.file}: ${msg}\\n`);\n      return 2;",
    to: "process.stderr.write(`motebit-verify: cannot read ${args.file}: ${msg}\\n`);\n      return 1;",
    red: "main — verify mode a missing file is an I/O error: exit 2, `cannot read` on stderr",
  },
  {
    // The CLI is strict by default: result_hash must bind result.
    name: "strict-by-default dropped: CLI verifies signature-only",
    from: "strictHashBinding: args.strictHashBinding !== false,",
    to: "strictHashBinding: false,",
    red: "main — verify mode strict by default: an unbound result_hash is INVALID (exit 1), no lenient warning",
  },
  {
    // The --lenient warning is about receipts only.
    name: "lenient warning printed for non-receipts",
    from: 'if (args.lenient === true && result.type === "receipt")',
    to: "if (args.lenient === true)",
    red: "main — verify mode --lenient on a non-receipt prints no receipt warning",
  },
  {
    // `motebit-verify example` must resolve the bundled sample.
    name: "the `example` rewrite is lost",
    from: 'rawArgs[0] === "example" ? [resolveExamplePath()',
    to: 'rawArgs[0] === "sample" ? [resolveExamplePath()',
    red: "main — verify mode `example` verifies the bundled sample receipt (exit 0)",
  },
  {
    // content-artifact: the offline trust-anchor pin.
    name: "content-artifact ignores a mismatched --producer-key",
    from: "    args.expectedProducerKey !== undefined &&\n    manifest.producer_public_key.toLowerCase() !== args.expectedProducerKey\n",
    to: "    args.expectedProducerKey === undefined &&\n    manifest.producer_public_key.toLowerCase() !== args.expectedProducerKey\n",
    red: "main — content-artifact pinned --producer-key that differs: producer_key_mismatch, exit 1 (human)",
  },
  {
    // content-artifact: a forged inner receipt must fail the whole bundle.
    name: "inner-receipt failure no longer gates the exit code",
    from: "return result.valid && !innerFailed ? 0 : 1;",
    to: "return result.valid ? 0 : 1;",
    red: "main — content-artifact v1.1 execution-ledger with a forged inner receipt: outer valid, overall exit 1",
  },
  {
    // approval-decision: a pinned approver key that differs must reject.
    name: "approval-decision ignores a mismatched --producer-key",
    from: "    embedded !== args.expectedProducerKey\n  ) {",
    to: "    embedded === args.expectedProducerKey\n  ) {",
    red: "main — approval-decision a different pinned key: producer_key_mismatch names both keys, exit 1",
  },
  {
    // approval-decision: --expect-verdict must assert.
    name: "approval-decision ignores --expect-verdict",
    from: "if (args.expectedVerdict !== undefined && decision.verdict !== args.expectedVerdict) {",
    to: "if (args.expectedVerdict !== undefined && decision.verdict === args.expectedVerdict) {",
    red: "main — approval-decision --expect-verdict on the other value: verdict_mismatch, exit 1 (human)",
  },
  {
    // approval-decision: shape check before any key handling.
    name: "approval-decision drops the malformed-decision shape check",
    from: 'if (typeof decision !== "object" || decision === null || typeof decision.verdict !== "string") {',
    to: "if (decision === null) {",
    red: "main — approval-decision malformed decisions (no verdict, null, a scalar) are malformed_decision, exit 1",
  },
  {
    // isMainModule must decline (not throw, not run) on an unresolvable argv[1].
    name: "isMainModule treats an unresolvable argv[1] as the entry point",
    test: BIN_TEST,
    from: "    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);\n  } catch {\n    return false;",
    to: "    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1);\n  } catch {\n    return true;",
    red: "isMainModule (symlink-robust entry-point guard) returns false (never throws) when argv[1] does not resolve on disk",
  },
];

await runTampers(
  TAMPERS.map((t) => ({
    name: t.name,
    pkg: "@motebit/verify",
    test: t.test ?? MAIN_TEST,
    red: t.red,
    edits: [{ file: CLI, from: t.from, to: t.to }],
  })),
  { root },
);
