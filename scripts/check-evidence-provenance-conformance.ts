/**
 * Cross-implementation evidence-provenance conformance — the evidence-axis analog
 * of check-receipt-conformance.
 *
 * Doctrine (docs/doctrine/agency-proof-integration.md §9, docs/doctrine/evidence-provenance.md):
 * "same fixture → same verdict across implementations" is the PLATFORM's guarantee.
 * The receipt gate proves it for SIGNATURES; this gate proves it for EVIDENCE —
 * that `verifyEvidenceProvenance` is a real cross-language protocol, not a
 * TypeScript feature, exactly where an external auditor probes ("verify in any
 * language, no relay, offline").
 *
 * Every committed vector in spec/conformance/evidence-provenance/corpus.json must
 * produce the SAME structured result across:
 *
 *   - @motebit/crypto   verifyEvidenceProvenance   — the floor primitive
 *   - the Python reference (examples/python-receipt-verifier/verify_evidence_provenance.py)
 *
 * and both must equal the corpus's `expected`. The recipe path also proves the
 * published `agency.html-text.v1` projection reproduces byte-for-byte across TS +
 * Python (the §7 byte-determinism guarantee surviving a language boundary).
 *
 * The Python leg needs NO signing library (evidence-provenance is sha-256 +
 * substring), so it is stdlib-only and runs wherever python3 exists. Best-effort
 * unless REQUIRE_PYTHON=1 (CI), where it is mandatory.
 *
 * Requires @motebit/crypto + @motebit/tools built (CI runs `pnpm build` first).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

type EvidenceResult =
  | { present: true }
  | { present: false; reason: "digest_mismatch" | "projection_unresolved" | "span_absent" };

interface Case {
  name: string;
  input: {
    bytes_utf8: string;
    provenance: { digest: { algorithm: string; value: string }; span: string; projection?: string };
    resolvable_recipes?: string[];
  };
  expected: EvidenceResult;
}

const eq = (a: EvidenceResult, b: EvidenceResult): boolean => {
  // If either is present, equality is just present-vs-present. Otherwise both are
  // the `present: false` variant and TS narrows both, so `.reason` is in scope.
  if (a.present || b.present) return a.present === b.present;
  return a.reason === b.reason;
};

const show = (r: EvidenceResult | null): string =>
  r === null ? "n/a" : r.present ? "present" : `absent:${r.reason}`;

async function main(): Promise<void> {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const corpusPath = join(repoRoot, "spec/conformance/evidence-provenance/corpus.json");
  const verifyPy = join(repoRoot, "examples/python-receipt-verifier/verify_evidence_provenance.py");

  const crypto = await import(join(repoRoot, "packages/crypto/dist/index.js"));
  const tools = await import(join(repoRoot, "packages/tools/dist/index.js"));
  const projectHtml = tools.projectAgencyHtmlTextV1 as (b: Uint8Array) => string;
  const RECIPE = tools.AGENCY_HTML_TEXT_V1_RECIPE_ID as string;

  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as { cases: Case[] };
  const failures: string[] = [];
  const note = (m: string) => console.log(`  ${m}`);

  console.log(
    `▸ check-evidence-provenance-conformance — ${corpus.cases.length} vectors × {crypto, python}`,
  );

  // Python leg (stdlib-only; best-effort unless REQUIRE_PYTHON=1).
  const requirePython = process.env.REQUIRE_PYTHON === "1";
  const py = spawnSync("python3", [verifyPy, corpusPath], { encoding: "utf8" });
  let pyByName: Map<string, EvidenceResult> | null = null;
  if (py.status === 0) {
    try {
      const arr = JSON.parse(py.stdout) as Array<{ name: string } & EvidenceResult>;
      pyByName = new Map(
        arr.map((r) => [
          r.name,
          { present: r.present, reason: (r as { reason?: string }).reason } as EvidenceResult,
        ]),
      );
    } catch {
      pyByName = null;
    }
  }
  if (pyByName === null) {
    const msg = `python leg unavailable (${(py.stderr || py.error?.message || "non-zero exit").split("\n")[0]})`;
    if (requirePython) failures.push(`REQUIRE_PYTHON=1 but ${msg}`);
    else note(`skipping python leg: ${msg} — covered by the python-receipt-verifier CI job`);
  }

  // Build a resolver that owns exactly the case's resolvable recipes (resolver
  // totality: a recipe NOT listed gets no resolver, so the law fails closed with
  // projection_unresolved — never a throwing resolver as a "not supported" signal).
  const buildResolver = (
    recipes: string[],
  ): ((id: string, bytes: Uint8Array) => string) | undefined => {
    if (recipes.length === 0) return undefined;
    return (id: string, bytes: Uint8Array): string => {
      if (id === RECIPE && recipes.includes(id)) return projectHtml(bytes);
      throw new Error(`resolver does not own recipe ${id}`);
    };
  };

  for (const c of corpus.cases) {
    const bytes = new TextEncoder().encode(c.input.bytes_utf8);
    const resolver = buildResolver(c.input.resolvable_recipes ?? []);
    const ts = (await crypto.verifyEvidenceProvenance(
      bytes,
      c.input.provenance,
      resolver ? { resolveProjection: resolver } : undefined,
    )) as EvidenceResult;
    const pyR = pyByName?.get(c.name) ?? null;

    if (!eq(ts, c.expected)) {
      failures.push(`${c.name}: crypto=${show(ts)} but expected=${show(c.expected)}`);
    }
    if (pyR !== null && !eq(pyR, c.expected)) {
      failures.push(`${c.name}: python=${show(pyR)} but expected=${show(c.expected)}`);
    }
    if (pyR !== null && !eq(ts, pyR)) {
      failures.push(`${c.name}: cross-impl DISAGREEMENT — crypto=${show(ts)} python=${show(pyR)}`);
    }

    console.log(
      `  ${c.name.padEnd(30)} crypto:${show(ts).padEnd(24)}${pyR === null ? "" : `python:${show(pyR)}`}`,
    );
  }

  if (failures.length > 0) {
    console.error(`\n✗ check-evidence-provenance-conformance: ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    console.error(
      "\nFix: every implementation applies the SAME law — digest (sha-256) FIRST, then the\n" +
        "     injected projection seam (absent ⇒ raw bytes; resolvable ⇒ apply recipe; not\n" +
        "     resolvable ⇒ projection_unresolved), then exact-substring presence. The\n" +
        "     `crypto=`/`python=` flags name the dissenting surface:\n" +
        "       • crypto  → packages/crypto/src/index.ts (verifyEvidenceProvenance)\n" +
        "       • python  → examples/python-receipt-verifier/verify_evidence_provenance.py\n" +
        "     A recipe-path disagreement usually means the two agency.html-text.v1 impls\n" +
        "     diverged — re-derive from spec §2 (ASCII-only whitespace, single-pass entity\n" +
        "     decode); never loosen a vector to make a divergence pass. Corpus:\n" +
        "     spec/conformance/evidence-provenance/corpus.json (+ README).",
    );
    process.exit(1);
  }
  console.log(
    `\n✓ check-evidence-provenance-conformance: all ${corpus.cases.length} vectors agree on the structured result${pyByName ? " (incl. Python reference — cross-language)" : ""}; agency.html-text.v1 reproduces byte-for-byte.`,
  );
}

main().catch((e) => {
  console.error("check-evidence-provenance-conformance crashed:", e);
  process.exit(1);
});
