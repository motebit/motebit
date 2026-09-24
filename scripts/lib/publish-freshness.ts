/**
 * publish-freshness — the pure half of `check-publish-freshness` (#161), and
 * the ONE enumerator of "publishable workspace package" that
 * `wait-for-npm-propagation` and `check-publishable-package-metadata` also
 * consume (three hand-rolled copies had three definitions).
 *
 * Everything here is deterministic; the two effects — the registry call and
 * the git question — are injected, so every verdict is proven to bite in
 * `scripts/__tests__/check-publish-freshness.test.ts` without a network.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface PublishablePackage {
  name: string;
  version: string;
  /** Repo-relative directory, e.g. `packages/crypto`. */
  dir: string;
  /** The parsed manifest, for callers that read more than name/version. */
  raw: Record<string, unknown>;
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

/** The globs of this repo's own pnpm-workspace.yaml. */
export function workspaceGlobs(root: string): string[] {
  return parseWorkspaceGlobs(readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf-8"));
}

/**
 * Every workspace package that npm would accept — a manifest with a name, a
 * version, no `"private": true`, and not the `0.0.0-private` marker
 * (`docs/doctrine/promoting-private-to-public.md`: a public-shaped manifest
 * that has not been promoted yet). This is the whole candidate set: the
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
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(readFileSync(manifest, "utf-8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (raw.private === true) continue;
    if (typeof raw.name !== "string" || typeof raw.version !== "string") continue;
    if (raw.version === "0.0.0-private") continue;
    out.push({ name: raw.name, version: raw.version, dir, raw });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Orders two versions: negative when `a < b`, zero when equal, positive when
 * `a > b`. Numeric on the dotted core; a pre-release sorts below its release,
 * and pre-release identifiers compare per semver §11 — dot-separated, numeric
 * identifiers numerically (`rc.10 > rc.9`), otherwise as strings, numeric
 * below alphanumeric, the shorter list first when all shared parts agree.
 * Inlined rather than imported so the gate has no runtime dependency.
 */
export function compareVersions(a: string, b: string): number {
  const [aCore, aPre] = splitPre(a);
  const [bCore, bPre] = splitPre(b);
  const an = aCore.split(".").map((n) => Number(n));
  const bn = bCore.split(".").map((n) => Number(n));
  for (let i = 0; i < Math.max(an.length, bn.length); i++) {
    const d = (an[i] ?? 0) - (bn[i] ?? 0);
    if (d !== 0) return d;
  }
  if (aPre === null && bPre === null) return 0;
  if (aPre === null) return 1;
  if (bPre === null) return -1;
  const ap = aPre.split(".");
  const bp = bPre.split(".");
  for (let i = 0; i < Math.min(ap.length, bp.length); i++) {
    const x = ap[i];
    const y = bp[i];
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (xn !== yn) {
      return xn ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return ap.length - bp.length;
}

function splitPre(v: string): [string, string | null] {
  const plus = v.indexOf("+");
  const noBuild = plus === -1 ? v : v.slice(0, plus);
  const dash = noBuild.indexOf("-");
  return dash === -1 ? [noBuild, null] : [noBuild.slice(0, dash), noBuild.slice(dash + 1)];
}

/**
 * The grace-window width from its environment variable. A value that is not a
 * finite non-negative number is refused with a message, never silently read
 * as NaN — `Number("6h")` would disable the window and send every fresh bump
 * to the token repair without saying why.
 */
export function parsePendingHours(
  raw: string | undefined,
): { ok: true; hours: number } | { ok: false; reason: string } {
  if (raw === undefined || raw === "") return { ok: true, hours: 6 };
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours < 0)
    return {
      ok: false,
      reason: `PUBLISH_FRESHNESS_HOURS=${JSON.stringify(raw)} is not a finite non-negative number of hours`,
    };
  return { ok: true, hours };
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

/**
 * The commit that gave the manifest its current version, and what the
 * manifest said before it. `previous` is null when the manifest (or its
 * version) did not exist before — a first publish.
 */
export interface Bump {
  at: Date;
  previous: string | null;
}

/**
 * Whether a missing publish is still PENDING (the train merges the bump and
 * publishes minutes later) or a finding. Two conditions, both required:
 *
 *  - the bump is younger than the window, and
 *  - the registry serves EXACTLY the version main had before the bump (or,
 *    for a name the registry has never seen, main had no version before —
 *    a first publish).
 *
 * The second condition is what keeps the grace from masking the incident:
 * a fresh bump over a registry that has been stale for weeks has a young
 * bump time but a `latest` that is not the previous version, so it is
 * `behind` today, not `pending` for a day. An unknown bump (null) is never
 * grace: an unanswerable question is not a reason to call a gap pending.
 */
export function isPending(
  standing: { kind: "behind"; latest: string } | { kind: "unpublished" },
  bump: Bump | null,
  pendingHours: number,
  now: number,
): boolean {
  if (bump === null) return false;
  const ageHours = (now - bump.at.getTime()) / 3_600_000;
  if (!(ageHours < pendingHours)) return false;
  return standing.kind === "behind" ? bump.previous === standing.latest : bump.previous === null;
}

// ── The runner ──────────────────────────────────────────────────────────────

export interface RunOptions {
  /** Repo root — where pnpm-workspace.yaml and the manifests live. */
  root: string;
  /** Registry base, e.g. `https://registry.npmjs.org`. */
  registry: string;
  /** An unreachable registry is a finding (CI) instead of a polite skip (local). */
  requireRegistry: boolean;
  /** Hours a version bump on main may wait for its publish before it is a finding. */
  pendingHours: number;
  /** Per-request registry timeout. */
  timeoutMs?: number;
  fetch: (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<{ status: number; text(): Promise<string> }>;
  /** When main's manifest first carried `pkg.version`, and what it said before; null when git cannot say. */
  versionBumpedAt: (pkg: PublishablePackage) => Bump | null;
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
  /** Packages in the candidate set. */
  examined: number;
  /** Packages the registry actually answered about. */
  verified: number;
  findings: Finding[];
  pending: number;
}

export async function askRegistry(
  registry: string,
  name: string,
  fetchImpl: RunOptions["fetch"],
  timeoutMs = 20_000,
): Promise<RegistryAnswer> {
  const url = `${registry.replace(/\/+$/, "")}/${name.replace("/", "%2F")}`;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/vnd.npm.install-v1+json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    return readRegistryDocument(res.status, await res.text());
  } catch (err) {
    return { kind: "unreachable", detail: err instanceof Error ? err.message : String(err) };
  }
}

export async function runPublishFreshness(o: RunOptions): Promise<RunResult> {
  o.log(
    `▸ check-publish-freshness — npm registry vs main (dist-tags.latest == manifest; a bump younger than ${o.pendingHours}h over the previous version is pending)`,
  );

  const globs = workspaceGlobs(o.root);
  const packages = publishablePackages(o.root, globs);
  if (packages.length === 0) {
    o.error("check-publish-freshness: found 0 publishable packages — the aperture is empty.");
    o.error(
      `Fix: pnpm-workspace.yaml globs read as [${globs.join(", ")}]; scripts/lib/publish-freshness.ts understands \`dir/*\` and literal directories. A new glob shape needs the reader widened, not a green run over nothing.`,
    );
    return { code: 1, examined: 0, verified: 0, findings: [], pending: 0 };
  }

  // One round-trip for the whole set: an outage costs one timeout, not one
  // per package. Order is restored by the sorted candidate list.
  const answers = await Promise.all(
    packages.map((pkg) => askRegistry(o.registry, pkg.name, o.fetch, o.timeoutMs)),
  );

  const findings: Finding[] = [];
  const pending: string[] = [];
  let unreachable = 0;

  packages.forEach((pkg, i) => {
    const standing = classify(pkg.version, answers[i]);
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
        const bump = o.versionBumpedAt(pkg);
        if (isPending(standing, bump, o.pendingHours, o.now())) {
          const age = ((o.now() - (bump as Bump).at.getTime()) / 3_600_000).toFixed(1);
          pending.push(
            `${label} — bumped ${age}h ago from ${standing.kind === "behind" ? standing.latest : "nothing"}, publish still pending`,
          );
        } else {
          findings.push({ pkg, standing });
        }
        break;
      }
      case "ahead":
        findings.push({ pkg, standing });
        break;
    }
  });

  for (const p of pending) o.log(`  … ${p}`);
  const verified = packages.length - unreachable;

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
      "Fix: for [behind]/[unpublished] — open the newest run of .github/workflows/release.yml. If its Direct-publish step shows `E404`/`E403` on a PUT to registry.npmjs.org, the registry refused the credential (npm answers 404 to an unauthorized scoped PUT): publishing is by trusted publishing (OIDC), so check that the package has a Trusted Publisher entry at npmjs.com naming motebit/motebit + release.yml and that no NODE_AUTH_TOKEN is set in the job (a token present makes the CLI skip OIDC; an expired one is how six weeks of releases went unpublished in 2026) — then `gh run rerun <id>`. If that run is GREEN, publish was skipped, not attempted — a fresh changeset put the workflow back in version mode — so dispatch release.yml or rerun the last failed one. For [ahead] — a version reached the registry outside main; find who published it and bring main's manifest forward. For [unreachable] — the registry did not answer; this is NOT a token problem: a transient outage clears on the next run, a persistent one means the runner cannot reach registry.npmjs.org.",
    );
    o.error(
      "Doctrine: docs/doctrine/composition-preserves-enforcement.md — a green release workflow is a statement about the workflow, not about the registry; docs/doctrine/release-versioning.md — a version on main is a promise the registry must keep.",
    );
    return { code: 1, examined: packages.length, verified, findings, pending: pending.length };
  }

  const scope = `${packages.length} publishable package(s) examined (every workspace manifest without \`private: true\` or \`0.0.0-private\` under ${globs.join(", ")})`;
  if (verified === 0) {
    o.log(
      `– check-publish-freshness: ${scope} — registry unreachable for all of them, NOTHING verified (skipped; CI runs with --require-registry, where this is red).`,
    );
  } else {
    o.log(
      `✓ check-publish-freshness: ${scope} — ${verified} verified against the registry${pending.length > 0 ? `, ${pending.length} pending` : ""}${unreachable > 0 ? `, ${unreachable} unreachable (skipped, not verified)` : ""}.`,
    );
  }
  return { code: 0, examined: packages.length, verified, findings: [], pending: pending.length };
}
