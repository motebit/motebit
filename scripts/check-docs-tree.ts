#!/usr/bin/env tsx
/**
 * check-docs-tree — drift defense for the canonical architecture page.
 *
 * `apps/docs/content/docs/operator/architecture.mdx` contains a directory-tree
 * code block that names every app, package, service, and spec in the monorepo,
 * tagging each package with its enforced layer (L0–L6) and permissive-floor
 * status (`Apache-2.0` today). That tree is a synchronization sibling of two
 * sources of truth:
 *
 *   - the filesystem under `apps/`, `packages/`, `services/`, `spec/`
 *   - the `LAYER` and `PERMISSIVE_PACKAGES` declarations in `scripts/check-deps.ts`
 *
 * Without this probe, the page drifts silently: a package gets added, renamed,
 * or re-layered, but the docs keep advertising the old shape. The classic
 * shape of every drift this codebase has suffered — invisible source of
 * truth, sibling copies emerge, copies drift. See CLAUDE.md § "Synchronization
 * invariants are the meta-principle".
 *
 * What this probe enforces:
 *
 *   1. Every directory under `apps/`, `packages/`, `services/` and every
 *      `spec/*.md` file appears as an entry in the tree.
 *   2. Every entry the tree names exists on disk.
 *   3. Every package's `[Ln]` tag equals its `LAYER` value in check-deps.ts.
 *   4. Every package's `Apache-2.0` tag matches `PERMISSIVE_PACKAGES` in check-deps.ts.
 *   5. Packages outside the layer DAG (github-action) carry `[—]`.
 *
 * This is the fourteenth synchronization invariant defense.
 *
 * Usage:
 *   tsx scripts/check-docs-tree.ts        # exit 1 on any drift
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MDX_PATH = join(ROOT, "apps/docs/content/docs/operator/architecture.mdx");
const CHECK_DEPS_PATH = join(ROOT, "scripts/check-deps.ts");

// Packages intentionally outside the layer DAG. Must match the prose in the
// mdx tree's "Standalone" section and the `github-action` omission from
// check-deps.ts LAYER map.
const STANDALONE_PACKAGES = new Set<string>(["github-action"]);

type EntryKind = "app" | "package" | "service" | "spec";

interface TreeEntry {
  kind: EntryKind;
  name: string;
  tags: string[]; // e.g. ["L0", "Apache-2.0"] or ["surface"] or ["—"]
  line: number;
}

interface Finding {
  loc: string;
  message: string;
}

// ── Parse LAYER and PERMISSIVE_PACKAGES out of scripts/check-deps.ts ───

function parseCheckDeps(): { layer: Map<string, number>; permissive: Set<string> } {
  const src = readFileSync(CHECK_DEPS_PATH, "utf-8");

  const layerBlock = src.match(/const LAYER[^{]*\{([\s\S]*?)\n\};/);
  if (!layerBlock) throw new Error("could not locate LAYER map in check-deps.ts");
  const layer = new Map<string, number>();
  const layerRe = /"([^"]+)":\s*(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = layerRe.exec(layerBlock[1])) !== null) {
    layer.set(m[1], Number(m[2]));
  }

  const permissiveBlock = src.match(/const PERMISSIVE_PACKAGES\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!permissiveBlock) throw new Error("could not locate PERMISSIVE_PACKAGES in check-deps.ts");
  const permissive = new Set<string>();
  const permissiveRe = /"([^"]+)"/g;
  let pm: RegExpExecArray | null;
  while ((pm = permissiveRe.exec(permissiveBlock[1])) !== null) {
    permissive.add(pm[1]);
  }

  return { layer, permissive };
}

// ── Parse the tree block out of architecture.mdx ───────────────────────

function parseTree(src: string): TreeEntry[] {
  const lines = src.split("\n");

  // Locate the fenced block whose first content line starts with `motebit/`.
  let openFence = -1;
  let closeFence = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith("```") && openFence < 0) {
      const next = (lines[i + 1] ?? "").trim();
      if (next.startsWith("motebit/")) {
        openFence = i;
        continue;
      }
    }
    if (lines[i].trim() === "```" && openFence >= 0 && closeFence < 0) {
      closeFence = i;
      break;
    }
  }
  if (openFence < 0 || closeFence < 0) {
    throw new Error("directory tree code block not found in architecture.mdx");
  }

  // `│` (U+2502) is not ASCII whitespace, so the tree prefix has to be matched
  // explicitly instead of relying on `\s*`.
  const PREFIX = "[│\\s]*";
  const SECTION_RE = new RegExp(
    `^${PREFIX}(?:├──|└──)\\s+(apps|packages|services|spec|scripts)\\/\\s*(?:#.*)?$`,
  );
  const PACKAGE_RE = new RegExp(
    `^${PREFIX}(?:├──|└──)\\s+([a-z0-9][a-z0-9-]*)\\/\\s+\\[([^\\]]+)\\]\\s*(.*)?$`,
  );
  const SPEC_RE = new RegExp(`^${PREFIX}(?:├──|└──)\\s+([a-z0-9-]+-v\\d+\\.md)\\b`);

  const entries: TreeEntry[] = [];
  let section: EntryKind | "ignore" | null = null;

  for (let i = openFence + 1; i < closeFence; i++) {
    const line = lines[i];

    const sm = SECTION_RE.exec(line);
    if (sm) {
      const dir = sm[1];
      section =
        dir === "apps"
          ? "app"
          : dir === "packages"
            ? "package"
            : dir === "services"
              ? "service"
              : dir === "spec"
                ? "spec"
                : "ignore"; // scripts — documented but not validated here
      continue;
    }

    if (section === null || section === "ignore") continue;

    if (section === "spec") {
      const sp = SPEC_RE.exec(line);
      if (sp) entries.push({ kind: "spec", name: sp[1], tags: [], line: i + 1 });
      continue;
    }

    const pm = PACKAGE_RE.exec(line);
    if (!pm) continue;
    const name = pm[1];
    const tags = pm[2].split("·").map((t) => t.trim());
    entries.push({ kind: section, name, tags, line: i + 1 });
  }

  return entries;
}

// ── Filesystem snapshot ────────────────────────────────────────────────

function lsDirs(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  return new Set(
    readdirSync(path).filter((name) => {
      if (name.startsWith(".")) return false;
      try {
        return statSync(join(path, name)).isDirectory();
      } catch {
        return false;
      }
    }),
  );
}

function lsFiles(path: string, ext: string): Set<string> {
  if (!existsSync(path)) return new Set();
  return new Set(readdirSync(path).filter((n) => n.endsWith(ext) && !n.startsWith(".")));
}

// ── Main ───────────────────────────────────────────────────────────────

function main(): void {
  const findings: Finding[] = [];
  const mdxRel = relative(ROOT, MDX_PATH);

  const mdxSrc = readFileSync(MDX_PATH, "utf-8");
  const entries = parseTree(mdxSrc);
  const { layer, permissive } = parseCheckDeps();

  const fs = {
    apps: lsDirs(join(ROOT, "apps")),
    packages: lsDirs(join(ROOT, "packages")),
    services: lsDirs(join(ROOT, "services")),
    specs: lsFiles(join(ROOT, "spec"), ".md"),
  };

  function byKind(kind: EntryKind): TreeEntry[] {
    return entries.filter((e) => e.kind === kind);
  }

  function crossCheck(kind: EntryKind, expected: Set<string>, dirLabel: string): void {
    const inTree = new Set(byKind(kind).map((e) => e.name));
    for (const name of expected) {
      if (!inTree.has(name)) {
        findings.push({
          loc: `${dirLabel}/${name}`,
          message: `exists on disk but is missing from the ${kind} section of ${mdxRel}`,
        });
      }
    }
    for (const entry of byKind(kind)) {
      if (!expected.has(entry.name)) {
        findings.push({
          loc: `${mdxRel}:${entry.line}`,
          message: `tree names "${entry.name}" under ${dirLabel}/ but no such directory exists`,
        });
      }
    }
  }

  crossCheck("app", fs.apps, "apps");
  crossCheck("package", fs.packages, "packages");
  crossCheck("service", fs.services, "services");

  // Specs are files, not dirs — handled explicitly
  const specsInTree = new Set(byKind("spec").map((e) => e.name));
  for (const spec of fs.specs) {
    if (!specsInTree.has(spec)) {
      findings.push({
        loc: `spec/${spec}`,
        message: `exists on disk but is missing from the spec section of ${mdxRel}`,
      });
    }
  }
  for (const entry of byKind("spec")) {
    if (!fs.specs.has(entry.name)) {
      findings.push({
        loc: `${mdxRel}:${entry.line}`,
        message: `tree names spec "${entry.name}" but spec/${entry.name} does not exist`,
      });
    }
  }

  // Validate package tags against check-deps.ts
  for (const entry of byKind("package")) {
    const scoped = entry.name === "create-motebit" ? "create-motebit" : `@motebit/${entry.name}`;
    const loc = `${mdxRel}:${entry.line}`;

    if (STANDALONE_PACKAGES.has(entry.name)) {
      if (!entry.tags.includes("—")) {
        findings.push({
          loc,
          message: `${entry.name} is standalone (outside layer DAG) — expected [—], got [${entry.tags.join(" · ")}]`,
        });
      }
      if (layer.has(scoped)) {
        findings.push({
          loc,
          message: `${entry.name} is listed as standalone in the tree but also appears in check-deps.ts LAYER — pick one`,
        });
      }
      continue;
    }

    const declaredLayer = layer.get(scoped);
    if (declaredLayer === undefined) {
      findings.push({
        loc,
        message: `${entry.name} has no entry in check-deps.ts LAYER map — add it, or mark it standalone and list it in STANDALONE_PACKAGES in this script`,
      });
      continue;
    }

    const layerTag = entry.tags.find((t) => /^L\d+$/.test(t));
    if (!layerTag) {
      findings.push({
        loc,
        message: `${entry.name} missing layer tag — expected [L${declaredLayer}], got [${entry.tags.join(" · ")}]`,
      });
    } else if (Number(layerTag.slice(1)) !== declaredLayer) {
      findings.push({
        loc,
        message: `${entry.name} tagged ${layerTag} but check-deps.ts says L${declaredLayer}`,
      });
    }

    const hasPermissiveTag = entry.tags.includes("Apache-2.0");
    const isPermissive = permissive.has(scoped);
    if (hasPermissiveTag && !isPermissive) {
      findings.push({
        loc,
        message: `${entry.name} tagged Apache-2.0 in the tree but not in check-deps.ts PERMISSIVE_PACKAGES`,
      });
    } else if (!hasPermissiveTag && isPermissive) {
      findings.push({
        loc,
        message: `${entry.name} is in check-deps.ts PERMISSIVE_PACKAGES but the tree is missing the Apache-2.0 tag`,
      });
    }
  }

  if (findings.length > 0) {
    process.stderr.write(`check-docs-tree: ${findings.length} violation(s)\n\n`);
    for (const f of findings) {
      process.stderr.write(`  ${f.loc}\n    ${f.message}\n`);
    }
    process.stderr.write(
      `\nThe architecture.mdx tree mirrors scripts/check-deps.ts and the filesystem.\n` +
        `When you change any of them, change the others in the same PR.\n`,
    );
    process.exit(1);
  }

  const counts = {
    apps: byKind("app").length,
    packages: byKind("package").length,
    services: byKind("service").length,
    specs: byKind("spec").length,
  };
  process.stderr.write(
    `check-docs-tree: OK (${counts.apps} apps, ${counts.packages} packages, ${counts.services} services, ${counts.specs} specs)\n`,
  );
}

main();
