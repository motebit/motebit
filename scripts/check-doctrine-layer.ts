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
 *      informational, continue-on-error) is not enforcement and is rejected.
 *   4. Every other token is a path to a REGULAR FILE that exists and is
 *      either a test file (`*.test.ts(x)` / `*.spec.ts(x)`, or under
 *      `__tests__/`) or a source file under a package, app or service
 *      `src/`. A `scripts/check-*.ts` path is refused: a gate is named by its
 *      gate name, so the registration and advisory checks cannot be bypassed
 *      by naming its file.
 *
 * Scope: every `docs/doctrine/*.md` (top level; `docs/doctrine/audits/` holds
 * dated audit records, not doctrine) plus every root chain document parsed
 * from DOCTRINE.md with the same bullet regex `check-doctrine-format` and the
 * llms.txt generator use — so a tenth chain doc enters scope automatically.
 *
 * Out of scope: whether the named enforcement actually covers the doc's
 * central claims. That is a judgement made when the line is written and
 * reviewed; the gate proves the named enforcement exists and runs, never that
 * it is sufficient. Under-claiming (narrative) is always the safe direction.
 *
 * Usage:
 *   tsx scripts/check-doctrine-layer.ts        # exit 1 on violation
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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
const TEST_FILE_RE = /(?:\.(?:test|spec)\.tsx?$)|(?:(?:^|\/)__tests__\/)/;
/** A source file under a workspace package, app or service `src/`. */
const SOURCE_FILE_RE = /^(?:packages|apps|services)\/[^/]+\/src\/.+\.(?:ts|tsx|mts|js|mjs)$/;
/** A gate's own source: name the gate by its gate name instead. */
const GATE_PATH_RE = /^scripts\/check-[^/]+\.ts$/;
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
  return src
    .slice(start, end)
    .split("\n")
    .filter((l) => !/^\s*(?:\/\/|\/\*|\*)/.test(l))
    .join("\n");
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
): "law" | "narrative" | null {
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
  if (line === NARRATIVE_LINE) return "narrative";

  const law = LAW_RE.exec(line);
  if (!law) {
    findings.push({
      site,
      problem: `malformed layer line "${line}" — expected "${NARRATIVE_LINE}" or "> **Layer:** law — enforced by <comma-separated backticked gates/paths>"`,
    });
    return null;
  }
  const tokens = law[2]!.split(", ");
  for (const raw of tokens) {
    const tok = TOKEN_RE.exec(raw.trim())?.[1];
    if (!tok) {
      findings.push({
        site,
        problem: `enforcement entry "${raw}" is not a single backticked token`,
      });
      continue;
    }
    if (GATE_TOKEN_RE.test(tok)) {
      if (gates.advisory.has(tok)) {
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
    if (GATE_PATH_RE.test(tok)) {
      findings.push({
        site,
        problem: `\`${tok}\` is a gate's source path — name the gate by its gate name (\`${tok.slice("scripts/".length, -".ts".length)}\`) so its registration is checked`,
      });
      continue;
    }
    const isTest = TEST_FILE_RE.test(tok);
    if (!isTest && !SOURCE_FILE_RE.test(tok)) {
      findings.push({
        site,
        problem: `\`${tok}\` is neither a test file (\`*.test.ts\` / \`*.spec.ts\` or under \`__tests__/\`) nor a source file under a package, app or service \`src/\``,
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
  return "law";
}

export interface LayerReport {
  docs: string[];
  law: number;
  narrative: number;
  registeredGates: number;
  findings: Finding[];
}

/** The whole check over the tree at `root`; pure apart from reading files. */
export function checkDoctrineLayer(root: string): LayerReport {
  const gates = readRegisteredGates(root);
  const docs = docsInScope(root);
  const findings: Finding[] = [];
  let law = 0;
  let narrative = 0;
  for (const rel of docs) {
    const layer = checkDoc(root, rel, gates, findings);
    if (layer === "law") law++;
    else if (layer === "narrative") narrative++;
  }
  return { docs, law, narrative, registeredGates: gates.hard.size, findings };
}

function main(): void {
  process.stderr.write(
    "▸ check-doctrine-layer — every docs/doctrine/*.md and every DOCTRINE.md chain doc declares exactly one layer line after its H1 (`law — enforced by …` or `narrative`); every gate a law line names is registered in scripts/check.ts and every named test or source file exists as a regular file\n",
  );
  const r = checkDoctrineLayer(resolve(import.meta.dirname, ".."));

  if (r.findings.length === 0) {
    process.stderr.write(
      `✓ check-doctrine-layer: ${r.docs.length} doc(s) scanned (${r.law} law, ${r.narrative} narrative); every law line's enforcement resolves against ${r.registeredGates} registered gate(s) and the filesystem.\n`,
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
