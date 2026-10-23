/**
 * security-publish — the plan check behind release.yml's manually dispatched
 * `security-publish` job.
 *
 * That job publishes an exact, founder-named list of packages at the versions
 * the authorized commit carries, through the same trusted-publisher identity
 * (motebit/motebit + release.yml, environment `npm-publish`) as the train, and
 * nothing else. This module decides whether a requested list is publishable;
 * it is pure so every refusal is testable without a registry.
 *
 * A list is publishable only when ALL hold:
 *   - it names each package once, and each is a public workspace package;
 *   - each version is a plain release (no pre-release, no build metadata);
 *   - the registry already has the package and its `latest` is strictly older
 *     than the manifest (a security patch is never a first publish, a re-publish,
 *     or a downgrade);
 *   - a listed package's listed workspace dependencies come before it (publish
 *     order is dependency order);
 *   - a listed package's UNLISTED public workspace dependencies are current on
 *     the registry, so nothing published references a version npm has not got.
 *
 * Any registry answer other than a clean one (unreachable, unparseable) refuses.
 *
 * A REHEARSAL (a dry run only) also accepts a version equal to the registry's
 * `latest`, so the whole job can be exercised on main before a fix's version
 * bumps are public. Every other rule holds.
 */
import {
  compareVersions,
  type PublishablePackage,
  type RegistryAnswer,
} from "./publish-freshness.js";

export interface PlannedPackage {
  name: string;
  version: string;
  dir: string;
  /** The registry's `latest` before this publish. */
  previous: string;
}

export type Plan = { ok: true; packages: PlannedPackage[] } | { ok: false; refusals: string[] };

const DEP_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
const PLAIN_RELEASE = /^\d+\.\d+\.\d+$/;

/** Split the dispatch input: names separated by whitespace or commas. */
export function parsePackageList(input: string): string[] {
  return input
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function workspaceDeps(pkg: PublishablePackage, publicNames: ReadonlySet<string>): string[] {
  const out = new Set<string>();
  for (const field of DEP_FIELDS) {
    const deps = pkg.raw[field];
    if (deps === null || typeof deps !== "object") continue;
    for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
      if (typeof spec === "string" && spec.startsWith("workspace:") && publicNames.has(name))
        out.add(name);
    }
  }
  return [...out].sort();
}

export function planSecurityPublish(
  requested: readonly string[],
  workspace: readonly PublishablePackage[],
  registry: ReadonlyMap<string, RegistryAnswer>,
  options: { rehearsal?: boolean } = {},
): Plan {
  const refusals: string[] = [];
  const byName = new Map(workspace.map((p) => [p.name, p]));
  const publicNames = new Set(byName.keys());

  if (requested.length === 0) refusals.push("the package list is empty");
  const seen = new Set<string>();
  for (const name of requested) {
    if (seen.has(name)) refusals.push(`${name} is listed twice`);
    seen.add(name);
  }

  const planned: PlannedPackage[] = [];
  requested.forEach((name, index) => {
    const pkg = byName.get(name);
    if (!pkg) {
      refusals.push(`${name} is not a public workspace package`);
      return;
    }
    if (!PLAIN_RELEASE.test(pkg.version))
      refusals.push(`${name}@${pkg.version} is not a plain x.y.z release`);

    const answer = registry.get(name);
    let previous = "";
    if (!answer || answer.kind === "unreachable") {
      refusals.push(
        `${name}: the registry did not answer cleanly (${answer?.kind === "unreachable" ? answer.detail : "not asked"})`,
      );
    } else if (answer.kind === "absent") {
      refusals.push(`${name} has never been published; a first publish is not a security patch`);
    } else if (options.rehearsal && compareVersions(answer.latest, pkg.version) === 0) {
      previous = answer.latest;
    } else if (compareVersions(answer.latest, pkg.version) >= 0) {
      refusals.push(
        `${name}@${pkg.version} is not ahead of the registry (latest ${answer.latest}); nothing to publish, or a downgrade`,
      );
    } else {
      previous = answer.latest;
    }

    for (const dep of workspaceDeps(pkg, publicNames)) {
      const depIndex = requested.indexOf(dep);
      if (depIndex === -1) {
        const depPkg = byName.get(dep)!;
        const depAnswer = registry.get(dep);
        if (depAnswer?.kind !== "published" || depAnswer.latest !== depPkg.version)
          refusals.push(
            `${name} depends on ${dep}@${depPkg.version}, which is not listed and is not the registry's latest (${depAnswer?.kind === "published" ? depAnswer.latest : (depAnswer?.kind ?? "not asked")}); list it, before ${name}`,
          );
      } else if (depIndex > index) {
        refusals.push(`${name} depends on ${dep}, so ${dep} must be listed before it`);
      }
    }

    planned.push({ name, version: pkg.version, dir: pkg.dir, previous });
  });

  return refusals.length > 0 ? { ok: false, refusals } : { ok: true, packages: planned };
}

/** Every public workspace dependency of the listed packages, for asking the registry once. */
export function registryQuestions(
  requested: readonly string[],
  workspace: readonly PublishablePackage[],
): string[] {
  const byName = new Map(workspace.map((p) => [p.name, p]));
  const publicNames = new Set(byName.keys());
  const names = new Set<string>(requested);
  for (const name of requested) {
    const pkg = byName.get(name);
    if (pkg) for (const dep of workspaceDeps(pkg, publicNames)) names.add(dep);
  }
  return [...names].sort();
}

/**
 * The public packages whose manifest is ahead of npm (behind on the registry,
 * or never published), or `null` when the registry did not answer for one:
 * the caller must then fail, never read silence as "nothing to publish".
 */
export function packagesAhead(
  workspace: readonly PublishablePackage[],
  registry: ReadonlyMap<string, RegistryAnswer>,
): string[] | null {
  const ahead: string[] = [];
  for (const pkg of workspace) {
    const answer = registry.get(pkg.name);
    if (!answer || answer.kind === "unreachable") return null;
    if (answer.kind === "absent" || compareVersions(answer.latest, pkg.version) < 0)
      ahead.push(`${pkg.name}@${pkg.version}`);
  }
  return ahead;
}

export interface PackedArtifact {
  name: string;
  version: string;
  tarball: string;
  integrity: string;
  /** The registry's `latest` when the plan was made. */
  previous: string;
}

export type PublishStep =
  | { kind: "publish"; name: string; version: string; args: string[] }
  | { kind: "skip"; name: string; version: string; reason: string };

/**
 * What the Publish step does with each packed artifact, in order. A real run
 * publishes every one. A dry run passes `--dry-run`, except for a version the
 * registry already has: npm refuses even a dry run over a published version,
 * so a rehearsal names it and moves on. A dry run uploads nothing, so it
 * proves neither the OIDC publish nor the provenance attestation; only a real
 * publish does.
 */
export function publishSteps(artifacts: readonly PackedArtifact[], dryRun: boolean): PublishStep[] {
  return artifacts.map((a) => {
    if (dryRun && a.version === a.previous)
      return {
        kind: "skip",
        name: a.name,
        version: a.version,
        reason: `${a.name}@${a.version} is already on npm; npm refuses even a dry run over a published version`,
      };
    const args = ["publish", a.tarball, "--provenance", "--access", "public"];
    if (dryRun) args.push("--dry-run");
    return { kind: "publish", name: a.name, version: a.version, args };
  });
}
