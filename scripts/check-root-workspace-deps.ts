#!/usr/bin/env tsx
/**
 * Drift defense: every `workspace:*` dependency in the ROOT package.json must
 * resolve to a path the relay's Dockerfile actually copies.
 *
 * The relay image is built from a SLICE of the monorepo. `services/relay/
 * Dockerfile` copies the root manifest plus `packages/` and `services/relay/`
 * — and nothing else, deliberately, to keep the build small. But `pnpm
 * --filter @motebit/relay deploy --prod` resolves the workspace using the root
 * `package.json` that came along in that slice. So a root `workspace:*`
 * dependency pointing anywhere outside the copied set is unsatisfiable inside
 * the image, and the build dies with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`.
 *
 * This is not hypothetical. `@motebit/research` was added to root devDeps on
 * 2026-07-31 for one dynamic import in `scripts/archetype-conformance.ts`.
 * `services/research/` is not in the copied set, so from that commit forward
 * BOTH the relay deploy and the container-image publish failed on every run —
 * and production relay sat frozen on the 07-31 build for four days while main
 * stayed green. Nothing caught it because PR CI does not build the relay image:
 * `check-deploy-parity` reasons about what the relay DECLARES, never about what
 * the Dockerfile COPIES.
 *
 * Textbook `composition-preserves-enforcement`: the root manifest is shared
 * context between the monorepo and an image holding only a slice of it, and
 * nothing asserted the two views stay compatible.
 *
 * The fix for a violation is usually NOT to widen the Dockerfile (that inflates
 * every relay build for a script-only dependency). Root-level scripts should
 * import workspace source by relative path — the shape `build-self-knowledge.ts`
 * and `gen-verdict-corpus.ts` already use — which gets the same code with no
 * workspace edge.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { failWithRepair } from "./lib/gate-report.js";

const ROOT = process.cwd();
const DOCKERFILE = "services/relay/Dockerfile";

/**
 * Workspace roots the Dockerfile copies wholesale, parsed from its COPY lines
 * rather than hardcoded — if someone widens the copy set, this gate follows
 * automatically instead of going stale.
 */
function copiedTrees(): string[] {
  const df = readFileSync(join(ROOT, DOCKERFILE), "utf8");
  const trees: string[] = [];
  for (const line of df.split("\n")) {
    // `COPY packages/ packages/` → the tree `packages/`
    const m = /^\s*COPY\s+(?:--\S+\s+)*([^\s]+\/)\s+\S+/.exec(line);
    if (m?.[1]) trees.push(m[1].replace(/\/+$/, ""));
  }
  return trees;
}

/** Map every workspace package name → its directory, from the workspace globs. */
function workspaceDirs(): Map<string, string> {
  const dirs = new Map<string, string>();
  for (const group of ["packages", "apps", "services"]) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSyncSafe(base)) {
      const pkgPath = join(base, entry, "package.json");
      if (!existsSync(pkgPath)) continue;
      try {
        const { name } = JSON.parse(readFileSync(pkgPath, "utf8")) as { name?: string };
        if (name) dirs.set(name, `${group}/${entry}`);
      } catch {
        // Unparseable manifest — other tooling owns that failure.
      }
    }
  }
  return dirs;
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function main(): void {
  const rootPkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const trees = copiedTrees();
  const dirs = workspaceDirs();

  const violations: Array<{ name: string; dir: string; block: string }> = [];
  for (const block of ["dependencies", "devDependencies"] as const) {
    for (const [name, range] of Object.entries(rootPkg[block] ?? {})) {
      if (!range.startsWith("workspace:")) continue;
      const dir = dirs.get(name);
      if (dir == null) continue; // unresolvable name — check-deps owns that
      const covered = trees.some((t) => dir === t || dir.startsWith(`${t}/`));
      if (!covered) violations.push({ name, dir, block });
    }
  }

  if (violations.length > 0) {
    failWithRepair({
      invariant:
        "every `workspace:*` dependency in the ROOT package.json must live under a tree the relay Dockerfile copies — otherwise `pnpm deploy --prod` cannot resolve it inside the image and the relay's deploy AND image-publish pipelines both go red, silently, while main stays green",
      sites: violations.map(
        (v) => `package.json (${v.block}) → "${v.name}": workspace:* resolves to ${v.dir}/`,
      ),
      canonical: `${DOCKERFILE} (its COPY lines define the copied trees: ${trees.join(", ")})`,
      fix: "Prefer removing the root dependency: a root-level script can import the workspace source by RELATIVE path (see scripts/build-self-knowledge.ts) and needs no workspace edge. Widen the Dockerfile COPY set only when the relay genuinely needs that package at build time — it inflates every relay build.",
      doctrine: "docs/doctrine/composition-preserves-enforcement.md",
    });
  }

  console.log(
    `✓ All root \`workspace:*\` dependencies resolve inside the relay image slice (copied trees: ${trees.join(", ")}).`,
  );
}

main();
