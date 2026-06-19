#!/usr/bin/env tsx
/**
 * check-docs-quickstart-runs — executable-docs gate (docs as code).
 *
 * The developer Quickstart is the front door for cold third-party integrators
 * (and AI coding agents) building on motebit. Prose can drift from the packages
 * silently — we already shipped a real consumer bug from a "SHA-256 of the
 * canonical result" doc ambiguity. This gate closes that class structurally:
 *
 *   1. Extract the canonical mint→verify TypeScript snippet from
 *      apps/docs/content/docs/developer/quickstart.mdx (the one block that
 *      contains BOTH signExecutionReceipt and verifyArtifact).
 *   2. Run it, unmodified, against the REAL published @motebit/crypto +
 *      @motebit/verifier from the workspace.
 *   3. Assert it produces the result the page promises: a valid + sovereign
 *      receipt, and a tampered copy that fails verification.
 *
 * If the Quickstart's code stops compiling, stops running, or stops producing
 * the documented result, this fails — so the front-door integration can never
 * silently rot. The snippet a cold agent copies is the snippet CI proves.
 */
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const docPath = join(root, "apps/docs/content/docs/developer/quickstart.mdx");

function fail(msg: string): never {
  console.error(`✗ check-docs-quickstart-runs: ${msg}`);
  process.exit(1);
}

const doc = readFileSync(docPath, "utf8");

// Extract every ```typescript block; pick the one that is the full mint→verify loop.
const blocks = [...doc.matchAll(/```typescript\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
const snippet = blocks.find(
  (b) => b.includes("signExecutionReceipt") && b.includes("verifyArtifact"),
);
if (!snippet) {
  fail(
    "no runnable mint→verify TypeScript block found in quickstart.mdx " +
      "(expected one block importing signExecutionReceipt AND verifyArtifact). " +
      "If the page was restructured, update this gate to match the new canonical block.",
  );
}

// Write the EXACT snippet to a temp .mts inside @motebit/verify — the one
// workspace package whose node_modules resolves BOTH @motebit/crypto and
// @motebit/verifier (pnpm strict resolution). We run the doc's bytes, not a copy.
const runDir = join(root, "packages/verify");
const tmp = join(runDir, ".quickstart-check.mts");
writeFileSync(tmp, snippet);
try {
  const out = execFileSync("npx", ["tsx", tmp], {
    cwd: runDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const required = ["valid: true", "sovereign: true", "tampered valid: false"];
  const missing = required.filter((r) => !out.includes(r));
  if (missing.length > 0) {
    console.error("  Quickstart snippet ran, but its output did not match the documented result.");
    console.error(`  Missing expected line(s): ${missing.join("  |  ")}`);
    console.error("  Actual output:\n" + out.replace(/^/gm, "    "));
    console.error(
      "\n  Fix: the published @motebit/crypto + @motebit/verifier are the source of truth.\n" +
        "       Update the ```typescript block in apps/docs/content/docs/developer/quickstart.mdx\n" +
        "       so its real output matches the surrounding prose (or correct the prose claim to\n" +
        "       match the code's actual output) — the page must run unmodified to the documented result.\n",
    );
    fail("the Quickstart no longer produces the result the page claims");
  }
  console.log(
    "✓ check-docs-quickstart-runs: the Quickstart's mint→verify→tamper snippet executes " +
      "against the real @motebit/crypto + @motebit/verifier and produces the documented result " +
      "(receipt valid + sovereign; tampered copy rejected).",
  );
} catch (err) {
  const detail = err instanceof Error ? err.message : String(err);
  fail(
    "the Quickstart snippet failed to run against the published packages — " +
      "a cold integrator copying it would get broken code.\n  " +
      detail.replace(/\n/g, "\n  "),
  );
} finally {
  rmSync(tmp, { force: true });
}
