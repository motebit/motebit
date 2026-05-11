#!/usr/bin/env tsx
/**
 * check-doctrine-citations — drift defense for "doctrine cites code"
 * link integrity.
 *
 * Doctrine docs at `docs/doctrine/*.md` are the architectural prose
 * layer over the codebase: every load-bearing claim ("the negative
 * proof lives at X", "drift defense Y verifies the rule", "the canonical
 * implementation in Z") is a *citation* into either a source file or
 * a drift gate. When code moves (package extraction, gate rename),
 * those citations rot silently — the doctrine still reads coherent,
 * but the file at the cited path doesn't exist anymore, and the
 * "gate Y" sentence has no Y to anchor.
 *
 * The 2026-05-10 architectural audit found three such drifts shipping
 * in production doctrine:
 *
 *   - `agility-as-role.md:28` cited two gates that never existed
 *     (`check-floor-license`, `check-package-license`). Actual gate
 *     is `check-license-doc-sync.ts`.
 *   - `settlement-rails.md:19` cited `services/relay/src/__tests__/
 *     custody-boundary.test.ts`. The test moved to
 *     `packages/settlement-rails/src/__tests__/custody-boundary.test.ts`
 *     when settlement rails extracted to its own package; the
 *     doctrine citation stayed put.
 *   - `self-attesting-system.md:59` repeated the same stale relay
 *     path.
 *
 * Same drift class as `check-readme-bin-claims` (README `npm i -g`
 * snippets that name bin-less packages), `check-docs-cli-claims`
 * (docs reference `motebit <subcommand>` invocations that don't
 * exist), and `check-docs-slash-claims` (docs reference `/<slash>`
 * commands not in `args.ts:COMMANDS`). Fourth member of the doc-
 * citation-validation family; same enforcement shape.
 *
 * What this gate enforces:
 *
 *   1. Every backtick-delimited path-shaped reference in
 *      `docs/doctrine/*.md` that contains at least one `/` and ends
 *      in `.ts`, `.tsx`, `.md`, `.json`, `.toml`, or `.js` resolves
 *      to a real file. The slash requirement excludes plural
 *      generic references (`package.json`, `LICENSE.md`) that name
 *      a class of file rather than a specific path.
 *
 *   2. Every backtick-delimited `check-X` (or `check-X.ts`) reference
 *      resolves to either a real `scripts/check-X.ts` source file OR
 *      a registered `check-X` script in root `package.json`.
 *
 * Out of scope:
 *
 *   - Function/symbol names. Would require resolving the named
 *     export against dist surfaces — invasive and slow for line-rate
 *     CI. Symbol drift is a separate class with a separate defense
 *     (api-extractor baselines on the published packages).
 *   - External URLs.
 *   - Cross-references to other doctrine docs (already validated by
 *     `check-claude-md` for the lazy-load index).
 *   - Section anchors (`docs/foo.md#section-name`).
 *
 * Usage:
 *   tsx scripts/check-doctrine-citations.ts        # exit 1 on violation
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const DOCTRINE_DIR = join(REPO_ROOT, "docs/doctrine");
const SCRIPTS_DIR = join(REPO_ROOT, "scripts");

/**
 * File extensions a path-shaped reference may end in. Conservative
 * — only the formats actually used in source citations. Adding
 * extensions (`.sh`, `.rs`, etc.) is safe; over-broad coverage just
 * means more accurate failure messages when references land for
 * those file types.
 */
const PATH_EXTENSIONS = ["ts", "tsx", "md", "json", "toml", "js", "mdx", "yml", "yaml"];

/**
 * Match a backtick-delimited path: at least one `/` (so plural
 * filenames like `package.json` don't false-positive), ending in a
 * known extension. Captures the path in group 1. The leading
 * character class excludes `/` so URL-style absolute paths
 * (`/.well-known/motebit-transparency.json`) don't match — those
 * are URL roots, not filesystem references.
 */
const PATH_PATTERN = new RegExp(
  "`([a-zA-Z0-9_.-][a-zA-Z0-9_./-]*/[a-zA-Z0-9_./-]+\\.(?:" + PATH_EXTENSIONS.join("|") + "))`",
  "g",
);

/**
 * Match a backtick-delimited `check-X` or `check-X.ts` reference.
 * The hyphen-trailing pattern is distinctive enough that prose-only
 * mentions of the literal string "check" don't false-positive.
 */
const GATE_PATTERN = /`(check-[a-z0-9-]+)(?:\.ts)?`/g;

/**
 * Allowlist of gate-name strings that the regex matches but
 * intentionally don't resolve to a current drift gate. Each entry
 * names a reason. Two legitimate classes:
 *
 *   - Anticipated future gate: the doctrine names a gate that doesn't
 *     yet exist but will land when a specific condition is met
 *     (`check-coverage-graduation` for the soft-to-hard transition).
 *   - Historical gate: the doctrine references a former gate by its
 *     prior name in a retrospective sense. None today; pattern
 *     reserved.
 */
const GATE_ALLOWLIST: Record<string, string> = {
  "check-coverage-graduation":
    "anticipated future gate — coverage-graduation doctrine names this as the hard-fail name for the soft-signal coverage report when escalation criteria fire (a date missed twice without rationale). Land when conditions are met; until then, the reference is forward-looking.",
};

/**
 * Paths the gate accepts even though the file doesn't physically
 * exist at the cited location. Two legitimate classes:
 *
 *   - Anticipated future artifact: the doctrine names a spec or
 *     store path that will land when a specific condition is met
 *     (e.g. `spec/retention-policy-v1.md` lands when a second operator
 *     forces field standardization). Forward-looking by design.
 *   - Historical reference: the doctrine describes a now-deleted file
 *     in past tense ("Net: X deleted"); the reference is the artifact
 *     of the deletion narrative, not a live path.
 *
 * Each entry MUST carry a one-line reason naming which class it
 * belongs to. Adding to this allowlist is intentional: a typo or
 * stale reference should be fixed in the doctrine, not waived here.
 */
const PATH_ALLOWLIST: Record<string, string> = {
  "spec/relay-transparency-v1.md":
    "anticipated future spec (stage 2 of operator-transparency doctrine) — wire format that lands when a second motebit-compatible operator forces field standardization. Until then, the doctrine names what the spec will be called.",
  "spec/retention-policy-v1.md":
    "anticipated future spec (stage 2 of retention-policy doctrine) — same deferral shape as operator-transparency; lands when a second store family forces field standardization.",
  "packages/runtime/src/housekeeping.ts":
    "historical reference — proactive-interior doctrine describes the file's deletion in past tense ('Net: housekeeping.ts deleted'). The narrative wouldn't read coherently without the cited name.",
};

interface Finding {
  doc: string;
  line: number;
  kind: "missing-path" | "unknown-gate";
  reference: string;
  context: string;
}

function walkDoctrineMd(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(DOCTRINE_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(join(DOCTRINE_DIR, entry.name));
    }
  }
  return out;
}

/**
 * Build the set of valid gate names: every `check-*.ts` in scripts/
 * + every `check-*` script registered in root package.json. Two
 * sources because they sometimes diverge: a TS file can exist
 * without being wired to a script (uncommon, but possible during
 * development), and a script can exist as an npm alias for a
 * different file.
 */
function buildValidGateSet(): Set<string> {
  const valid = new Set<string>();
  // Source 1: scripts/check-*.ts
  for (const entry of readdirSync(SCRIPTS_DIR, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.startsWith("check-") &&
      (entry.name.endsWith(".ts") || entry.name.endsWith(".sh"))
    ) {
      const stripped = entry.name.replace(/\.(ts|sh)$/, "");
      valid.add(stripped);
    }
  }
  // Source 2: root package.json scripts
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as {
    scripts?: Record<string, string>;
  };
  for (const name of Object.keys(pkg.scripts ?? {})) {
    if (name.startsWith("check-")) valid.add(name);
  }
  return valid;
}

function scanDoc(abs: string, validGates: Set<string>): Finding[] {
  const rel = relative(REPO_ROOT, abs);
  const src = readFileSync(abs, "utf-8");
  const lines = src.split("\n");
  const findings: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Path-shaped references.
    PATH_PATTERN.lastIndex = 0;
    let pathMatch: RegExpExecArray | null;
    while ((pathMatch = PATH_PATTERN.exec(line)) !== null) {
      const cited = pathMatch[1]!;
      if (cited in PATH_ALLOWLIST) continue;
      const abs = resolve(REPO_ROOT, cited);
      if (existsSync(abs)) continue;
      findings.push({
        doc: rel,
        line: i + 1,
        kind: "missing-path",
        reference: cited,
        context: line.trim(),
      });
    }

    // Gate-name references.
    GATE_PATTERN.lastIndex = 0;
    let gateMatch: RegExpExecArray | null;
    while ((gateMatch = GATE_PATTERN.exec(line)) !== null) {
      const cited = gateMatch[1]!;
      if (cited in GATE_ALLOWLIST) continue;
      if (validGates.has(cited)) continue;
      findings.push({
        doc: rel,
        line: i + 1,
        kind: "unknown-gate",
        reference: cited,
        context: line.trim(),
      });
    }
  }

  return findings;
}

function main(): void {
  let dirOk = true;
  try {
    statSync(DOCTRINE_DIR);
  } catch {
    dirOk = false;
  }
  if (!dirOk) {
    console.log("check-doctrine-citations: docs/doctrine/ does not exist; nothing to check.");
    return;
  }

  const validGates = buildValidGateSet();
  const docs = walkDoctrineMd();
  const findings = docs.flatMap((d) => scanDoc(d, validGates));

  console.log(
    `check-doctrine-citations — scanned ${docs.length} doctrine doc(s) against ${validGates.size} valid gate names + the filesystem\n`,
  );

  if (findings.length === 0) {
    console.log(
      "✓ Every path-shaped and `check-X` reference in docs/doctrine/ resolves to a real file or registered gate.",
    );
    return;
  }

  const missingPaths = findings.filter((f) => f.kind === "missing-path");
  const unknownGates = findings.filter((f) => f.kind === "unknown-gate");

  if (missingPaths.length > 0) {
    console.log(
      `✗ ${missingPaths.length} path-shaped citation(s) do not resolve to a real file:\n`,
    );
    for (const f of missingPaths) {
      console.log(`  ${f.doc}:${f.line}  \`${f.reference}\``);
      console.log(`    ${f.context}`);
    }
    console.log();
  }

  if (unknownGates.length > 0) {
    console.log(
      `✗ ${unknownGates.length} \`check-X\` citation(s) do not resolve to a real drift gate:\n`,
    );
    for (const f of unknownGates) {
      console.log(`  ${f.doc}:${f.line}  \`${f.reference}\``);
      console.log(`    ${f.context}`);
    }
    console.log();
  }

  console.log(
    `  Fix: update the citation to point at the current location, OR\n` +
      `       add an entry to PATH_ALLOWLIST / GATE_ALLOWLIST in\n` +
      `       scripts/check-doctrine-citations.ts with a reason if the\n` +
      `       reference is intentionally pointing at something not\n` +
      `       resolvable here (rare).`,
  );
  process.exit(1);
}

main();
