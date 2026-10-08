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
 * extracting every numeric count claim from the covered doc surfaces and
 * comparing against the filesystem-derived truth.
 *
 * Strategy:
 *   1. Compute canonical counts from the filesystem (`apps/`, `packages/`,
 *      `services/`, `spec/*.md`).
 *   2. For each doc surface in DOCS, run a set of probes — each is
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
  /** npm-published packages — every workspace package.json without `private: true`. */
  publishedTotal: number;
  /** publishedTotal subset whose `license: "Apache-2.0"` (the permissive floor). */
  publishedApache: number;
  /** publishedTotal subset whose `license: "BUSL-1.1"` (the BSL runtime; one today). */
  publishedBsl: number;
  /** Workspace package.jsons declared `private: true` (everything internal). */
  privatePackages: number;
  /** Every workspace package (a package.json under `packages/*`, `apps/*`, `services/*`) — published + private. */
  workspacePackages: number;
  /** Workspace packages under `packages/` (directories there minus the package.json-less `github-action`). */
  workspaceLibraries: number;
  /** Drift-defense inventory rows in docs/drift-defenses.md (canonical for the prose count). */
  driftInvariants: number;
  /** Hard-CI-gate entries in scripts/check.ts GATES (canonical for "X run as hard CI gates"). */
  hardCiGates: number;
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

interface PkgInfo {
  isPrivate: boolean;
  license: string | null;
}

function readPkg(absPath: string): PkgInfo | null {
  try {
    const raw = JSON.parse(readFileSync(absPath, "utf-8")) as Record<string, unknown>;
    return {
      isPrivate: raw.private === true,
      license: typeof raw.license === "string" ? raw.license : null,
    };
  } catch {
    return null;
  }
}

function walkPackageJsons(): Array<PkgInfo & { parent: string }> {
  const out: Array<PkgInfo & { parent: string }> = [];
  for (const parent of ["packages", "apps", "services"]) {
    const dir = resolve(ROOT, parent);
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const sub of entries) {
      if (sub.startsWith(".")) continue;
      const pkgJson = resolve(dir, sub, "package.json");
      const info = readPkg(pkgJson);
      if (info) out.push({ ...info, parent });
    }
  }
  return out;
}

/**
 * Count drift-defense inventory rows. Canonical: every `^| <digit>+ |`
 * line in the inventory table in `docs/drift-defenses.md`. Matches the
 * Markdown table cell that begins each row of the invariants list.
 */
function countDriftInvariants(): number {
  const file = resolve(ROOT, "docs/drift-defenses.md");
  const text = readFileSync(file, "utf-8");
  const matches = text.match(/^\| \d+\s+\|/gm);
  return matches ? matches.length : 0;
}

/**
 * Count hard CI gates registered in `scripts/check.ts`. Canonical: every
 * `name: "check-..."` entry in the GATES array. The name is the unique
 * key — duplicates would have already failed the runner.
 */
function countHardCiGates(): number {
  const file = resolve(ROOT, "scripts/check.ts");
  const text = readFileSync(file, "utf-8");
  const matches = text.match(/^\s+name:\s*"check-/gm);
  return matches ? matches.length : 0;
}

function deriveCanonical(): CanonicalCounts {
  const pkgs = walkPackageJsons();
  const published = pkgs.filter((p) => !p.isPrivate);
  return {
    apps: countDirs("apps"),
    packages: countDirs("packages"),
    services: countDirs("services"),
    specs: countSpecMd(),
    publishedTotal: published.length,
    publishedApache: published.filter((p) => p.license === "Apache-2.0").length,
    publishedBsl: published.filter((p) => p.license === "BUSL-1.1").length,
    privatePackages: pkgs.filter((p) => p.isPrivate).length,
    workspacePackages: pkgs.length,
    workspaceLibraries: pkgs.filter((p) => p.parent === "packages").length,
    driftInvariants: countDriftInvariants(),
    hardCiGates: countHardCiGates(),
  };
}

// ── Probes ────────────────────────────────────────────────────────────

type CountKey = keyof CanonicalCounts;

interface Probe {
  /**
   * Regex must capture either:
   *   - one `(\d+)` group when `kind` is `"single"` or omitted, or
   *   - two `(\d+)` groups whose **sum** equals the canonical count when `kind` is `"sum"`.
   *
   * The `"sum"` shape exists because compositional prose claims of the form
   * `"5 surfaces + 4 supporting apps"` were a drift class this gate
   * could not express: `apps` total drifted from 8 → 9 when `apps/vscode`
   * landed, and `5 + 3 = 8` stayed legal in prose because neither digit
   * alone equalled `9`.
   *
   * The `"list"` shape captures one enumeration in group 1 and counts its
   * backticked items: the README's Protocol-section spec list omitted
   * `sync-hold-receipt` (36 names for 37 specs) with no digit to probe.
   */
  regex: RegExp;
  key: CountKey;
  kind?: "single" | "sum" | "list";
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
      {
        regex: /each `motebit\/<name>@1\.0`: (.+?)\. By their own headers/,
        key: "specs",
        kind: "list",
        label: "Protocol section — spec name list length",
      },
      {
        regex: /By their own headers: (\d+) are `Status: Stable` and (\d+) `Draft`/,
        key: "specs",
        kind: "sum",
        label: "Protocol section — Stable + Draft split",
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
      {
        regex: /\*\*(\d+) npm packages publish from this monorepo\*\*/,
        key: "publishedTotal",
        label: "Verify-and-integrate published-count",
      },
      {
        regex: /(\d+) surfaces \+ (\d+) supporting apps · 1 relay/,
        key: "apps",
        kind: "sum",
        label: "Architecture banner — surfaces + supporting apps",
      },
      {
        regex: /— (\d+) Apache-2\.0 \(the permissive floor, with an explicit patent grant\)/,
        key: "publishedApache",
        label: "Verify-and-integrate Apache-floor count (inline)",
      },
      {
        regex: /and (\d+) BSL-1\.1 \(the reference runtime\)/,
        key: "publishedBsl",
        label: "Verify-and-integrate BSL count (inline)",
      },
      {
        regex: /The (\d+) Apache-2\.0 packages are the permissive floor/,
        key: "publishedApache",
        label: "BSL-line section Apache-floor count",
      },
      {
        regex: /^(\d+) packages publish to npm — (?:\d+) Apache-2\.0/m,
        key: "publishedTotal",
        label: "Versioning section published-total",
      },
      {
        regex: /publish to npm — (\d+) Apache-2\.0 \(the permissive floor\)/,
        key: "publishedApache",
        label: "Versioning section Apache count",
      },
      {
        regex: /\(the permissive floor\) and (\d+) BSL-1\.1/,
        key: "publishedBsl",
        label: "Versioning section BSL count",
      },
      {
        regex: /^The (\d+) workspace-private packages/m,
        key: "privatePackages",
        label: "Versioning section private-count",
      },
      {
        regex: /the (\d+) published packages above/,
        key: "publishedTotal",
        label: "Versioning section 'the N published packages above'",
      },
      {
        regex: /\(\[`services\/`\]\(services\/\)\) — (\d+) services in four roles/,
        key: "services",
        label: "Marketplace section — service count",
      },
    ],
  },
  {
    // The npm-published CLI README (`motebit` on npmjs.com) — a public
    // surface with no repo context, so its count claims drift silently.
    // Caught claiming 19 specs when the actual count was 34 (2026-07-25).
    path: "apps/cli/README.md",
    probes: [
      {
        regex:
          /the \[(\d+) open specs\]\(https:\/\/github\.com\/motebit\/motebit\/tree\/main\/spec\)/,
        key: "specs",
        label: "How-it-ships section — open-specs count",
      },
    ],
  },
  {
    path: "CLAUDE.md",
    probes: [
      { regex: /(\d+) packages on a 7-layer DAG/, key: "packages", label: "Architecture line" },
      { regex: /(\d+) open protocol specs/, key: "specs", label: "Architecture line" },
      {
        regex: /(\d+) surfaces \+ (\d+) supporting apps, (?:\d+) services/,
        key: "apps",
        kind: "sum",
        label: "Architecture line — surfaces + supporting apps",
      },
      {
        regex: /supporting apps, (\d+) services/,
        key: "services",
        label: "Architecture line — service count",
      },
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
      {
        regex: /(\d+) surfaces \+ (\d+) supporting apps · (?:\d+) services/,
        key: "apps",
        kind: "sum",
        label: "Shape banner — surfaces + supporting apps",
      },
      {
        regex: /supporting apps · (\d+) services/,
        key: "services",
        label: "Shape banner — service count",
      },
      {
        regex: /(\d+) packages sit on the permissive floor/,
        key: "publishedApache",
        label: "License-tier section — permissive-floor (Apache-2.0) count",
      },
      {
        regex: /All (\d+) specs \(listed in the tree above\)/,
        key: "specs",
        label: "Specifications section — spec count",
      },
    ],
  },
  {
    path: "docs/doctrine/promoting-private-to-public.md",
    probes: [
      {
        regex: /Motebit ships (\d+) packages to npm/,
        key: "publishedTotal",
        label: "Lead sentence — published total",
      },
      {
        regex: /and keeps (\d+) workspace-internal at `0\.0\.0-private`/,
        key: "privatePackages",
        label: "Lead sentence — private count",
      },
    ],
  },
  {
    path: "apps/docs/content/docs/changelog.mdx",
    probes: [
      {
        regex: /Motebit ships (\d+) packages to npm/,
        key: "publishedTotal",
        label: "Lead — published total",
      },
      {
        // 2026-09-14 (#667): said 51, repo held 62.
        regex: /The (\d+) workspace-private packages \(everything not in the table above\)/,
        key: "privatePackages",
        label: "Private-packages paragraph — private count",
      },
      {
        regex: /— (\d+) Apache-2\.0 packages on the/,
        key: "publishedApache",
        label: "Lead — Apache count",
      },
      {
        regex: /The (\d+) Apache-2\.0 packages on the permissive floor/,
        key: "publishedApache",
        label: "Permissive-floor list intro",
      },
      {
        // Matches either "All N packages started at 1.0.0" (original
        // coordinated-release wording) or "N of the M packages started
        // at 1.0.0" (post-state-export-client wording — state-export-client
        // joined the published surface as 0.1.0 rather than the 1.0.0
        // initial cohort). In both forms the captured digit is the
        // published total: "All " precedes it, or "N of the " does.
        // 2026-09-14: "converged on" replaced "started at" once the sentence
        // was corrected (five packages shipped pre-1.0 versions before 1.0.0).
        regex: /(?:All |\d+ of the )(\d+) packages (?:started at|converged on) `1\.0\.0`/,
        key: "publishedTotal",
        label: "Coordinated-release sentence",
      },
    ],
  },
  {
    path: "apps/docs/content/docs/concepts/public-surface.mdx",
    probes: [
      {
        regex: /(\d+) packages publish from this monorepo/,
        key: "publishedTotal",
        label: "Lead — published total",
      },
      {
        // 2026-09-14 (#667): the page said "Fifty-one" while the repo held 62 —
        // the README (probed) was right, this page (unprobed) was not.
        regex: /(\d+) workspace-private packages are pinned to version `0\.0\.0-private`/,
        key: "privatePackages",
        label: "Private-sentinel paragraph — private count",
      },
      {
        regex: /(\d+) open specs in \[`spec\/`\]/,
        key: "specs",
        label: "Implement-the-spec step — spec count",
      },
    ],
  },
  {
    path: "docs/drift-defenses.md",
    probes: [
      {
        regex: /^(\d+) invariants are enforced today\./m,
        key: "driftInvariants",
        label: "Inventory summary — total invariants",
      },
      {
        regex: /\. (\d+) run as hard CI gates via `pnpm check`/,
        key: "hardCiGates",
        label: "Inventory summary — hard CI gates",
      },
    ],
  },
  {
    path: "CONTRIBUTING.md",
    probes: [
      {
        regex: /apps\/\s+(\d+) surfaces and supporting apps/,
        key: "apps",
        label: "Project structure — apps count",
      },
      {
        regex: /packages\/\s+(\d+) packages on a 7-layer DAG/,
        key: "packages",
        label: "Project structure — packages count",
      },
      {
        regex: /services\/\s+(\d+) backend services/,
        key: "services",
        label: "Project structure — services count",
      },
      {
        regex: /spec\/\s+(\d+) open specifications/,
        key: "specs",
        label: "Project structure — specs count",
      },
      {
        regex: /today there are (\d+): (?:\d+) Apache-2\.0 packages \+ the `motebit` BSL runtime/,
        key: "publishedTotal",
        label: "Changesets — published total",
      },
      {
        regex: /there are \d+: (\d+) Apache-2\.0 packages \+ the `motebit` BSL runtime/,
        key: "publishedApache",
        label: "Changesets — Apache count",
      },
    ],
  },
];

// ── Sweep ─────────────────────────────────────────────────────────────
//
// The probe table above is one regex per KNOWN sentence, so its aperture is
// exactly the sentences someone remembered to write a probe for. On
// 2026-10-08 an outside reader found README.md saying "the 36 specs" (License
// in three lines) while every probed sentence said 37: that sentence had no
// probe, so the gate printed green. CLAUDE.md drifted the same way earlier.
//
// The sweep closes that class for the spec and package nouns. In every
// SWEPT file, EVERY occurrence of
//
//     <integer> [up to two qualifier words] specs|specifications|packages|libraries
//
// is classified by its qualifiers into a canonical key and compared against
// the filesystem. A claim the classifier cannot place is itself a failure
// (add a rule or an EXEMPT entry) — never silently skipped. Spelled-out
// numbers ("Four of the …") are outside the aperture, and the success line
// says so.

/** Files where every spec/package count claim is checked, not just the probed ones. */
const SWEPT: ReadonlyArray<string> = [
  "README.md",
  "CLAUDE.md",
  "CONTRIBUTING.md",
  "apps/cli/README.md",
  "apps/docs/content/docs/operator/architecture.mdx",
  "apps/docs/content/docs/concepts/public-surface.mdx",
];

/**
 * Matches that are not claims about this repo's counts. Each needle must be a
 * literal substring that still occurs in its file (a stale entry fails), and
 * carries the reason a reader can audit.
 */
const EXEMPT: ReadonlyArray<{ file: string; needle: string; reason: string }> = [
  {
    file: "CLAUDE.md",
    needle: "~19 packages via an upstream",
    reason: "historical breakage tally for the TS 6.0 revert, not a repo count",
  },
];

const SWEEP_CLAIM =
  /(?<![\w.-])(\d+)((?:\s+[\w`.-]+){0,2}?)\s+(specs|specifications|packages|libraries)\b/g;

/** Map a swept claim to its canonical key, or null when no rule places it. */
function classifyClaim(qualifiers: string[], noun: string, after: string): CountKey | null {
  const q = qualifiers.map((w) => w.replace(/`/g, "").toLowerCase());
  const only = (allowed: string[]): boolean => q.every((w) => allowed.includes(w));
  if (noun === "specs" || noun === "specifications") {
    return only(["open", "protocol"]) ? "specs" : null;
  }
  if (noun === "libraries") return only(["workspace"]) ? "workspaceLibraries" : null;
  // noun === "packages"
  if (q.length === 0) {
    if (/^\s+publish\b/.test(after)) return "publishedTotal";
    if (/^\s+(?:sit )?on the permissive floor\b/.test(after)) return "publishedApache";
    return "packages";
  }
  if (q.length !== 1) return null;
  const w = q[0];
  if (w === "workspace-private" || w === "private") return "privatePackages";
  if (w === "apache-2.0") return "publishedApache";
  if (w === "bsl-1.1" || w === "bsl") return "publishedBsl";
  if (w === "published" || w === "npm") return "publishedTotal";
  if (w === "workspace") return "workspacePackages";
  return null;
}

interface SweepResult {
  claims: number;
  exempted: number;
  drifts: Drift[];
  unclassified: Array<{ file: string; line: number; text: string }>;
  staleExempt: Array<{ file: string; needle: string }>;
}

function sweep(canonical: CanonicalCounts): SweepResult {
  const res: SweepResult = {
    claims: 0,
    exempted: 0,
    drifts: [],
    unclassified: [],
    staleExempt: [],
  };
  for (const file of SWEPT) {
    const text = readFileSync(resolve(ROOT, file), "utf-8");
    const exempts = EXEMPT.filter((e) => e.file === file);
    for (const e of exempts) {
      if (!text.includes(e.needle)) res.staleExempt.push({ file, needle: e.needle });
    }
    for (const m of text.matchAll(SWEEP_CLAIM)) {
      const index = m.index ?? 0;
      const line = lineOf(text, index);
      // A leading `~` marks an approximation; it must be exempted explicitly.
      const exempt = exempts.some((e) => {
        const at = text.indexOf(e.needle);
        return at !== -1 && index >= at - 1 && index < at + e.needle.length;
      });
      if (exempt) {
        res.exempted += 1;
        continue;
      }
      res.claims += 1;
      const qualifiers = (m[2] ?? "").trim().split(/\s+/).filter(Boolean);
      const noun = m[3] ?? "";
      const after = text.slice(index + m[0].length, index + m[0].length + 40);
      const key = classifyClaim(qualifiers, noun, after);
      if (key === null) {
        res.unclassified.push({ file, line, text: m[0] });
        continue;
      }
      const claimed = parseInt(m[1] ?? "0", 10);
      if (claimed !== canonical[key]) {
        res.drifts.push({
          file,
          label: `swept claim "${m[0]}"`,
          noun: key,
          claimed,
          actual: canonical[key],
          line,
        });
      }
    }
  }
  return res;
}

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
      const kind = probe.kind ?? "single";
      const claimed =
        kind === "sum"
          ? parseInt(m[1] ?? "0", 10) + parseInt(m[2] ?? "0", 10)
          : kind === "list"
            ? ((m[1] ?? "").match(/`[^`]+`/g)?.length ?? 0)
            : parseInt(m[1] ?? "0", 10);
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

  const swept = sweep(canonical);
  // A swept claim that a probe already reported is one drift, not two.
  const seen = new Set(drifts.map((d) => `${d.file}:${d.line}:${d.claimed}`));
  for (const d of swept.drifts) {
    if (!seen.has(`${d.file}:${d.line}:${d.claimed}`)) drifts.push(d);
  }

  let failed = false;

  if (missingProbes.length > 0) {
    failed = true;
    process.stderr.write(
      `\n✗ check-doc-counts: ${missingProbes.length} probe(s) failed to match — the doc surface drifted from this gate's expected shape.\n\n`,
    );
    for (const mp of missingProbes) {
      process.stderr.write(`  ${mp.file}\n    probe: ${mp.label}\n\n`);
    }
    process.stderr.write(
      "Fix: either restore the count claim in the doc, or update the probe regex in scripts/check-doc-counts.ts (DOCS).\n" +
        "A probe that no longer matches its target file is silent drift waiting to recur.\n",
    );
  }

  if (swept.unclassified.length > 0 || swept.staleExempt.length > 0) {
    failed = true;
    process.stderr.write(
      `\n✗ check-doc-counts: ${swept.unclassified.length} unclassified count claim(s), ${swept.staleExempt.length} stale exemption(s).\n\n`,
    );
    for (const u of swept.unclassified) {
      process.stderr.write(
        `  ${u.file}:${u.line}\n    "${u.text}" — no rule maps these qualifiers to a canonical count\n\n`,
      );
    }
    for (const e of swept.staleExempt) {
      process.stderr.write(
        `  ${e.file}\n    EXEMPT needle "${e.needle}" no longer occurs — remove it\n\n`,
      );
    }
    process.stderr.write(
      "Fix: reword the claim to a classified shape, add a rule to classifyClaim() in scripts/check-doc-counts.ts,\n" +
        "or (only for a number that is not a repo count) add an EXEMPT entry with its reason.\n",
    );
  }

  if (drifts.length > 0) {
    failed = true;
    process.stderr.write(
      `\n✗ check-doc-counts: ${drifts.length} count drift(s) detected.\n\n` +
        `  Canonical (filesystem):\n` +
        `    apps                ${canonical.apps}\n` +
        `    packages (dirs)     ${canonical.packages}\n` +
        `    workspaceLibraries  ${canonical.workspaceLibraries}\n` +
        `    workspacePackages   ${canonical.workspacePackages}\n` +
        `    publishedTotal      ${canonical.publishedTotal}\n` +
        `    privatePackages     ${canonical.privatePackages}\n` +
        `    services            ${canonical.services}\n` +
        `    specs               ${canonical.specs}\n\n`,
    );
    for (const d of drifts) {
      process.stderr.write(
        `  ${d.file}:${d.line}\n` +
          `    ${d.label} claims ${d.claimed} ${d.noun}; filesystem has ${d.actual}\n\n`,
      );
    }
    process.stderr.write(
      "Fix: correct the doc claim to the filesystem count (definitions: deriveCanonical() in scripts/check-doc-counts.ts).\n",
    );
  }

  if (failed) process.exit(1);

  process.stderr.write(
    `  ✓ check-doc-counts: ${probesRun} probed count claim(s) across ${DOCS.length} doc surface(s), plus ` +
      `${swept.claims} spec/package count claim(s) swept (every digit-form "<N> [≤2 qualifiers] specs|specifications|packages|libraries" ` +
      `in ${SWEPT.join(", ")}; ${swept.exempted} exempted; spelled-out numbers not examined) match the filesystem ` +
      `(${canonical.specs} specs; ${canonical.packages} dirs under packages/ = ${canonical.workspaceLibraries} workspace libraries + github-action; ` +
      `${canonical.workspacePackages} workspace packages = ${canonical.publishedTotal} published + ${canonical.privatePackages} private; ` +
      `${canonical.apps} apps, ${canonical.services} services).\n`,
  );
}

main();
