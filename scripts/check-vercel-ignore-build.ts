/**
 * Vercel Ignored Build Step routes through scripts/vercel-ignore-build.sh.
 *
 * Every `vercel.json` in the repo that declares an `ignoreCommand` must make
 * it exactly `sh <relative path to scripts/vercel-ignore-build.sh> <args>` —
 * no shell composition (`||`, `&&`, `;`, `|`, `$(`, backticks) that could
 * change the exit status the script decides. The script is the one place the
 * invariant lives: a PRODUCTION build (VERCEL_ENV=production, a push to main)
 * is never skipped; a preview is skipped only when proven safe; every error
 * builds (Vercel: exit 0 = skip, exit 1 = build).
 *
 * #1012: a proxy security fix merged to main as 42ce27f and Vercel reported
 * `motebit-proxy: Canceled by Ignored Build Step`, so production never got
 * the fix. The inline `git diff --quiet … -- services/proxy/ …` ran from the
 * project's Root Directory (services/proxy), where the repo-root pathspecs
 * match nothing — so it exited 0 (skip) on every commit, production included.
 *
 * Arguments are checked too, so a preview skip cannot be "proven" over the
 * wrong set:
 *   - paths mode: every path exists (repo-root relative), and the set covers
 *     the project's own directory, pnpm-lock.yaml, the root package.json and
 *     the directory of every workspace package in the project's transitive
 *     `workspace:` dependency closure (dependencies, devDependencies,
 *     peerDependencies, optionalDependencies);
 *   - `--turbo-ignore <name>`: <name> is the project's own package name.
 *
 * A vercel.json WITHOUT an ignoreCommand is not a violation (it always
 * builds from the repo's point of view) but is listed: its project's ignore
 * step may be configured in the Vercel dashboard, which this gate cannot see.
 *
 * Exit 1 on any violation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";
import { failWithRepair } from "./lib/gate-report.js";

const ROOT = process.cwd();
const SCRIPT = "scripts/vercel-ignore-build.sh";
const WORKSPACE_GLOB_DIRS = ["packages", "apps", "services"];
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", ".turbo", "dist", "out", ".vercel"]);
const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

interface Manifest {
  name?: string;
  [field: string]: unknown;
}

function findVercelJsons(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) findVercelJsons(full, out);
    else if (entry === "vercel.json") out.push(relative(ROOT, full).split("\\").join("/"));
  }
}

function workspaceManifests(): Map<string, { dir: string; manifest: Manifest }> {
  const out = new Map<string, { dir: string; manifest: Manifest }>();
  for (const group of WORKSPACE_GLOB_DIRS) {
    if (!existsSync(join(ROOT, group))) continue;
    for (const d of readdirSync(join(ROOT, group))) {
      const p = join(ROOT, group, d, "package.json");
      if (!existsSync(p)) continue;
      const manifest = JSON.parse(readFileSync(p, "utf8")) as Manifest;
      if (typeof manifest.name === "string")
        out.set(manifest.name, { dir: `${group}/${d}`, manifest });
    }
  }
  return out;
}

function closureDirs(
  start: string,
  ws: Map<string, { dir: string; manifest: Manifest }>,
): string[] {
  const seen = new Set<string>();
  const stack = [start];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const m = ws.get(name)?.manifest;
    if (m == null) continue;
    for (const field of DEP_FIELDS) {
      const deps = m[field];
      if (deps == null || typeof deps !== "object") continue;
      for (const [dep, spec] of Object.entries(deps as Record<string, unknown>)) {
        if (String(spec).startsWith("workspace:") && ws.has(dep)) stack.push(dep);
      }
    }
  }
  return [...seen]
    .map((n) => ws.get(n)?.dir)
    .filter((d): d is string => d != null)
    .sort();
}

const norm = (p: string) => posix.normalize(p).replace(/\/+$/, "");

function main(): void {
  if (!existsSync(join(ROOT, SCRIPT))) {
    failWithRepair({
      invariant: `${SCRIPT} must exist — it is the one Ignored Build Step every Vercel project routes through`,
      canonical: SCRIPT,
      fix: `Restore ${SCRIPT} from git history (git log -- ${SCRIPT}).`,
    });
  }

  const files: string[] = [];
  findVercelJsons(ROOT, files);
  files.sort();
  const ws = workspaceManifests();
  const violations: string[] = [];
  const routed: string[] = [];
  const noIgnore: string[] = [];

  for (const file of files) {
    const projectDir = dirname(file);
    let cfg: { ignoreCommand?: unknown };
    try {
      cfg = JSON.parse(readFileSync(join(ROOT, file), "utf8")) as { ignoreCommand?: unknown };
    } catch (err) {
      violations.push(
        `${file}: not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    if (cfg.ignoreCommand === undefined) {
      noIgnore.push(projectDir);
      continue;
    }
    const cmd = cfg.ignoreCommand;
    if (typeof cmd !== "string") {
      violations.push(`${file}: ignoreCommand is not a string`);
      continue;
    }
    if (/\|\||&&|[;|`&<>\n]|\$\(/.test(cmd)) {
      violations.push(
        `${file}: ignoreCommand composes shell (\`${cmd}\`) — the script's exit status must be the command's exit status`,
      );
      continue;
    }
    const expectedScript = posix.relative(projectDir, SCRIPT);
    const tokens = cmd.trim().split(/\s+/);
    if (tokens[0] !== "sh" || tokens[1] !== expectedScript) {
      violations.push(
        `${file}: ignoreCommand \`${cmd}\` does not start with \`sh ${expectedScript}\` (the command runs from ${projectDir})`,
      );
      continue;
    }
    const args = tokens.slice(2);
    const ownName = existsSync(join(ROOT, projectDir, "package.json"))
      ? (JSON.parse(readFileSync(join(ROOT, projectDir, "package.json"), "utf8")) as Manifest).name
      : undefined;

    if (args[0] === "--turbo-ignore") {
      if (args.length !== 2 || ownName == null || args[1] !== ownName) {
        violations.push(
          `${file}: \`--turbo-ignore\` must name exactly the project's own package (${ownName ?? "no package.json"}), got \`${args.slice(1).join(" ")}\``,
        );
        continue;
      }
      routed.push(`${projectDir} (turbo-ignore ${ownName})`);
      continue;
    }

    if (args.length === 0) {
      violations.push(`${file}: no watched paths passed to ${SCRIPT}`);
      continue;
    }
    const given = new Set(args.map(norm));
    for (const p of given) {
      if (p.startsWith("/") || p.startsWith("..") || !existsSync(resolve(ROOT, p))) {
        violations.push(`${file}: watched path \`${p}\` does not exist relative to the repo root`);
      }
    }
    const required = new Set<string>(["pnpm-lock.yaml", "package.json", norm(projectDir)]);
    if (ownName != null) for (const d of closureDirs(ownName, ws)) required.add(d);
    const missing = [...required].filter((r) => !given.has(r)).sort();
    if (missing.length > 0) {
      violations.push(
        `${file}: watched paths miss ${missing.map((m) => `\`${m}\``).join(", ")} (the project dir, the root manifests, or a workspace package in ${ownName ?? projectDir}'s transitive workspace closure)`,
      );
      continue;
    }
    routed.push(`${projectDir} (${given.size} paths)`);
  }

  if (violations.length > 0) {
    failWithRepair({
      invariant: `every vercel.json ignoreCommand must route through ${SCRIPT} — a production build is never skipped, a preview is skipped only when proven safe over the right paths (#1012: proxy security fix 42ce27f was "Canceled by Ignored Build Step" on main)`,
      sites: violations,
      canonical: SCRIPT,
      fix: `Set the project's ignoreCommand to \`sh <relative path to ${SCRIPT}> <repo-root paths…>\` (include the project dir, pnpm-lock.yaml, package.json and every workspace dependency dir) or \`sh <relative path to ${SCRIPT}> --turbo-ignore <own package name>\`; never compose it with || / && / ;. Then run \`pnpm check-vercel-ignore-build\`.`,
    });
  }

  console.log(
    `✓ Vercel ignore step: ${files.length} vercel.json file(s) found, ${routed.length} route their ignoreCommand through ${SCRIPT} [${routed.join("; ")}], ${noIgnore.length} declare none [${noIgnore.join(", ")}] (any dashboard-configured ignore step is not visible to this gate).`,
  );
}

main();
