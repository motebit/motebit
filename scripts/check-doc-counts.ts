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
  /** npm-published packages — every workspace package.json without `private: true`. */
  publishedTotal: number;
  /** publishedTotal subset whose `license: "Apache-2.0"` (the permissive floor). */
  publishedApache: number;
  /** publishedTotal subset whose `license: "BUSL-1.1"` (the BSL runtime; one today). */
  publishedBsl: number;
  /** Workspace package.jsons declared `private: true` (everything internal). */
  privatePackages: number;
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

function walkPackageJsons(): PkgInfo[] {
  const out: PkgInfo[] = [];
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
      if (info) out.push(info);
    }
  }
  return out;
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
   * `"5 surfaces + 4 supporting apps"` were the last drift class this gate
   * could not express: `apps` total drifted from 8 → 9 when `apps/vscode`
   * landed, and `5 + 3 = 8` stayed legal in prose because neither digit
   * alone equalled `9`.
   */
  regex: RegExp;
  key: CountKey;
  kind?: "single" | "sum";
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
        regex: /All (\d+) packages started at `1\.0\.0`/,
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
