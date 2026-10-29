#!/usr/bin/env tsx
/**
 * check-doctrine-layer — every doctrine document declares which layer it is,
 * and every law declaration names enforcement that actually exists.
 *
 * Doctrine has two layers, split the way an RFC splits normative from
 * informative text (DOCTRINE.md § "Two layers"):
 *
 *   - **law** — the doc's central claims are enforced by a named gate, test
 *     file or code path. A reader may treat the doc as a decision procedure.
 *   - **narrative** — origin, lens and explanation. It informs; it does not
 *     decide.
 *
 * The 2026-10-29 doctrine audit found the corpus read uniformly as law while
 * only some of it was enforced: a reader could not tell a constitutional
 * claim backed by a gate from a lens nobody checks. A layer declaration makes
 * the difference visible, and this gate keeps the declaration honest — a law
 * line that names a gate which does not exist, or is not run, is the
 * "phantom enforcement" shape `check-gate-references` defends in CLAUDE.md,
 * applied to doctrine.
 *
 * What this gate enforces, for every doc in scope:
 *
 *   1. The first non-blank line after the H1 is a layer line, exactly one of
 *        > **Layer:** narrative
 *        > **Layer:** law — enforced by `check-x`, `path/to/x.test.ts`
 *        > **Layer:** law (scope) — enforced by `…`
 *      and the doc carries no second `> **Layer:**` line anywhere.
 *   2. A law line names at least one enforcement token, each backticked and
 *      comma-separated.
 *   3. Every `check-*` token is a gate registered in `scripts/check.ts` —
 *      inside the `GATES` array literal (run by `pnpm check`) or in
 *      `EXCLUDED_CHECKS` as a hard gate run by its own CI job; commented-out
 *      lines register nothing — and its root package.json script resolves
 *      to an existing file exactly as `pnpm check` launches it
 *      (`scripts/lib/gate-launch.ts`). An EXCLUDED_CHECKS entry whose reason
 *      says it does not block (soft, advisory, warn-only, non-blocking,
 *      informational, continue-on-error) is not enforcement and is rejected,
 *      and so is a scheduled external probe (`SCHEDULED_EXTERNAL_PROBES`:
 *      it runs on a schedule, never on a merge).
 *   4. Every other token is a normal repo-relative path (no leading `/`,
 *      no `.` / `..` / empty segment, unchanged by `path.posix.normalize`)
 *      to a REGULAR FILE that exists and is
 *      either a test file (`*.test.*` / `*.spec.*` — being under
 *      `__tests__/` is not enough) or a source file under a package, app or
 *      service `src/`. A `scripts/check-*.ts` path is refused: a gate is
 *      named by its gate name, so the registration and advisory checks
 *      cannot be bypassed by naming its file.
 *   5. Every law doc has a recorded tamper proof: an entry in
 *      `scripts/tampers/doctrine-law-labels.ts` whose `doc` is that doc and
 *      whose `named` is one of the items its law line names. The entry
 *      breaks the doc's claim (or its scoped claim) and the shared tamper
 *      runner proves `named` goes red. No entry, no law label; an entry for
 *      a doc that is not law, or naming an item its line does not name, is
 *      stale and fails too. A gate's own check-gates-effective probe is NOT
 *      such a proof — a probe breaks the gate's invariant, which is often
 *      narrower than the doc's claim.
 *
 * Scope: every `docs/doctrine/*.md` (top level; `docs/doctrine/audits/` holds
 * dated audit records, not doctrine) plus every root chain document parsed
 * from DOCTRINE.md with the same bullet regex `check-doctrine-format` and the
 * llms.txt generator use — so a tenth chain doc enters scope automatically.
 *
 * Out of scope: whether a recorded proof breaks the doc's CENTRAL claim (as
 * opposed to some claim). That is a judgement made when the proof is written
 * and reviewed; the gate proves a proof exists and points at a named item,
 * and the tamper runner proves the item goes red. Under-claiming (narrative,
 * or a narrower `law (<scope>)`) is always the safe direction.
 *
 * Usage:
 *   tsx scripts/check-doctrine-layer.ts        # exit 1 on violation
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveGateFiles } from "./lib/gate-launch.js";
import { formatRepair } from "./lib/gate-report.js";

const DOCTRINE_DIR = "docs/doctrine";
const CHECK_TS = "scripts/check.ts";

/** Same regex as scripts/check-doctrine-format.ts and scripts/generate-llms-txt.ts. */
const CHAIN_BULLET_RE = /^\d+\.\s+\*\*\[([^\]]+)\]\([^)]+\)\*\*\s+—\s+(.+)$/gm;

const LAYER_PREFIX = "> **Layer:**";
const NARRATIVE_LINE = "> **Layer:** narrative";
const LAW_RE = /^> \*\*Layer:\*\* law(?: \(([^)]+)\))? — enforced by (.+)$/;
const TOKEN_RE = /^`([^`]+)`$/;
const GATE_TOKEN_RE = /^check-[a-z0-9-]+$/;
/** A named test file: `*.test.ts(x)` / `*.spec.ts(x)`, or anything under `__tests__/`. */
/** A named test file: `*.test.*` / `*.spec.*` (ts, tsx, mts, js, mjs). Being under `__tests__/` is not enough. */
const TEST_FILE_RE = /\.(?:test|spec)\.(?:ts|tsx|mts|js|mjs)$/;
/** A source file under a workspace package, app or service `src/`. */
const SOURCE_FILE_RE = /^(?:packages|apps|services)\/[^/]+\/src\/.+\.(?:ts|tsx|mts|js|mjs)$/;
/** Test scaffolding (helpers, fixtures) lives under `__tests__/` but enforces nothing by itself. */
const TESTS_DIR_RE = /(?:^|\/)__tests__\//;
/** A gate's own source: name the gate by its gate name instead. */
const GATE_PATH_RE = /^scripts\/check-[^/]+\.ts$/;

/**
 * Scheduled EXTERNAL probes. Their canonical source lives outside the repo
 * (a live endpoint, the deployed fleet, a registry), so they run on a
 * schedule from their own workflow, never on a merge: a doc they "enforce"
 * can be broken and merged green. `EXCLUDED_CHECKS` carries no structured
 * schedule/trigger field to key on, so the set is named here, explicitly;
 * add a probe here when one joins the scheduled family in
 * docs/drift-defenses.md.
 */
const SCHEDULED_EXTERNAL_PROBES: ReadonlySet<string> = new Set([
  "check-model-catalog-drift", // weekly, .github/workflows/model-catalog-drift.yml
  "check-deploy-freshness", // daily, .github/workflows/deploy-freshness.yml
  "check-image-provenance", // daily, .github/workflows/image-provenance.yml
  "check-publish-freshness", // daily, .github/workflows/publish-freshness.yml
]);

/**
 * A path token must already be in normal repo-relative form: no leading `/`,
 * no backslash, no `.` / `..` / empty segment, and unchanged by
 * `path.posix.normalize`. The same no-traversal rule `resolveGateFiles`
 * applies to a gate's script path (scripts/lib/gate-launch.ts), stated as a
 * predicate here because that one is inline and not exported.
 */
function isNormalRepoPath(tok: string): boolean {
  if (tok.startsWith("/") || tok.includes("\\")) return false;
  if (tok.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return false;
  return posix.normalize(tok) === tok;
}
/**
 * `EXCLUDED_CHECKS` is `Record<string, string>` — there is no structured
 * hard/soft field, so the reason text decides. Any wording that says the
 * check does not block counts as advisory.
 */
const ADVISORY_RE =
  /\bsoft\b|advisory|warn(?:ing)?[- ]only|non[- ]blocking|informational|continue-on-error/i;

export interface RegisteredGates {
  hard: Set<string>;
  advisory: Set<string>;
}

/**
 * The text of the literal that starts at `marker` (`const GATES … = [` or
 * `const EXCLUDED_CHECKS … = {`) up to its closing line (`];` / `};` at
 * column 0), with comment lines removed so a commented-out entry never
 * registers.
 */
function literalBlock(src: string, marker: string, close: string): string {
  const start = src.indexOf(marker);
  const end = start < 0 ? -1 : src.indexOf(`\n${close}`, start);
  if (start < 0 || end < 0) throw new Error(`${CHECK_TS}: could not find the ${marker} literal`);
  return (
    src
      .slice(start, end)
      // Block comments that open a line (a commented-out entry, possibly
      // spanning lines). Anchored at line start so a `/*` inside a string
      // literal (`/api/v1/admin/*`) is never read as a comment opener.
      .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l))
      .join("\n")
  );
}

/** GATES and EXCLUDED_CHECKS as `scripts/check.ts` under `root` declares them. */
export function readRegisteredGates(root: string): RegisteredGates {
  const src = readFileSync(join(root, CHECK_TS), "utf-8");
  const hard = new Set<string>();
  const advisory = new Set<string>();

  const gates = literalBlock(src, "const GATES", "];");
  for (const m of gates.matchAll(/script:\s*"(check-[a-z0-9-]+)"/g)) {
    hard.add(m[1]!);
  }

  const block = literalBlock(src, "const EXCLUDED_CHECKS", "};");
  // Each entry: `"check-x":` then its reason string(s) up to the next entry.
  const entries = [...block.matchAll(/"(check-[a-z0-9-]+)":/g)];
  entries.forEach((m, i) => {
    const reason = block.slice(m.index! + m[0].length, entries[i + 1]?.index ?? block.length);
    (ADVISORY_RE.test(reason) ? advisory : hard).add(m[1]!);
  });
  return { hard, advisory };
}

/** Every `docs/doctrine/*.md` (top level) plus every chain doc DOCTRINE.md lists. */
export function docsInScope(root: string): string[] {
  const doctrine = readdirSync(join(root, DOCTRINE_DIR))
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => `${DOCTRINE_DIR}/${f}`);
  const chainSrc = readFileSync(join(root, "DOCTRINE.md"), "utf-8");
  const chain = [...chainSrc.matchAll(CHAIN_BULLET_RE)].map((m) => m[1]!);
  return [...doctrine, ...chain];
}

/** The gate source file, resolved exactly as `pnpm check` launches it (scripts/lib/gate-launch.ts). */
function gateSource(root: string, name: string): string | null {
  try {
    return resolveGateFiles(root, [name]).get(name) ?? null;
  } catch {
    return null;
  }
}

export interface Finding {
  site: string;
  problem: string;
}

function checkDoc(
  root: string,
  rel: string,
  gates: RegisteredGates,
  findings: Finding[],
): DocLayer | null {
  const path = join(root, rel);
  if (!existsSync(path)) {
    findings.push({ site: rel, problem: "listed in scope but the file does not exist" });
    return null;
  }
  const lines = readFileSync(path, "utf-8").split("\n");
  const h1 = lines.findIndex((l) => /^# /.test(l));
  if (h1 < 0) {
    findings.push({
      site: rel,
      problem: "no H1 found, so there is nowhere to anchor the layer line",
    });
    return null;
  }

  const layerLines = lines.map((l, i) => ({ l, i })).filter(({ l }) => l.startsWith(LAYER_PREFIX));
  if (layerLines.length > 1) {
    findings.push({
      site: `${rel}:${layerLines[1]!.i + 1}`,
      problem: `${layerLines.length} layer lines; exactly one is allowed`,
    });
  }

  let next = h1 + 1;
  while (next < lines.length && lines[next]!.trim() === "") next++;
  const line = lines[next] ?? "";
  const site = `${rel}:${next + 1}`;
  if (!line.startsWith(LAYER_PREFIX)) {
    findings.push({
      site,
      problem: "the first non-blank line after the H1 is not a `> **Layer:**` line",
    });
    return null;
  }
  if (line === NARRATIVE_LINE) return { layer: "narrative", tokens: [] };

  const law = LAW_RE.exec(line);
  if (!law) {
    findings.push({
      site,
      problem: `malformed layer line "${line}" — expected "${NARRATIVE_LINE}" or "> **Layer:** law — enforced by <comma-separated backticked gates/paths>"`,
    });
    return null;
  }
  const tokens = law[2]!.split(", ");
  const named: string[] = [];
  for (const raw of tokens) {
    const tok = TOKEN_RE.exec(raw.trim())?.[1];
    if (!tok) {
      findings.push({
        site,
        problem: `enforcement entry "${raw}" is not a single backticked token`,
      });
      continue;
    }
    named.push(tok);
    if (GATE_TOKEN_RE.test(tok)) {
      if (SCHEDULED_EXTERNAL_PROBES.has(tok)) {
        findings.push({
          site,
          problem: `gate \`${tok}\` is a scheduled external probe — it runs on a schedule, never on a merge, so a broken claim can merge green; it enforces nothing at merge time`,
        });
      } else if (gates.advisory.has(tok)) {
        findings.push({
          site,
          problem: `gate \`${tok}\` is registered as soft/advisory in EXCLUDED_CHECKS, so it enforces nothing`,
        });
      } else if (!gates.hard.has(tok)) {
        findings.push({
          site,
          problem: `gate \`${tok}\` is not registered in ${CHECK_TS} (neither GATES nor EXCLUDED_CHECKS)`,
        });
      } else if (gateSource(root, tok) === null) {
        findings.push({
          site,
          problem: `gate \`${tok}\` has no runnable source (root package.json script must be \`npx tsx scripts/<file>.ts\` naming an existing file)`,
        });
      }
      continue;
    }
    if (!isNormalRepoPath(tok)) {
      findings.push({
        site,
        problem: `\`${tok}\` is not a normal repo-relative path — no leading \`/\`, no \`.\` / \`..\` / empty segment, and unchanged by path normalization`,
      });
      continue;
    }
    if (GATE_PATH_RE.test(tok)) {
      findings.push({
        site,
        problem: `\`${tok}\` is a gate's source path — name the gate by its gate name (\`${tok.slice("scripts/".length, -".ts".length)}\`) so its registration is checked`,
      });
      continue;
    }
    const isTest = TEST_FILE_RE.test(tok);
    if (!isTest && (TESTS_DIR_RE.test(tok) || !SOURCE_FILE_RE.test(tok))) {
      findings.push({
        site,
        problem: `\`${tok}\` is neither a test file (\`*.test.*\` / \`*.spec.*\`) nor a source file under a package, app or service \`src/\` (a non-test file under \`__tests__/\` is neither)`,
      });
      continue;
    }
    const kind = isTest ? "test file" : "source file";
    const abs = join(root, tok);
    if (!existsSync(abs)) {
      findings.push({ site, problem: `named ${kind} \`${tok}\` does not exist` });
    } else if (!statSync(abs).isFile()) {
      findings.push({ site, problem: `named ${kind} \`${tok}\` is not a regular file` });
    }
  }
  return { layer: "law", tokens: named };
}

interface DocLayer {
  layer: "law" | "narrative";
  /** The backticked enforcement tokens a law line names (empty for narrative). */
  tokens: string[];
}

/** The recorded law proofs: `scripts/tampers/doctrine-law-labels.ts`. */
export const LAW_PROOFS_FILE = "scripts/tampers/doctrine-law-labels.ts";

/**
 * Every `{ doc: "…", named: "…", … }` entry in the law-proof tamper file
 * (comment lines may sit between `{` and `doc`). The tamper file is the
 * executable record (each entry breaks the doc's claim and the shared runner
 * proves `named` goes red); this gate reads it statically so a law label can
 * never exist without one. `doc` and `named` must be the first two keys, as
 * string literals.
 */
export function readLawProofs(root: string): { doc: string; named: string }[] {
  const abs = join(root, LAW_PROOFS_FILE);
  if (!existsSync(abs)) return [];
  const src = readFileSync(abs, "utf-8");
  return [...src.matchAll(/\{\s*(?:\/\/[^\n]*\n\s*)*doc:\s*"([^"]+)",\s*named:\s*"([^"]+)"/g)].map(
    (m) => ({
      doc: m[1]!,
      named: m[2]!,
    }),
  );
}

/** The key a proof uses for a doc: `docs/doctrine/x.md` → `x`, a chain doc keeps its filename. */
export function docKey(rel: string): string {
  return rel.startsWith(`${DOCTRINE_DIR}/`)
    ? rel.slice(DOCTRINE_DIR.length + 1, -".md".length)
    : rel;
}

export interface LayerReport {
  docs: string[];
  law: number;
  narrative: number;
  registeredGates: number;
  scheduledProbes: number;
  proofs: number;
  findings: Finding[];
}

/** The whole check over the tree at `root`; pure apart from reading files. */
export function checkDoctrineLayer(root: string): LayerReport {
  const gates = readRegisteredGates(root);
  const docs = docsInScope(root);
  const findings: Finding[] = [];
  let law = 0;
  let narrative = 0;
  const lawTokens = new Map<string, string[]>();
  for (const rel of docs) {
    const r = checkDoc(root, rel, gates, findings);
    if (r?.layer === "law") {
      law++;
      lawTokens.set(docKey(rel), r.tokens);
    } else if (r?.layer === "narrative") narrative++;
  }

  // Every law label rests on a recorded tamper proof: an entry in the
  // law-proof tamper file that breaks the doc's claim and turns one of the
  // items its law line names red. No entry, no law label.
  const proofs = readLawProofs(root);
  for (const [key, tokens] of lawTokens) {
    if (!proofs.some((p) => p.doc === key && tokens.includes(p.named))) {
      findings.push({
        site: key,
        problem: `law label has no recorded tamper proof — no \`{ doc: "${key}", named: <one of its named items>, … }\` entry in ${LAW_PROOFS_FILE} that breaks its claim and turns that item red`,
      });
    }
  }
  // A proof must point at a live law label and one of its named items, or it
  // proves nothing (the doc was relabelled, or the item was dropped).
  for (const p of proofs) {
    const tokens = lawTokens.get(p.doc);
    if (!tokens) {
      findings.push({
        site: LAW_PROOFS_FILE,
        problem: `proof for "${p.doc}" points at a doc that is not a law doc`,
      });
    } else if (!tokens.includes(p.named)) {
      findings.push({
        site: LAW_PROOFS_FILE,
        problem: `proof for "${p.doc}" names \`${p.named}\`, which its law line does not name`,
      });
    }
  }

  const scheduledProbes = [...gates.hard].filter((g) => SCHEDULED_EXTERNAL_PROBES.has(g)).length;
  return {
    docs,
    law,
    narrative,
    registeredGates: gates.hard.size - scheduledProbes,
    scheduledProbes,
    proofs: proofs.length,
    findings,
  };
}

function main(): void {
  process.stderr.write(
    "▸ check-doctrine-layer — every docs/doctrine/*.md and every DOCTRINE.md chain doc declares exactly one layer line after its H1 (`law — enforced by …` or `narrative`); every gate a law line names is registered in scripts/check.ts and every named test or source file exists as a regular file\n",
  );
  const r = checkDoctrineLayer(resolve(import.meta.dirname, ".."));

  if (r.findings.length === 0) {
    process.stderr.write(
      `✓ check-doctrine-layer: ${r.docs.length} doc(s) scanned (${r.law} law, ${r.narrative} narrative); every law line's enforcement resolves against ${r.registeredGates} registered gate(s) (${r.scheduledProbes} scheduled external probe(s) refused) and the filesystem, and every law doc has a recorded tamper proof (${r.proofs} proof(s) in ${LAW_PROOFS_FILE}).\n`,
    );
    return;
  }

  process.stderr.write(
    formatRepair({
      invariant: `check-doctrine-layer: ${r.findings.length} violation(s) across ${r.docs.length} doc(s) scanned`,
      sites: r.findings.map((f) => `${f.site} — ${f.problem}`),
      canonical:
        'DOCTRINE.md § "Two layers" (the rule) and scripts/check.ts (the registered gates)',
      fix:
        "put exactly one layer line directly after the H1 — `> **Layer:** narrative`, or " +
        "`> **Layer:** law — enforced by `check-x`, `path/to/x.test.ts`` naming only gates " +
        "registered in scripts/check.ts and files that exist. If the named enforcement is gone or " +
        "never existed, change the line to narrative (under-claiming is the safe direction).",
      doctrine: "docs/doctrine/gate-repair-instructions.md",
    }),
  );
  process.exit(1);
}

// Run only when invoked directly; the unit test imports checkDoctrineLayer.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
