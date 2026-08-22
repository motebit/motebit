#!/usr/bin/env tsx
/**
 * `check-archetype-slate` — three-way parity for the archetype slate
 * (docs/doctrine/agent-archetypes.md).
 *
 * The slate is declared in four places that MUST agree on
 * (service, capability, display-name):
 *
 *   1. `scripts/deploy-archetype-slate.ts` `SLATE`         — what deploys
 *   2. `scripts/archetype-conformance.ts` `ARCHETYPES`     — what the daily probe checks
 *   3. `apps/docs/content/docs/developer/agent-archetypes.mdx` slate table — what the gallery claims
 *   4. `.github/workflows/deploy-archetype-staging.yml` matrix — what STAYS FRESH
 *
 * Drift class: a service added to the deploy ceremony but not the probe is
 * a showcase the conformance run silently stops proving ("they work"
 * becomes marketing); a gallery row with no deployed backing is a
 * documented lie. Same shape as the other structural-parity gates
 * (`check-computer-use-dispatcher-parity`, `check-tool-guard-parity`) —
 * textual extraction from each surface, set equality across all four.
 *
 * Surface 4 was added after #570: the probe graded a staging slate that no
 * workflow deployed, so a fix merged to main (#564) never reached the
 * processes it fixed and the probe stayed red for nine days against an
 * already-solved bug. Membership of the freshness matrix is therefore part
 * of what it MEANS to be on the slate — an archetype nobody redeploys is
 * one the conformance verdict cannot speak for.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface SlateRow {
  service: string;
  capability: string;
  displayName: string;
}

function read(path: string): string {
  try {
    return readFileSync(resolve(ROOT, path), "utf8");
  } catch {
    console.error(`check-archetype-slate: cannot read ${path}.`);
    console.error(
      "Fix: the slate lives in scripts/deploy-archetype-slate.ts (SLATE), scripts/archetype-conformance.ts (ARCHETYPES), and apps/docs/content/docs/developer/agent-archetypes.mdx (slate table) — all three must exist.",
    );
    process.exit(1);
  }
}

/** Deploy SLATE: object entries with name/capability (displayName lives in the service source, not the deploy script). */
function parseDeploySlate(src: string): Map<string, string> {
  const services = new Map<string, string>();
  const entryPattern = /name:\s*"([a-z-]+)",[\s\S]*?capability:\s*"([a-z_]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = entryPattern.exec(src)) !== null) {
    services.set(m[1] as string, m[2] as string);
  }
  return services;
}

/**
 * Staging freshness matrix: the `service:` list between the `slate:begin` /
 * `slate:end` markers in the staging deploy workflow. Markers rather than a
 * bare YAML walk so the extraction cannot silently start matching some other
 * list if the workflow grows one.
 */
function parseStagingMatrix(src: string): Set<string> {
  const block = /#\s*slate:begin([\s\S]*?)#\s*slate:end/.exec(src);
  if (block == null) return new Set();
  const services = new Set<string>();
  const pattern = /^\s*-\s*([a-z-]+)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(block[1] as string)) !== null) services.add(m[1] as string);
  return services;
}

/** Conformance ARCHETYPES: service/capability/displayName literals. */
function parseConformance(src: string): SlateRow[] {
  const rows: SlateRow[] = [];
  const pattern =
    /\{\s*service:\s*"([a-z-]+)",\s*capability:\s*"([a-z_]+)",\s*displayName:\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(src)) !== null) {
    rows.push({ service: m[1] as string, capability: m[2] as string, displayName: m[3] as string });
  }
  return rows;
}

/** Gallery table: | `service` | `capability` | Display name or — | kind | price |. */
function parseGalleryTable(src: string): SlateRow[] {
  const rows: SlateRow[] = [];
  const pattern = /^\|\s*`([a-z-]+)`\s*\|\s*`([a-z_]+)`\s*\|\s*([^|]+?)\s*\|/gm;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(src)) !== null) {
    const name = (m[3] as string).trim();
    rows.push({
      service: m[1] as string,
      capability: m[2] as string,
      displayName: name === "—" ? "" : name,
    });
  }
  return rows;
}

/**
 * The capabilities a service actually advertises, read from its
 * `capabilities: [...]` array in `services/<name>/src/index.ts`. Returns
 * null when the source can't be read (the parity checks still run — this
 * is an additive reality check, not a hard dependency).
 */
function serviceAdvertisedCapabilities(service: string): string[] | null {
  let src: string;
  try {
    src = readFileSync(resolve(ROOT, `services/${service}/src/index.ts`), "utf8");
  } catch {
    return null;
  }
  // Union every `capabilities: [...]` array (config + getServiceListing),
  // EXCLUDING `required_capabilities:` (inner-delegation args, not what the
  // service itself advertises). A service may list its caps in more than
  // one place; the union is what discovery sees.
  const caps = new Set<string>();
  const arrayPattern = /(?<!required_)capabilities:\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = arrayPattern.exec(src)) !== null) {
    const q = /"([^"]+)"/g;
    let mm: RegExpExecArray | null;
    while ((mm = q.exec(m[1] ?? "")) !== null) caps.add(mm[1] as string);
  }
  return caps.size > 0 ? [...caps] : null;
}

function main(): void {
  console.log(
    "▸ check-archetype-slate — deploy SLATE × conformance ARCHETYPES × docs gallery table × staging freshness matrix four-way parity + service-reality check",
  );

  const deploy = parseDeploySlate(read("scripts/deploy-archetype-slate.ts"));
  const conformance = parseConformance(read("scripts/archetype-conformance.ts"));
  const gallery = parseGalleryTable(read("apps/docs/content/docs/developer/agent-archetypes.mdx"));
  const staging = parseStagingMatrix(read(".github/workflows/deploy-archetype-staging.yml"));

  if (deploy.size === 0 || conformance.length === 0 || gallery.length === 0 || staging.size === 0) {
    console.error(
      `check-archetype-slate: parse failure (deploy=${deploy.size}, conformance=${conformance.length}, gallery=${gallery.length}, staging-matrix=${staging.size} entries).`,
    );
    console.error(
      "Fix: keep SLATE entries as literal { name, capability } objects, ARCHETYPES as literal { service, capability, displayName } objects, the gallery slate table rows as | `service` | `capability` | Display name |, and the staging matrix as a `- <service>` list between the `# slate:begin` / `# slate:end` markers in .github/workflows/deploy-archetype-staging.yml.",
    );
    process.exit(1);
  }

  const violations: string[] = [];

  const confByService = new Map(conformance.map((r) => [r.service, r]));
  const galByService = new Map(gallery.map((r) => [r.service, r]));
  const allServices = new Set([
    ...deploy.keys(),
    ...confByService.keys(),
    ...galByService.keys(),
    ...staging,
  ]);

  for (const svc of allServices) {
    const d = deploy.get(svc);
    const c = confByService.get(svc);
    const g = galByService.get(svc);
    if (d == null)
      violations.push(`  ${svc}: missing from deploy SLATE (deploy-archetype-slate.ts)`);
    if (c == null)
      violations.push(`  ${svc}: missing from conformance ARCHETYPES (archetype-conformance.ts)`);
    if (g == null)
      violations.push(`  ${svc}: missing from the docs gallery slate table (agent-archetypes.mdx)`);
    // FRESHNESS drift — a slate service the staging workflow does not deploy
    // is graded by the daily probe against whatever code was hand-deployed
    // last. That is #570: nine red days against a bug already fixed in main.
    if (!staging.has(svc))
      violations.push(
        `  ${svc}: missing from the staging freshness matrix (deploy-archetype-staging.yml) — the conformance probe would grade it against stale code`,
      );
    if (d != null && c != null && d !== c.capability) {
      violations.push(
        `  ${svc}: capability drift — deploy "${d}" vs conformance "${c.capability}"`,
      );
    }
    if (c != null && g != null && c.capability !== g.capability) {
      violations.push(
        `  ${svc}: capability drift — conformance "${c.capability}" vs gallery "${g.capability}"`,
      );
    }
    if (c != null && g != null && c.displayName !== g.displayName) {
      violations.push(
        `  ${svc}: display-name drift — conformance "${c.displayName}" vs gallery "${g.displayName}"`,
      );
    }
    // SERVICE-REALITY drift — the capability the slate routes on must be
    // one the SERVICE actually advertises. The three declarations agreeing
    // with each other is not enough (they all agreed on "summarize" while
    // the service advertised "summarize_search", so discover-by-capability
    // found nothing and the deployed slate was silently un-discoverable).
    if (d != null) {
      const advertised = serviceAdvertisedCapabilities(svc);
      if (advertised != null && !advertised.includes(d)) {
        violations.push(
          `  ${svc}: slate capability "${d}" is not advertised by services/${svc}/src/index.ts (it advertises: ${advertised.map((a) => `"${a}"`).join(", ")})`,
        );
      }
    }
  }

  if (violations.length > 0) {
    console.error(`check-archetype-slate: ${violations.length} parity violation(s):`);
    for (const v of violations) console.error(v);
    console.error(
      "Fix: the slate is one vocabulary declared in four surfaces — update scripts/deploy-archetype-slate.ts (SLATE), scripts/archetype-conformance.ts (ARCHETYPES), the slate table in apps/docs/content/docs/developer/agent-archetypes.mdx, and the matrix in .github/workflows/deploy-archetype-staging.yml in the same commit.",
    );
    console.error("Doctrine: docs/doctrine/agent-archetypes.md.");
    process.exit(1);
  }

  console.log(
    `✓ check-archetype-slate: ${allServices.size} slate service(s) in four-way parity (deploy × conformance × gallery × staging-freshness).`,
  );
}

main();
