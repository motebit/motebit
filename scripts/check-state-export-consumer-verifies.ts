#!/usr/bin/env tsx
/**
 * check-state-export-consumer-verifies — synchronization invariant
 * for the consumer side of the state-export-signing arc.
 *
 * Doctrine: `docs/doctrine/nist-alignment.md` §8 "Third-party verifier";
 * `docs/doctrine/self-attesting-system.md`. Seventh closed-registry /
 * structural-lock drift gate, completing the producer-consumer-gate
 * triple for state-export:
 *
 *   producer: `services/relay/src/state-export.ts` emits a manifest
 *             via `emitSignedExport` (drift-locked by #86
 *             check-state-export-signed)
 *   consumer: every fetch to `/api/v1/{state,memory,audit,goals,
 *             plans,conversations,devices,gradient,sync,execution}/...`
 *             from `apps/`, `packages/`, or `services/*-client/`
 *             code MUST route through `@motebit/state-export-client`'s
 *             `verifiedStateExportFetch` (this gate)
 *   registry: `ContentArtifactType` literal union is closed
 *             (drift-locked by #85 check-artifact-type-canonical)
 *
 * Pre-this-gate, the producer signed but no consumer demanded the
 * signature — producer-only signing is invisible truth that the
 * lattice cannot enforce. A relay that silently stops signing breaks
 * no consumer, the drift gate on the producer side passes vacuously,
 * and the doctrine's "self-attesting" claim collapses into ceremony.
 * This gate closes that hole at the consumer-wiring layer.
 *
 * Forbidden: a source file containing a URL template that matches the
 * state-export endpoint shape (`/api/v1/{state|memory|audit|goals|
 * plans|conversations|devices|gradient|sync|execution}/...`) that
 * does NOT import from `@motebit/state-export-client`.
 *
 *   ✗  const res = await fetch(`/api/v1/audit/${motebitId}`);
 *      // direct fetch — manifest discarded, producer signature ignored
 *
 *   ✓  import { verifiedStateExportFetch } from "@motebit/state-export-client";
 *      const res = await verifiedStateExportFetch(`/api/v1/audit/${motebitId}`, { anchor });
 *
 * Scope: `apps/*` and `packages/*` source. Excludes the producer
 * (`services/relay/src/state-export.ts`), the verifier package
 * itself (`packages/state-export-client/`), and tests.
 *
 * Adding a new state-export consumer requires importing
 * `@motebit/state-export-client` and routing the fetch through the
 * verified wrapper. Allowlist entries (in `CONSUMER_ALLOWLIST` below)
 * exist for declarative or documentation references that name the
 * URL shape without actually fetching it.
 *
 * Usage:
 *   tsx scripts/check-state-export-consumer-verifies.ts        # exit 1 on violation
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");

/**
 * Endpoint families the relay's `state-export.ts` registers. Mirrors
 * the path roots `app.get("/api/v1/{category}/:motebitId/...")`
 * consumes; any direct fetch matching this shape from a consumer
 * file must route through the verifier package.
 *
 * The trailing `\$\{` requires a template-variable interpolation
 * after `category/` — narrowing to URLs of the form
 * `/api/v1/audit/${motebitId}`. This excludes adjacent non-state-
 * export endpoints under the same `/api/v1/{category}/` prefix
 * (e.g. `/api/v1/devices/register-self`, the device-self-registration
 * POST that lives next to the device-list GET). Motebit consumers
 * use template-literal URLs by convention; string-concat URLs would
 * miss the gate but also miss the codebase's idiom.
 */
const STATE_EXPORT_PATH_RE =
  /["'`]\/api\/v1\/(?:state|memory|audit|goals|plans|conversations|devices|gradient|sync|execution)\/\$\{/g;

const VERIFIER_PACKAGE = "@motebit/state-export-client";

/**
 * Actual import statement (not a casual string mention in a comment
 * or a doctrine reference). Catches both ESM `from "..."` and CJS
 * `require("...")` shapes. A file that imports just types is allowed
 * — type-only imports still surface the contract.
 */
const VERIFIER_IMPORT_RE = new RegExp(
  `(?:from\\s+|require\\s*\\(\\s*)["']${VERIFIER_PACKAGE.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}["']`,
);

/**
 * Files allowed to reference state-export URLs WITHOUT importing the
 * verifier package. Reasons must be intentional — typo or new-consumer
 * additions belong as a verifier-routed fetch, not as an allowlist
 * entry.
 */
const CONSUMER_ALLOWLIST: Record<string, string> = {
  // Surface-agnostic doctrine reference inside the closed `ContentArtifactType`
  // registry — names the URL shape per artifact-type for documentation,
  // does not fetch.
  "packages/protocol/src/artifact-type.ts":
    "doctrine-shape reference: ContentArtifactType registry comments name the URL per type for documentation; no runtime fetch.",
  // Sovereign panel is the surface-agnostic delegator: per @motebit/panels'
  // zero-dep rule it must NOT import the browser verifier directly, so
  // verification is adapter-supplied (panels Rule 3, like auth). The
  // controller routes /api/v1/goals through the optional `verifiedFetch`
  // adapter method when present and records the verification status in
  // state. The verifier import lives in the SURFACE adapter — apps/web's
  // sovereign-panels.ts wraps verifiedStateExportFetch (wired 2026-05-23);
  // desktop + mobile implement `verifiedFetch` next (staged, like the
  // getLocalIdentity?/getLocalLedger? optional-capability pattern). This
  // entry stays because the controller legitimately delegates rather than
  // importing the verifier; it is not pending-but-unbuilt.
  "packages/panels/src/sovereign/controller.ts":
    "surface-agnostic delegator: verification is adapter-supplied via the optional `verifiedFetch` method (panels zero-dep rule). The verifier import lives in each surface adapter — apps/web wired 2026-05-23, desktop/mobile staged.",
};

const SCAN_ROOTS = [join(REPO_ROOT, "apps"), join(REPO_ROOT, "packages")];

/**
 * Source files that DEFINE state-export endpoints (the relay side)
 * or that ARE the verifier itself — excluded from the gate because
 * URL references here are producer- or verifier-internal, not
 * consumer fetches.
 */
const FILE_EXCLUSIONS = new Set<string>([
  "services/relay/src/state-export.ts",
  "packages/state-export-client/src/verified-fetch.ts",
  "packages/state-export-client/src/transparency-anchor.ts",
  "packages/state-export-client/src/index.ts",
]);

interface Finding {
  file: string;
  line: number;
  literal: string;
  context: string;
}

function walkTs(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "__tests__" ||
        entry.name === "dist" ||
        entry.name === "node_modules" ||
        entry.name === ".turbo" ||
        entry.name === ".next"
      ) {
        continue;
      }
      walkTs(full, out);
    } else if (
      (entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) ||
      entry.name.endsWith(".tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

function isTestFile(rel: string): boolean {
  return (
    rel.includes("/__tests__/") ||
    rel.endsWith(".test.ts") ||
    rel.endsWith(".test.tsx") ||
    rel.endsWith(".spec.ts") ||
    rel.endsWith(".spec.tsx")
  );
}

function scanFile(abs: string): Finding[] {
  const rel = relative(REPO_ROOT, abs);
  if (FILE_EXCLUSIONS.has(rel)) return [];
  if (rel in CONSUMER_ALLOWLIST) return [];
  if (isTestFile(rel)) return [];

  const src = readFileSync(abs, "utf-8");

  // Cheap pre-check: does the file mention any state-export URL?
  STATE_EXPORT_PATH_RE.lastIndex = 0;
  if (!STATE_EXPORT_PATH_RE.test(src)) return [];

  // The file references state-export URLs. Require an actual import
  // statement (not just a string mention in a comment) from the
  // verifier package. Match any `from "@motebit/state-export-client"`
  // or `require("@motebit/state-export-client")` shape, including
  // type-only imports — a file that imports just the types is at
  // minimum acknowledging the contract, and the actual fetch wiring
  // is usually in the same module.
  if (VERIFIER_IMPORT_RE.test(src)) return [];

  // No verifier import + state-export URLs present → violation.
  // Surface the literal + line for the report.
  const lines = src.split("\n");
  const findings: Finding[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    STATE_EXPORT_PATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = STATE_EXPORT_PATH_RE.exec(line)) !== null) {
      findings.push({
        file: rel,
        line: i + 1,
        literal: match[0],
        context: line.trim(),
      });
    }
  }
  return findings;
}

function main(): void {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    try {
      statSync(root);
    } catch {
      continue;
    }
    walkTs(root, files);
  }
  const findings = files.flatMap(scanFile);

  const allowlistedCount = Object.keys(CONSUMER_ALLOWLIST).length;
  console.log(
    `check-state-export-consumer-verifies — scanned ${files.length} files across apps/ + packages/ (allowlist: ${allowlistedCount}, exclusions: ${FILE_EXCLUSIONS.size})\n`,
  );

  if (findings.length === 0) {
    console.log(
      `✓ Every state-export URL reference outside the producer + verifier packages routes through @motebit/state-export-client.`,
    );
    return;
  }

  console.log(`✗ State-export URL referenced without importing @motebit/state-export-client:\n`);
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  ${f.literal}`);
    console.log(`    ${f.context}`);
  }
  console.log(
    `\n  Fix: route the fetch through the verified wrapper:\n` +
      `       import { verifiedStateExportFetch } from "@motebit/state-export-client";\n` +
      `       const { body, verification } = await verifiedStateExportFetch(url, { anchor });\n` +
      `       if (!verification.valid) { /* banner + audit */ }\n` +
      `\n` +
      `       For declarative references (comments, type annotations, registry\n` +
      `       documentation) that name the URL shape without fetching it, add an\n` +
      `       entry to CONSUMER_ALLOWLIST in this gate with an explicit reason.\n` +
      `       Pending-wiring consumers belong in the allowlist with a "pending"\n` +
      `       reason so the drift stays visible until wired.\n` +
      `\n` +
      `       Doctrine: docs/doctrine/nist-alignment.md §8.\n`,
  );
  process.exit(1);
}

main();
