/**
 * publish-freshness — the pure half of `check-publish-freshness` (#161).
 *
 * Everything here is deterministic and network-free so it can be tested
 * against fixtures: which workspace packages are PUBLISHABLE, how a registry
 * answer is classified against the manifest, and how two versions order.
 * The gate script owns the network call and the git question.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface PublishablePackage {
  name: string;
  version: string;
  /** Repo-relative directory, e.g. `packages/crypto`. */
  dir: string;
}

/**
 * The `packages:` globs of a pnpm-workspace.yaml. Only the two shapes this
 * repo uses are understood — `dir/*` (one level of children) and a literal
 * directory — and the gate prints the globs it read so a third shape is a
 * visible narrowing, never a silent one.
 */
export function parseWorkspaceGlobs(yaml: string): string[] {
  const globs: string[] = [];
  let inPackages = false;
  for (const raw of yaml.split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (line.trim() === "") continue;
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!/^\s/.test(line)) {
      inPackages = false;
      continue;
    }
    if (!inPackages) continue;
    const m = line.match(/^\s*-\s*["']?([^"'\s]+)["']?\s*$/);
    if (m) globs.push(m[1]);
  }
  return globs;
}

/**
 * Every workspace package that npm would accept — a manifest with a name, a
 * version, and no `"private": true`. This is the whole candidate set: the
 * changesets `ignore` list decides who gets a version BUMP, but release.yml's
 * direct-publish step ships any public package whose manifest is ahead of
 * the registry, ignored or not, so the ignore list is not the aperture.
 */
export function publishablePackages(root: string, globs: string[]): PublishablePackage[] {
  const dirs: string[] = [];
  for (const glob of globs) {
    if (glob.endsWith("/*")) {
      const base = resolve(root, glob.slice(0, -2));
      if (!existsSync(base)) continue;
      for (const child of readdirSync(base).sort()) dirs.push(join(glob.slice(0, -2), child));
    } else {
      dirs.push(glob);
    }
  }
  const out: PublishablePackage[] = [];
  for (const dir of dirs) {
    const manifest = resolve(root, dir, "package.json");
    if (!existsSync(manifest)) continue;
    let parsed: { name?: unknown; version?: unknown; private?: unknown };
    try {
      parsed = JSON.parse(readFileSync(manifest, "utf-8")) as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.private === true) continue;
    if (typeof parsed.name !== "string" || typeof parsed.version !== "string") continue;
    out.push({ name: parsed.name, version: parsed.version, dir });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Orders two versions: negative when `a < b`, zero when equal, positive when
 * `a > b`. Numeric on the dotted core; a pre-release sorts below its release
 * and pre-release tags compare as strings. Enough for this repo's versions,
 * and inlined rather than imported so the gate has no runtime dependency.
 */
export function compareVersions(a: string, b: string): number {
  const [aCore, aPre] = a.split("-", 2);
  const [bCore, bPre] = b.split("-", 2);
  const an = aCore.split(".").map((n) => Number(n));
  const bn = bCore.split(".").map((n) => Number(n));
  for (let i = 0; i < Math.max(an.length, bn.length); i++) {
    const d = (an[i] ?? 0) - (bn[i] ?? 0);
    if (d !== 0) return d;
  }
  if (aPre === undefined && bPre === undefined) return 0;
  if (aPre === undefined) return 1;
  if (bPre === undefined) return -1;
  return aPre < bPre ? -1 : aPre > bPre ? 1 : 0;
}

/** What the registry said about one package name. */
export type RegistryAnswer =
  | { kind: "published"; latest: string }
  | { kind: "absent" }
  | { kind: "unreachable"; detail: string };

/** How a package's manifest stands against what the registry serves. */
export type Standing =
  | { kind: "current" }
  /** The registry's `latest` is older than the manifest — a publish that did not happen. */
  | { kind: "behind"; latest: string }
  /** The registry's `latest` is NEWER than the manifest — something published outside main. */
  | { kind: "ahead"; latest: string }
  /** The manifest is public and the registry has never seen the name. */
  | { kind: "unpublished" }
  | { kind: "unreachable"; detail: string };

export function classify(version: string, answer: RegistryAnswer): Standing {
  switch (answer.kind) {
    case "absent":
      return { kind: "unpublished" };
    case "unreachable":
      return { kind: "unreachable", detail: answer.detail };
    case "published": {
      const order = compareVersions(answer.latest, version);
      if (order === 0) return { kind: "current" };
      return order < 0
        ? { kind: "behind", latest: answer.latest }
        : { kind: "ahead", latest: answer.latest };
    }
  }
}

/**
 * Parse one registry document (`GET <registry>/<name>`) into an answer. The
 * abbreviated metadata format is enough: `dist-tags.latest` is what
 * `npm install <name>` resolves, which is the claim under test — not whether
 * the version exists somewhere under another tag.
 */
export function readRegistryDocument(status: number, body: string): RegistryAnswer {
  if (status === 404) return { kind: "absent" };
  if (status !== 200) return { kind: "unreachable", detail: `HTTP ${status}` };
  try {
    const doc = JSON.parse(body) as { "dist-tags"?: { latest?: unknown } };
    const latest = doc["dist-tags"]?.latest;
    if (typeof latest !== "string" || latest === "")
      return { kind: "unreachable", detail: "document carries no dist-tags.latest" };
    return { kind: "published", latest };
  } catch (err) {
    return {
      kind: "unreachable",
      detail: `unparseable document: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── The runner ──────────────────────────────────────────────────────────────
// The gate's whole verdict, with its two effects injected: the registry call
// and the git question. The script wires the real ones; the test wires a
// registry it controls and proves every verdict bites without a network.

export interface RunOptions {
  /** Repo root — where pnpm-workspace.yaml and the manifests live. */
  root: string;
  /** Registry base, e.g. `https://registry.npmjs.org`. */
  registry: string;
  /** An unreachable registry is a finding (CI) instead of a polite skip (local). */
  requireRegistry: boolean;
  /** Hours a version bump on main may wait for its publish before it is a finding. */
  pendingHours: number;
  fetch: (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<{
    status: number;
    text(): Promise<string>;
  }>;
  /** When main's manifest first carried `pkg.version`; null when git cannot say. */
  versionBumpedAt: (pkg: PublishablePackage) => Date | null;
  now: () => number;
  log: (line: string) => void;
  error: (line: string) => void;
}

export interface Finding {
  pkg: PublishablePackage;
  standing: Exclude<Standing, { kind: "current" }>;
}

export interface RunResult {
  code: 0 | 1;
  examined: number;
  findings: Finding[];
  pending: number;
}

export async function askRegistry(
  registry: string,
  name: string,
  fetchImpl: RunOptions["fetch"],
): Promise<RegistryAnswer> {
  const url = `${registry.replace(/\/+$/, "")}/${name.replace("/", "%2F")}`;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(20_000),
    });
    return readRegistryDocument(res.status, await res.text());
  } catch (err) {
    return { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function runPublishFreshness(o: RunOptions): Promise<RunResult> {
  o.log(
    `▸ check-publish-freshness — npm registry vs main (dist-tags.latest == manifest; bumps younger than ${o.pendingHours}h are pending)`,
  );

  const globs = parseWorkspaceGlobs(readFileSync(resolve(o.root, "pnpm-workspace.yaml"), "utf-8"));
  const packages = publishablePackages(o.root, globs);
  if (packages.length === 0) {
    o.error("check-publish-freshness: found 0 publishable packages — the aperture is empty.");
    o.error(
      `Fix: pnpm-workspace.yaml globs read as [${globs.join(", ")}]; scripts/lib/publish-freshness.ts understands \`dir/*\` and literal directories. A new glob shape needs the reader widened, not a green run over nothing.`,
    );
    return { code: 1, examined: 0, findings: [], pending: 0 };
  }

  const findings: Finding[] = [];
  const pending: string[] = [];
  let unreachable = 0;

  for (const pkg of packages) {
    const standing = classify(pkg.version, await askRegistry(o.registry, pkg.name, o.fetch));
    const label = `${pkg.name}@${pkg.version} (${pkg.dir})`;
    switch (standing.kind) {
      case "current":
        o.log(`  ✓ ${label} — registry serves it`);
        break;
      case "unreachable":
        unreachable++;
        if (o.requireRegistry) findings.push({ pkg, standing });
        else o.log(`  – ${label} — registry unreachable (${standing.detail}); skipping politely`);
        break;
      case "behind":
      case "unpublished": {
        const bumped = o.versionBumpedAt(pkg);
        const ageHours = bumped === null ? null : (o.now() - bumped.getTime()) / 3_600_000;
        if (ageHours !== null && ageHours < o.pendingHours) {
          pending.push(`${label} — bumped ${ageHours.toFixed(1)}h ago, publish still pending`);
        } else {
          findings.push({ pkg, standing });
        }
        break;
      }
      case "ahead":
        findings.push({ pkg, standing });
        break;
    }
  }

  for (const p of pending) o.log(`  … ${p}`);

  if (findings.length > 0) {
    o.error(`check-publish-freshness: ${findings.length} finding(s):`);
    for (const f of findings) {
      const s = f.standing;
      const what =
        s.kind === "behind"
          ? `registry latest is ${s.latest}, main declares ${f.pkg.version}`
          : s.kind === "ahead"
            ? `registry latest is ${s.latest}, NEWER than main's ${f.pkg.version}`
            : s.kind === "unpublished"
              ? `main declares ${f.pkg.version} but the registry has never seen this name`
              : `registry unreachable: ${s.detail}`;
      o.error(`  [${s.kind}] ${f.pkg.name} (${f.pkg.dir}/package.json): ${what}`);
    }
    o.error(
      "Fix: for [behind]/[unpublished] — open the newest run of .github/workflows/release.yml. If its Direct-publish step shows `E404`/`E403` on a PUT to registry.npmjs.org, the NPM_TOKEN secret is expired or lacks publish scope (npm answers 404 to an unauthorized scoped PUT): mint a granular token with read+write on scope @motebit plus `motebit` and `create-motebit`, `gh secret set NPM_TOKEN --repo motebit/motebit`, then `gh run rerun <id>`. If that run is GREEN, publish was skipped, not attempted — a fresh changeset put the workflow back in version mode — so dispatch release.yml or rerun the last failed one. For [ahead] — a version reached the registry outside main; find who published it and bring main's manifest forward. For [unreachable] — the registry did not answer; a transient outage clears on the next run, a persistent one means the runner cannot reach registry.npmjs.org.",
    );
    o.error(
      "Doctrine: docs/doctrine/composition-preserves-enforcement.md — a green release workflow is a statement about the workflow, not about the registry; docs/doctrine/release-versioning.md — a version on main is a promise the registry must keep.",
    );
    return { code: 1, examined: packages.length, findings, pending: pending.length };
  }

  o.log(
    `✓ check-publish-freshness: ${packages.length} publishable package(s) examined (every workspace manifest without \`private: true\` under ${globs.join(", ")}) — registry current${pending.length > 0 ? `, ${pending.length} pending` : ""}${unreachable > 0 ? `, ${unreachable} unreachable (skipped)` : ""}.`,
  );
  return { code: 0, examined: packages.length, findings: [], pending: pending.length };
}
