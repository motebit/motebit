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
 *        > **Layer:** law (<claim>; <claim>) — enforced by `check-x`, `path/to/x.test.ts`
 *      (a bare `law` with no scope is refused — see 5)
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
 *   5. A law line's scope is mandatory (`law (<claim>; <claim>)`), and
 *      every claim it lists has a live proof: an entry in the `PROOFS`
 *      exported by `scripts/tampers/doctrine-law-labels.ts` (imported, never
 *      scanned as text) with that `doc` and `claim` and a `named` item from
 *      the line. The entry breaks the claim and the shared tamper runner
 *      proves `named` goes red. No proof, no claim; a proof for a doc that is
 *      not law, a claim the scope does not list, or an item the line does
 *      not name is stale and fails too. A command-mode proof must run the
 *      item it names (`npx tsx <the gate's source>`, or the named test's
 *      package typecheck); a vitest-mode proof must name a test file.
 *      Static liveness: a proof's `edits` is non-empty, each edit's `from`
 *      occurs exactly once in its file, and a vitest proof's `red` is a
 *      test full name the named file declares. This proves a proof CAN
 *      bite; `node scripts/tampers/doctrine-law-labels.ts` proves it DOES
 *      (CI does not run the tampers yet). A
 *      gate's own check-gates-effective probe is NOT a proof — it breaks the
 *      gate's invariant, which is often narrower than the doc's claim.
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
/** A law line: the scope is MANDATORY — `law (<claim>; <claim>) — enforced by …`. A bare `law` is refused. */
const LAW_RE = /^> \*\*Layer:\*\* law \(([^)]+)\) — enforced by (.+)$/;
const TOKEN_RE = /^`([^`]+)`$/;
const GATE_TOKEN_RE = /^check-[a-z0-9-]+$/;
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
  if (line === NARRATIVE_LINE) return { layer: "narrative", tokens: [], claims: [] };

  const law = LAW_RE.exec(line);
  if (!law) {
    findings.push({
      site,
      problem: `malformed layer line "${line}" — expected "${NARRATIVE_LINE}" or "> **Layer:** law (<claim>; <claim>) — enforced by <comma-separated backticked gates/paths>" (the scope is mandatory)`,
    });
    return null;
  }
  const claims = law[1]!.split(";").map((c) => c.trim());
  if (claims.some((c) => c === "")) {
    findings.push({ site, problem: `law scope "${law[1]}" has an empty claim` });
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
  return { layer: "law", tokens: named, claims };
}

interface DocLayer {
  layer: "law" | "narrative";
  /** The backticked enforcement tokens a law line names (empty for narrative). */
  tokens: string[];
  /** The claims a law line's scope lists (empty for narrative). */
  claims: string[];
}

/** The recorded law proofs: `scripts/tampers/doctrine-law-labels.ts`. */
export const LAW_PROOFS_FILE = "scripts/tampers/doctrine-law-labels.ts";

/** One recorded law proof, as the gate reads it from the tamper file's live `PROOFS`. */
export interface LawProof {
  doc: string;
  claim: string;
  named: string;
  command?: string[];
  /** vitest mode: the exact full name of the test that must go red. */
  red?: string;
  /** The edits the tamper applies: `from` must occur exactly once in `file`. */
  edits: { file: string; from: string }[];
}

/**
 * The live `PROOFS` the law-proof tamper file exports — imported, never
 * scanned as text, so a commented-out entry or an unused array that merely
 * looks like a proof counts for nothing. The module guards its own run, so
 * importing it runs no tamper.
 */
export async function loadLawProofs(root: string): Promise<LawProof[]> {
  const abs = join(root, LAW_PROOFS_FILE);
  if (!existsSync(abs)) return [];
  const mod = (await import(pathToFileURL(abs).href)) as { PROOFS?: unknown };
  const raw: unknown[] = Array.isArray(mod.PROOFS) ? (mod.PROOFS as unknown[]) : [];
  const out: LawProof[] = [];
  for (const e of raw) {
    const r = e as Record<string, unknown>;
    if (typeof r.doc !== "string" || typeof r.claim !== "string" || typeof r.named !== "string") {
      continue;
    }
    const command =
      Array.isArray(r.command) && r.command.every((c) => typeof c === "string")
        ? (r.command as string[])
        : undefined;
    const edits = Array.isArray(r.edits)
      ? (r.edits as unknown[]).flatMap((x) => {
          const ed = x as Record<string, unknown>;
          return typeof ed.file === "string" && typeof ed.from === "string"
            ? [{ file: ed.file, from: ed.from }]
            : [];
        })
      : [];
    out.push({
      doc: r.doc,
      claim: r.claim,
      named: r.named,
      edits,
      ...(command ? { command } : {}),
      ...(typeof r.red === "string" ? { red: r.red } : {}),
    });
  }
  return out;
}

/** Exact occurrences of `needle` in `hay` (non-overlapping). */
function occurrences(hay: string, needle: string): number {
  return needle === "" ? 0 : hay.split(needle).length - 1;
}

/**
 * The titles of `describe(…)` and `it(…)` / `test(…)` calls in a test file, as
 * anchored patterns: a quoted title matches itself; a template-literal title's
 * `${…}` holes match any text (a generated case such as `rejects: ${name}`).
 */
function testTitles(src: string): { suites: RegExp[]; cases: RegExp[] } {
  const suites: RegExp[] = [];
  const cases: RegExp[] = [];
  const re = /\b(describe|it|test)(?:\.\w+)?\(\s*(["'`])((?:\\.|(?!\2)[^\\])*)\2/g;
  for (const m of src.matchAll(re)) {
    const title = m[3]!.replace(/\\(["'`\\])/g, "$1");
    const parts = m[2] === "`" ? title.split(/\$\{[^}]*\}/) : [title];
    const pattern = new RegExp(
      `^${parts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
      "s",
    );
    (m[1] === "describe" ? suites : cases).push(pattern);
  }
  return { suites, cases };
}

/** Whether `name` is a case title preceded by zero or more suite titles, space-joined. */
function isTestFullName(name: string, titles: { suites: RegExp[]; cases: RegExp[] }): boolean {
  // Every split point: `prefix` (suite titles) + " " + case title, or the whole name as a case.
  const splits = (text: string): [string, string][] => {
    const out: [string, string][] = [["", text]];
    for (let i = text.indexOf(" "); i >= 0; i = text.indexOf(" ", i + 1)) {
      out.push([text.slice(0, i), text.slice(i + 1)]);
    }
    return out;
  };
  const isSuitePath = (prefix: string): boolean =>
    prefix === "" ||
    splits(prefix).some(([head, tail]) =>
      head === ""
        ? titles.suites.some((d) => d.test(tail))
        : isSuitePath(head) && titles.suites.some((d) => d.test(tail)),
    );
  return splits(name).some(
    ([prefix, rest]) => titles.cases.some((c) => c.test(rest)) && isSuitePath(prefix),
  );
}

/**
 * Static liveness: a proof that cannot apply, or whose red test does not
 * exist, proves nothing even before the runner is run. Its edits must be
 * non-empty, each `from` must occur exactly once in its file, and in vitest
 * mode `red` must be a test full name (suite titles + case title) the named
 * test file declares.
 */
function proofLivenessProblem(root: string, p: LawProof): string | null {
  if (p.edits.length === 0) return "has no edits — a proof must break something";
  for (const e of p.edits) {
    const abs = join(root, e.file);
    const n = existsSync(abs) ? occurrences(readFileSync(abs, "utf-8"), e.from) : 0;
    if (n !== 1) {
      return `edit "${e.from.slice(0, 60)}" occurs ${n} time(s) in ${e.file} — a tamper edit must match exactly once`;
    }
  }
  if (!p.command) {
    const abs = join(root, p.named);
    const src = existsSync(abs) ? readFileSync(abs, "utf-8") : "";
    if (p.red === undefined || !isTestFullName(p.red, testTitles(src))) {
      return `its red test "${p.red ?? ""}" is not a test declared in ${p.named}`;
    }
  }
  return null;
}

/** The pnpm package name of the workspace package a repo path sits in (`packages/x/…` → its `name`). */
function packageNameOf(root: string, rel: string): string | null {
  const pj = join(root, rel.split("/").slice(0, 2).join("/"), "package.json");
  if (!existsSync(pj)) return null;
  try {
    return (JSON.parse(readFileSync(pj, "utf-8")) as { name?: string }).name ?? null;
  } catch {
    return null;
  }
}

/**
 * A proof's run must exercise the item it names. Command mode: a named gate
 * runs as exactly `npx tsx <its resolved source>`; a named test file runs as
 * its own package's `pnpm --filter <pkg> typecheck` (type-level tests).
 * vitest mode (no command): the named item must be a test file.
 */
function proofRunProblem(root: string, p: LawProof): string | null {
  if (p.command) {
    if (GATE_TOKEN_RE.test(p.named)) {
      const src = gateSource(root, p.named);
      const want = ["npx", "tsx", src ?? "<unresolved>"];
      return JSON.stringify(p.command) === JSON.stringify(want)
        ? null
        : `its command ${JSON.stringify(p.command)} does not run the gate it names (\`${p.named}\` runs as ${JSON.stringify(want)})`;
    }
    const pkg = packageNameOf(root, p.named);
    const want = ["pnpm", "--filter", pkg ?? "<unknown package>", "typecheck"];
    return JSON.stringify(p.command) === JSON.stringify(want)
      ? null
      : `its command ${JSON.stringify(p.command)} does not exercise \`${p.named}\` (expected ${JSON.stringify(want)})`;
  }
  return TEST_FILE_RE.test(p.named)
    ? null
    : `it runs vitest but names \`${p.named}\`, which is not a test file — a gate is proven in command mode`;
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
  claims: number;
  findings: Finding[];
}

/** The whole check over the tree at `root`; pure apart from reading files (and importing its proofs). */
export async function checkDoctrineLayer(root: string): Promise<LayerReport> {
  const gates = readRegisteredGates(root);
  const docs = docsInScope(root);
  const findings: Finding[] = [];
  let law = 0;
  let narrative = 0;
  const lawLines = new Map<string, { tokens: string[]; claims: string[] }>();
  for (const rel of docs) {
    const r = checkDoc(root, rel, gates, findings);
    if (r?.layer === "law") {
      law++;
      lawLines.set(docKey(rel), { tokens: r.tokens, claims: r.claims });
    } else if (r?.layer === "narrative") narrative++;
  }

  // Every claim a law line's scope lists rests on a recorded tamper proof: a
  // live PROOFS entry with that doc and claim, naming an item the line names,
  // that breaks the claim and turns the item red. No proof, no claim.
  const proofs = await loadLawProofs(root);
  let claims = 0;
  for (const [key, line] of lawLines) {
    for (const claim of line.claims) {
      claims++;
      if (
        !proofs.some((p) => p.doc === key && p.claim === claim && line.tokens.includes(p.named))
      ) {
        findings.push({
          site: key,
          problem: `claim "${claim}" has no recorded tamper proof — add a PROOFS entry in ${LAW_PROOFS_FILE} with doc "${key}", claim "${claim}" and a named item from its law line, or drop the claim from the scope`,
        });
      }
    }
  }
  // A proof must point at a live law label, one of its listed claims and one
  // of its named items, and its run must exercise that item — or it proves
  // nothing.
  for (const p of proofs) {
    const line = lawLines.get(p.doc);
    let problem: string | null = null;
    if (!line) problem = "points at a doc that is not a law doc";
    else if (!line.claims.includes(p.claim))
      problem = `claims "${p.claim}", which its law line's scope does not list`;
    else if (!line.tokens.includes(p.named))
      problem = `names \`${p.named}\`, which its law line does not name`;
    else problem = proofRunProblem(root, p) ?? proofLivenessProblem(root, p);
    if (problem) {
      findings.push({ site: LAW_PROOFS_FILE, problem: `proof for "${p.doc}" ${problem}` });
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
    claims,
    findings,
  };
}

async function main(): Promise<void> {
  process.stderr.write(
    "▸ check-doctrine-layer — every docs/doctrine/*.md and every DOCTRINE.md chain doc declares exactly one layer line after its H1 (`law (<claims>) — enforced by …` or `narrative`); every gate a law line names is registered in scripts/check.ts, every named test or source file exists as a regular file, and every scoped claim has a live tamper proof\n",
  );
  const r = await checkDoctrineLayer(resolve(import.meta.dirname, ".."));

  if (r.findings.length === 0) {
    process.stderr.write(
      `✓ check-doctrine-layer: ${r.docs.length} doc(s) scanned (${r.law} law, ${r.narrative} narrative); every law line's enforcement resolves against ${r.registeredGates} registered gate(s) (${r.scheduledProbes} scheduled external probe(s) refused) and the filesystem, and every one of the ${r.claims} scoped law claim(s) has a recorded tamper proof (${r.proofs} proof(s) in ${LAW_PROOFS_FILE}, each statically live).\n`,
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
        "`> **Layer:** law (<claim>; <claim>) — enforced by `check-x`, `path/to/x.test.ts`` naming only gates " +
        "registered in scripts/check.ts and files that exist, with a PROOFS entry in " +
        "scripts/tampers/doctrine-law-labels.ts for every listed claim. A claim without a proof leaves " +
        "the scope; if no claim is proven, change the line to narrative (under-claiming is the safe direction).",
      doctrine: "docs/doctrine/gate-repair-instructions.md",
    }),
  );
  process.exit(1);
}

// Run only when invoked directly; the unit test imports checkDoctrineLayer.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `check-doctrine-layer: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
