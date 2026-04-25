/**
 * Doc-count drift gate — README.md, CLAUDE.md, and the operator
 * architecture docs all enumerate "N packages, N specs, N services"
 * inline. Until 2026-04-24 nothing enforced those numbers against the
 * filesystem, and they drifted hard: README claimed 36 packages, root
 * CLAUDE.md claimed 40, the docs site claimed 37, and the actual count
 * was 46. Specs drifted the same way: 12 / 14 / 12 / actual 19. Each
 * was internally consistent and externally wrong.
 *
 * `check-docs-tree.ts` enforces the *directory tree* in
 * `apps/docs/content/docs/operator/architecture.mdx` against the
 * filesystem — it caught directory-name drift but missed the prose count
 * claims that sit alongside the tree. This gate closes that gap by
 * extracting every numeric count claim from the three doc surfaces and
 * comparing against the filesystem-derived truth.
 *
 * Strategy:
 *   1. Compute canonical counts from the filesystem (`apps/`, `packages/`,
 *      `services/`, `spec/*.md`).
 *   2. For each of the three doc surfaces, run a set of probes — each is
 *      a regex that captures `(\d+) <noun>` and a `noun → key` mapping.
 *   3. Every claim found must equal the canonical count for its noun.
 *
 * Adding a new claim shape (or moving a claim to a new file) means
 * adding a probe entry below. Adversarial: if a doc adds a count claim
 * that this gate doesn't probe, `check-gates-effective` won't catch it
 * either — but the moment someone changes one of the existing claims
 * AND makes them inconsistent with each other, this gate fires.
 *
 * Companion: check-docs-tree.ts validates the tree shape; this validates
 * the prose around it.
 *
 * This is the forty-fifth synchronization invariant defense.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Canonical counts ──────────────────────────────────────────────────

interface CanonicalCounts {
  apps: number;
  packages: number;
  services: number;
  specs: number;
}

function countDirs(parent: string): number {
  const dir = resolve(ROOT, parent);
  return readdirSync(dir).filter((entry) => {
    const full = resolve(dir, entry);
    if (entry.startsWith(".")) return false;
    try {
      return statSync(full).isDirectory();
    } catch {
      return false;
    }
  }).length;
}

function countSpecMd(): number {
  const dir = resolve(ROOT, "spec");
  return readdirSync(dir).filter((f) => f.endsWith(".md") && f !== "README.md").length;
}

function deriveCanonical(): CanonicalCounts {
  return {
    apps: countDirs("apps"),
    packages: countDirs("packages"),
    services: countDirs("services"),
    specs: countSpecMd(),
  };
}

// ── Probes ────────────────────────────────────────────────────────────

type CountKey = keyof CanonicalCounts;

interface Probe {
  /** Regex must capture exactly one `(\d+)` group. */
  regex: RegExp;
  key: CountKey;
  /** Optional human label for the failure message. */
  label?: string;
}

interface DocFile {
  path: string;
  probes: Probe[];
}

const DOCS: ReadonlyArray<DocFile> = [
  {
    path: "README.md",
    probes: [
      {
        regex: /\*\*(\d+) packages across 7 architectural layers/,
        key: "packages",
        label: "Architecture banner",
      },
      {
        regex: /\(\[`packages\/`\]\(packages\/\)\) — (\d+) packages on a strict layer DAG/,
        key: "packages",
        label: "Packages section",
      },
      {
        regex: /— (\d+) open specifications, each `motebit\/<name>@1\.0`/,
        key: "specs",
        label: "Protocol section",
      },
      { regex: /All \[(\d+) specs\]\(spec\/\)/, key: "specs", label: "Specification note" },
      {
        regex: /spec\/\)\s*—\s*(\d+) open specs \(full list/,
        key: "specs",
        label: "Permissive-floor list",
      },
      {
        regex: /\[Specifications\]\(spec\/\) — (\d+) open specs/,
        key: "specs",
        label: "Links list",
      },
    ],
  },
  {
    path: "CLAUDE.md",
    probes: [
      { regex: /(\d+) packages on a 7-layer DAG/, key: "packages", label: "Architecture line" },
      { regex: /(\d+) open protocol specs/, key: "specs", label: "Architecture line" },
    ],
  },
  {
    path: "apps/docs/content/docs/operator/architecture.mdx",
    probes: [
      {
        regex: /\*\*(\d+) packages · 7 architectural layers/,
        key: "packages",
        label: "Shape banner",
      },
      { regex: /(\d+) open specs\*\*/, key: "specs", label: "Shape banner" },
    ],
  },
];

// ── Main ──────────────────────────────────────────────────────────────

interface Drift {
  file: string;
  label: string;
  noun: CountKey;
  claimed: number;
  actual: number;
  line: number;
}

function lineOf(text: string, charIndex: number): number {
  return text.slice(0, charIndex).split("\n").length;
}

function main(): void {
  const canonical = deriveCanonical();
  const drifts: Drift[] = [];
  let probesRun = 0;
  const missingProbes: Array<{ file: string; label: string }> = [];

  for (const doc of DOCS) {
    const full = resolve(ROOT, doc.path);
    let text: string;
    try {
      text = readFileSync(full, "utf-8");
    } catch (err) {
      throw new Error(
        `cannot read ${doc.path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    for (const probe of doc.probes) {
      const m = text.match(probe.regex);
      if (!m) {
        missingProbes.push({ file: doc.path, label: probe.label ?? probe.regex.source });
        continue;
      }
      probesRun += 1;
      const claimed = parseInt(m[1] ?? "0", 10);
      const actual = canonical[probe.key];
      if (claimed !== actual) {
        drifts.push({
          file: doc.path,
          label: probe.label ?? probe.regex.source,
          noun: probe.key,
          claimed,
          actual,
          line: lineOf(text, text.indexOf(m[0])),
        });
      }
    }
  }

  if (missingProbes.length > 0) {
    process.stderr.write(
      `\n✗ check-doc-counts: ${missingProbes.length} probe(s) failed to match — the doc surface drifted from this gate's expected shape.\n\n`,
    );
    for (const mp of missingProbes) {
      process.stderr.write(`  ${mp.file}\n    probe: ${mp.label}\n\n`);
    }
    process.stderr.write(
      "Either restore the count claim in the doc, or update this gate's probe regex.\n" +
        "A probe that no longer matches its target file is silent drift waiting to recur.\n",
    );
    process.exit(1);
  }

  if (drifts.length > 0) {
    process.stderr.write(
      `\n✗ check-doc-counts: ${drifts.length} count drift(s) detected.\n\n` +
        `  Canonical (filesystem):\n` +
        `    apps     ${canonical.apps}\n` +
        `    packages ${canonical.packages}\n` +
        `    services ${canonical.services}\n` +
        `    specs    ${canonical.specs}\n\n`,
    );
    for (const d of drifts) {
      process.stderr.write(
        `  ${d.file}:${d.line}\n` +
          `    ${d.label} claims ${d.claimed} ${d.noun}; filesystem has ${d.actual}\n\n`,
      );
    }
    process.stderr.write(
      "Either fix the doc claim or, if the count changed deliberately, update the doc.\n",
    );
    process.exit(1);
  }

  process.stderr.write(
    `  ✓ check-doc-counts: ${probesRun} count claim(s) across ${DOCS.length} doc surface(s) match the filesystem ` +
      `(${canonical.packages} packages, ${canonical.specs} specs, ${canonical.apps} apps, ${canonical.services} services).\n`,
  );
}

main();
