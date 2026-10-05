#!/usr/bin/env tsx
/**
 * check-spec-coverage — hard drift defense for spec ↔ protocol type alignment.
 *
 * Each `spec/*.md` file may declare one or more "Wire format (foundation law)"
 * subsections. Anything named in such a subsection is binding vocabulary that
 * every conforming implementation must emit or accept, so the permissive-floor type package
 * `@motebit/protocol` (Apache-2.0) must export a matching name. If it does not, the spec is
 * describing a type no implementation can reference — a drift the existing
 * `check-spec-references` probe cannot catch.
 *
 * What this probe enforces:
 *   1. For every `### X.Y — TypeName` heading that appears inside (or is the
 *      parent of) a `#### Wire format (foundation law)` block, assert
 *      `TypeName` is exported from `@motebit/protocol`.
 *   2. If a spec has no Wire format blocks yet, the probe reports it as
 *      "unstructured" — a soft signal that the foundation-law/convention split
 *      hasn't been applied. This is not an error yet; it becomes one when the
 *      `--strict` flag is passed. The only way out is an entry in `NON_WIRE`
 *      below, which carries its reason; an entry whose spec has (or gains) a
 *      wire block, or names no spec, is stale and fails.
 *   3. `spec/README.md` is the executable index of the protocol floor (always
 *      hard, independent of `--strict`):
 *        a. every spec appears exactly once, under exactly one of the
 *           `INDEX_CLASSES` headings, and nothing else is listed;
 *        b. every relative link in the README resolves to an existing file;
 *        c. each spec's own first `**Status:**` line leads with a word from
 *           the closed set `STATUSES` (case-sensitive), and its entry shows
 *           that word — unless the spec is on `PENDING_STATUS_DECISION`, whose
 *           entry shows `pending decision` instead. A pending spec that gains
 *           a valid status is a stale entry and fails, so the list only
 *           shrinks.
 *
 * What it does NOT check: whether a spec satisfies the README's admission
 * rule. That is human judgment; the gate checks only the mechanical facts
 * above.
 *
 * This is the ninth synchronization invariant defense: specs ↔ protocol types.
 * The other eight are enumerated in CLAUDE.md under "Synchronization invariants".
 *
 * Usage:
 *   tsx scripts/check-spec-coverage.ts           # exit 1 on missing types
 *   tsx scripts/check-spec-coverage.ts --strict  # also fail on unstructured specs
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { formatRepair } from "./lib/gate-report.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const SPEC_DIR = join(REPO_ROOT, "spec");
const PROTOCOL_INDEX = join(REPO_ROOT, "packages", "protocol", "src", "index.ts");
const PROTOCOL_SRC = join(REPO_ROOT, "packages", "protocol", "src");
const SPEC_INDEX = join(SPEC_DIR, "README.md");

/**
 * The class headings of `spec/README.md`, in order. Every spec sits under
 * exactly one. Adding a class is a deliberate edit here and in the README.
 */
const INDEX_CLASSES = [
  "Identity & authority",
  "Evidence & verification",
  "Execution & routing",
  "Settlement & economics",
  "Federation & transparency",
  "Runtime interoperability",
  "Surface & tool interoperability",
  "Vocabulary",
] as const;

/**
 * A spec's Status is a compatibility promise to outside implementers, so it is
 * a closed vocabulary, matched case-sensitively. `converged`, `Final`,
 * `stable` or a bare date is not a status.
 */
const STATUSES = ["Draft", "Stable", "Deprecated"] as const;

/** How the README renders a spec on `PENDING_STATUS_DECISION`. */
const PENDING_RENDERING = "pending decision";

/**
 * Specs whose Status is not (yet) in `STATUSES`, each with why. Shrink-only:
 * choosing a status is a founder decision, so the gate never picks one — it
 * holds the spec here until the decision lands in the spec itself, and an
 * entry whose spec now carries a valid status (or names no spec) fails as
 * stale. Never add to this map to get green.
 */
const PENDING_STATUS_DECISION: Record<string, string> = {};

/** An index entry: `- [name](name) · Status: <Word | pending decision> · purpose`. */
const INDEX_ENTRY = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s+·\s+Status:\s+(pending decision|\S+)\s+·\s+\S/;

/**
 * Specs exempt from the "at least one `#### Wire format (foundation law)`
 * block" rule. Each entry MUST say why the spec defines no wire bytes. Empty
 * today: `terminology-v1.md`, the obvious candidate, carries a real wire block
 * (§1 — the JCS/Ed25519/hex-key/ms-timestamp/micro-unit encoding rules every
 * wire term it defines inherits), so exempting it would be a stale entry.
 */
const NON_WIRE: Record<string, string> = {};

const WIRE_FORMAT_HEADER = /^####\s+Wire format\s*\(foundation law\)\s*$/i;
const STORAGE_HEADER = /^####\s+Storage\b/i;
const SECTION_HEADER = /^###\s+[\d.]+\s*—\s*([A-Z][A-Za-z0-9_]*)\s*$/;
const ANY_HEADER = /^#{1,6}\s+/;

interface Finding {
  spec: string;
  typeName: string;
  line: number;
}

function collectProtocolExports(): Set<string> {
  const exports = new Set<string>();
  const exportRegex =
    /export\s+(?:type\s+|interface\s+|class\s+|function\s+|const\s+|enum\s+)?(\{[^}]*\}|[A-Za-z_][A-Za-z0-9_]*)/g;
  const renameInBraces = /([A-Za-z_][A-Za-z0-9_]*)\s*(?:as\s+([A-Za-z_][A-Za-z0-9_]*))?/g;

  function scan(file: string): void {
    let src: string;
    try {
      src = readFileSync(file, "utf-8");
    } catch {
      return;
    }
    for (const match of src.matchAll(exportRegex)) {
      const tok = match[1]!;
      if (tok.startsWith("{")) {
        for (const inner of tok.slice(1, -1).matchAll(renameInBraces)) {
          const name = inner[2] ?? inner[1]!;
          if (/^[A-Z]/.test(name)) exports.add(name);
        }
      } else if (/^[A-Z]/.test(tok)) {
        exports.add(tok);
      }
    }
  }

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "__tests__" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) scan(full);
    }
  };
  walk(PROTOCOL_SRC);
  scan(PROTOCOL_INDEX);
  return exports;
}

interface SpecAnalysis {
  file: string;
  basename: string;
  wireSections: { typeName: string; line: number }[];
  hasWireBlock: boolean;
}

function analyzeSpec(file: string): SpecAnalysis {
  const basename = file.split("/").pop()!;
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");

  const wireSections: { typeName: string; line: number }[] = [];
  let hasWireBlock = false;
  let currentType: { typeName: string; line: number } | null = null;
  let insideWireBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const sectionMatch = line.match(SECTION_HEADER);
    if (sectionMatch) {
      currentType = { typeName: sectionMatch[1]!, line: i + 1 };
      insideWireBlock = false;
      continue;
    }

    if (WIRE_FORMAT_HEADER.test(line)) {
      hasWireBlock = true;
      insideWireBlock = true;
      if (currentType) {
        wireSections.push(currentType);
        currentType = null;
      }
      continue;
    }

    if (STORAGE_HEADER.test(line)) {
      insideWireBlock = false;
      continue;
    }

    // Another top-level section header ends the current wire block context —
    // and clears the pending type name with it. Without the second half, a
    // `#### Wire format (foundation law)` block that does not sit under a
    // `### N.M — TypeName` heading inherits whatever heading was last seen,
    // however far above and in whatever unrelated section. Adding §7.6 to
    // identity-v1.md made that concrete: the gate reported the missing type as
    // `identity-v1.md:551 Discovery`, naming a heading 47 lines earlier in a
    // different chapter. A gate must not blame a line that has nothing to do
    // with the failure (docs/doctrine/gate-repair-instructions.md).
    if (ANY_HEADER.test(line) && !line.startsWith("####")) {
      insideWireBlock = false;
      currentType = null;
    }
    // Reference insideWireBlock to keep state flow explicit (no-op read).
    void insideWireBlock;
  }

  return { file, basename, wireSections, hasWireBlock };
}

/**
 * Leading token of a spec's first `**Status:**` line (up to whitespace, so
 * `Draft (phase-1 …)` is `Draft` but `2026-06-28` stays whole), or `null` when
 * the spec has no Status line.
 */
function specStatus(file: string): string | null {
  const m = readFileSync(file, "utf-8").match(/^\*\*Status:\*\*[ \t]*(\S*)/m);
  return m ? m[1]! : null;
}

function isClosedStatus(word: string | null): boolean {
  return word !== null && (STATUSES as readonly string[]).includes(word);
}

function checkIndexAndExemptions(specs: SpecAnalysis[]): string[] {
  const failures: string[] = [];
  const byName = new Map(specs.map((s) => [s.basename, s]));

  const stale: string[] = [];
  for (const name of Object.keys(NON_WIRE)) {
    const spec = byName.get(name);
    if (!spec) stale.push(`${name} — no such spec in spec/`);
    else if (spec.hasWireBlock) stale.push(`${name} — declares a Wire format block`);
  }
  if (stale.length > 0) {
    failures.push(
      formatRepair({
        invariant: `${stale.length} stale NON_WIRE exemption(s) in scripts/check-spec-coverage.ts`,
        canonical: "scripts/check-spec-coverage.ts (NON_WIRE)",
        fix: "remove the stale entry from NON_WIRE — the spec now carries wire bytes (or is gone).",
        sites: stale,
      }),
    );
  }

  const stalePending: string[] = [];
  for (const name of Object.keys(PENDING_STATUS_DECISION)) {
    const spec = byName.get(name);
    if (!spec) stalePending.push(`${name} — no such spec in spec/`);
    else if (isClosedStatus(specStatus(spec.file)))
      stalePending.push(`${name} — now carries **Status:** ${specStatus(spec.file)}`);
  }
  if (stalePending.length > 0) {
    failures.push(
      formatRepair({
        invariant: `${stalePending.length} stale PENDING_STATUS_DECISION entr${stalePending.length === 1 ? "y" : "ies"} in scripts/check-spec-coverage.ts`,
        canonical:
          "scripts/check-spec-coverage.ts (PENDING_STATUS_DECISION) + the spec's own **Status:** line",
        fix: "the status decision has landed in the spec: remove its PENDING_STATUS_DECISION entry and show the spec's status in its spec/README.md entry.",
        sites: stalePending,
      }),
    );
  }

  const badStatus: string[] = [];
  for (const s of specs) {
    if (s.basename in PENDING_STATUS_DECISION) continue;
    const own = specStatus(s.file);
    if (own === null) {
      badStatus.push(`spec/${s.basename} has no \`**Status:**\` line`);
    } else if (!isClosedStatus(own)) {
      badStatus.push(`spec/${s.basename} **Status:** "${own}" is not in the closed status set`);
    }
  }
  if (badStatus.length > 0) {
    failures.push(
      formatRepair({
        invariant: `${badStatus.length} spec(s) outside the closed status set {${STATUSES.join(", ")}} (case-sensitive)`,
        canonical: "scripts/check-spec-coverage.ts (STATUSES) + the spec's own **Status:** line",
        fix:
          `lead the spec's first \`**Status:**\` line with exactly one of ${STATUSES.join(" / ")}. ` +
          "Choosing a status is a founder decision; if it is not yet made, do not pick one here — raise it with the founder.",
        sites: badStatus,
      }),
    );
  }

  if (!existsSync(SPEC_INDEX)) {
    failures.push(
      formatRepair({
        invariant: "spec/README.md (the protocol-floor index) is missing",
        canonical: "spec/README.md",
        fix: `add spec/README.md with the admission rule and one \`## <class>\` section per INDEX_CLASSES entry in scripts/check-spec-coverage.ts.`,
      }),
    );
    return failures;
  }

  const lines = readFileSync(SPEC_INDEX, "utf-8").split("\n");
  const seen = new Map<string, string[]>(); // spec -> classes (with line)
  const problems: string[] = [];
  const classesSeen = new Set<string>();
  let currentClass: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const where = `spec/README.md:${i + 1}`;
    const h2 = line.match(/^##\s+(.+?)\s*$/);
    if (h2) {
      const name = h2[1]!;
      currentClass = (INDEX_CLASSES as readonly string[]).includes(name) ? name : null;
      if (currentClass) {
        if (classesSeen.has(name)) problems.push(`${where} duplicate class heading "${name}"`);
        classesSeen.add(name);
      }
      continue;
    }
    for (const link of line.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = link[1]!.split("#")[0]!;
      if (!target || /^[a-z]+:/i.test(target)) continue;
      if (!existsSync(resolve(dirname(SPEC_INDEX), target))) {
        problems.push(`${where} link "${link[1]}" does not resolve to an existing file`);
      }
    }
    const entry = line.match(INDEX_ENTRY);
    if (!entry) {
      if (/^-\s+\[[^\]]+\]\([^)/]+\.md\)/.test(line) && currentClass) {
        problems.push(
          `${where} malformed entry — expected "- [x.md](x.md) · Status: <Word | ${PENDING_RENDERING}> · <purpose>"`,
        );
      }
      continue;
    }
    const [, label, target, status] = entry;
    if (!target!.endsWith(".md") || target!.includes("/")) continue; // not a spec entry
    if (!currentClass) {
      problems.push(`${where} ${target} is listed outside every INDEX_CLASSES heading`);
      continue;
    }
    if (label !== target) problems.push(`${where} link text "${label}" ≠ target "${target}"`);
    const spec = byName.get(target!);
    if (!spec) {
      problems.push(`${where} ${target} is indexed but is not a spec in spec/`);
      continue;
    }
    seen.set(target!, [...(seen.get(target!) ?? []), `${currentClass} (line ${i + 1})`]);
    const expected = target! in PENDING_STATUS_DECISION ? PENDING_RENDERING : specStatus(spec.file);
    if (status !== expected) {
      problems.push(
        target! in PENDING_STATUS_DECISION
          ? `${where} ${target} is pending a status decision; its entry must read "Status: ${PENDING_RENDERING}", not "Status: ${status}"`
          : `${where} ${target} Status "${status}" ≠ the spec's own **Status:** "${expected ?? "(none)"}"`,
      );
    }
  }

  for (const c of INDEX_CLASSES) {
    if (!classesSeen.has(c)) problems.push(`spec/README.md missing class heading "## ${c}"`);
  }
  for (const s of specs) {
    const at = seen.get(s.basename);
    if (!at) problems.push(`spec/${s.basename} is not indexed in spec/README.md`);
    else if (at.length > 1)
      problems.push(`spec/${s.basename} is indexed ${at.length}× — ${at.join(", ")}`);
  }

  if (problems.length > 0) {
    failures.push(
      formatRepair({
        invariant: `spec/README.md index drift — ${problems.length} problem(s) across ${specs.length} specs`,
        canonical: "spec/README.md (index) + each spec's own **Status:** line",
        fix:
          "list every spec exactly once as `- [x.md](x.md) · Status: <Word> · <purpose>` under one INDEX_CLASSES heading, " +
          `where <Word> is the spec's own status (one of ${STATUSES.join(" / ")}), or \`${PENDING_RENDERING}\` for a PENDING_STATUS_DECISION spec, and fix any dead link.`,
        sites: problems,
      }),
    );
  }
  return failures;
}

function main(): void {
  const strict = process.argv.includes("--strict");
  const exports = collectProtocolExports();

  const specs = readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .map((f) => analyzeSpec(join(SPEC_DIR, f)))
    .sort((a, b) => a.basename.localeCompare(b.basename));

  const missing: Finding[] = [];
  const unstructured: string[] = [];
  let checked = 0;

  for (const spec of specs) {
    if (!spec.hasWireBlock) {
      if (!(spec.basename in NON_WIRE)) unstructured.push(spec.basename);
      continue;
    }
    for (const { typeName, line } of spec.wireSections) {
      checked++;
      if (!exports.has(typeName)) {
        missing.push({ spec: spec.basename, typeName, line });
      }
    }
  }

  console.log(
    `check-spec-coverage — ${specs.length} specs, ${checked} wire-format types checked\n`,
  );

  const indexFailures = checkIndexAndExemptions(specs);
  if (indexFailures.length > 0) {
    for (const f of indexFailures) process.stderr.write(f);
    process.exit(1);
  }

  if (missing.length > 0) {
    console.log(
      "✗ Types named in Wire format (foundation law) but not exported from @motebit/protocol:\n",
    );
    for (const m of missing) {
      console.log(`  ${m.spec}:${m.line}  ${m.typeName}`);
    }
    console.log(
      "\n  Fix: either export the type from @motebit/protocol, or rename the spec heading",
    );
    console.log(
      "  to match an existing exported type. Specs must stay aligned with the permissive-floor vocabulary.",
    );
    process.exit(1);
  }

  if (unstructured.length > 0) {
    const marker = strict ? "✗" : "⚠";
    console.log(
      `${marker} Specs with no "Wire format (foundation law)" section (${unstructured.length}):\n`,
    );
    for (const name of unstructured) console.log(`  ${name}`);
    console.log(
      "\n  These specs have not applied the wire-vs-convention split. Add a\n" +
        '  "#### Wire format (foundation law)" subsection to each section that\n' +
        '  defines a binding artifact, and a "#### Storage" (or similar)\n' +
        "  subsection for reference-implementation conventions. See\n" +
        "  spec/discovery-v1.md §5.1 for the exemplar.",
    );
    if (strict) process.exit(1);
  }

  // The success line claims only what was checked above — never that a spec
  // satisfies the admission rule (human judgment). The wire-format clause is
  // printed only when it holds for every spec.
  const indexed =
    `every spec (${specs.length}) is indexed once under one class with a matching status from the closed set ` +
    `{${STATUSES.join(", ")}} (${Object.keys(PENDING_STATUS_DECISION).length} pending a founder decision)`;
  console.log(
    unstructured.length === 0
      ? `✓ ${indexed}, and either declares a wire format or carries a stated reason it is normative without one (NON_WIRE: ${Object.keys(NON_WIRE).length}).`
      : `✓ ${indexed}.`,
  );
  console.log(`✓ All wire-format types in spec/ have matching exports in @motebit/protocol.`);
}

main();
