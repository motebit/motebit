/**
 * Drift gate — every named public export from a publish-surface package's
 * `src/index.ts` must appear in its `README.md`, unless explicitly waived.
 *
 * The published packages are motebit's front door on npm. Once an export is
 * promoted to the public surface (a `minor` bump under Changesets), a prospective
 * consumer landing on the npm page should be able to discover it. A new export
 * that ships without README mention is invisible — it exists in the type surface
 * but not in the consumer-facing prose, and the drift survives until someone
 * complains. Same shape as the `code-shaped-prose drift` pattern but specifically
 * scoped to the publish surface, where the consequences are highest.
 *
 * Closed-registry / structural-lock pattern, same as:
 *   - check-audience-canonical (every token audience literal is in the registry)
 *   - check-artifact-type-canonical (every artifact-type literal is in the registry)
 *   - check-api-surface (every type-surface change is baselined)
 *   - check-cli-surface (every CLI flag is baselined)
 *
 * Together these gates lock the four axes of public-surface stability:
 *   1. Type surface (api-extractor baseline)
 *   2. CLI surface (cli-surface baseline)
 *   3. Wire surface (audience + artifact-type registries)
 *   4. npm consumer-discovery surface (THIS gate — README ↔ exports)
 *
 * Scope: every publishable package — `packages/*`, `apps/*`, `services/*`
 * whose `package.json` is neither `"private": true` nor
 * `version === "0.0.0-private"`. The set is derived from the filesystem,
 * not hardcoded — new publish-surface packages pick up enforcement
 * automatically.
 *
 * Rule: every named value export (functions, classes, `const`, `let`) from
 * `src/index.ts` must appear as a word in `README.md`. Type-only exports
 * (`export type`, `export interface`) are skipped — they're internal to the
 * type system, not part of the consumer-facing programmatic surface.
 *
 * Waivers: WAIVED_EXPORTS below names currently-undocumented exports with a
 * categorical reason. Each entry encodes acknowledged debt — a future PR
 * should document the export and remove the waiver, not silently grow the
 * waiver. New undocumented exports fail the gate regardless.
 *
 * Exit code 1 on any unwaived missing export.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ──────────────────────────────────────────────────────────────────────────
// Per-package waiver registry — acknowledged debt
// ──────────────────────────────────────────────────────────────────────────
//
// Every entry below acknowledges an export that is currently undocumented
// in its package README. The shape is intentional: explicit list per package,
// one-line categorical reason, no wildcards. A future PR that documents the
// export must also remove its waiver entry, which forces the diff to land in
// the same commit (sibling-boundary rule applied to docs).
//
// New publish-surface packages do NOT inherit waivers. Adding a new export
// to an existing package WITHOUT documenting it requires explicitly extending
// the waiver list — that's the structural lock.
//
// The audit run that produced these waivers: 2026-05-11. Reduce them by
// PR over time; ratchet toward an empty map.

interface PackageWaiver {
  /** npm package name. */
  pkg: string;
  /** Categorical reason this set is currently undocumented. */
  reason: string;
  /** Export identifiers currently waived. */
  exports: ReadonlyArray<string>;
}

const WAIVED_EXPORTS: ReadonlyArray<PackageWaiver> = [
  {
    pkg: "@motebit/protocol",
    reason:
      "Protocol surface — types/algebra/registries shipped together; README documents categories, not every literal. Document each in v1.3+ as the public-surface guide expands.",
    exports: [
      "TrustSemiring",
      "CostSemiring",
      "LatencySemiring",
      "BottleneckSemiring",
      "ReliabilitySemiring",
      "BooleanSemiring",
      "RegulatoryRiskSemiring",
      "MaxProductLogSemiring",
      "productSemiring",
      "recordSemiring",
      "mappedSemiring",
      "WeightedDigraph",
      "optimalPaths",
      "optimalPath",
      "transitiveClosure",
      "optimalPathTrace",
      "TRUST_LEVEL_SCORES",
      "trustLevelToScore",
      "TRUST_ZERO",
      "TRUST_ONE",
      "trustAdd",
      "trustMultiply",
      "composeTrustChain",
      "joinParallelRoutes",
      "REFERENCE_TRUST_THRESHOLDS",
      "DEFAULT_TRUST_THRESHOLDS",
      "SUITE_REGISTRY",
      "ALL_SUITE_IDS",
      "isSuiteId",
      "getSuiteEntry",
      "MAX_RETENTION_DAYS_BY_SENSITIVITY",
      "REFERENCE_RETENTION_DAYS_BY_SENSITIVITY",
      "RUNTIME_RETENTION_REGISTRY",
      "EMPTY_FEDERATION_GRAPH_ANCHOR",
      "COMPUTER_ACTION_KINDS",
      "COMPUTER_FAILURE_REASONS",
      "CO_BROWSE_TRANSITION_KINDS",
      "TOOL_MODES",
      "toolModePriority",
      "resolveDropTarget",
      "MICRO",
      "CENTS",
      "toMicro",
      "fromMicro",
      "toCents",
      "fromCents",
      "ALL_TOKEN_AUDIENCES",
      "isTokenAudience",
      "SYNC_AUDIENCE",
      "DEVICE_AUTH_AUDIENCE",
      "PAIR_AUDIENCE",
      "ROTATE_KEY_AUDIENCE",
      "PUSH_REGISTER_AUDIENCE",
      "TASK_SUBMIT_AUDIENCE",
      "ADMIN_QUERY_AUDIENCE",
      "PROPOSAL_AUDIENCE",
      "ACCOUNT_BALANCE_AUDIENCE",
      "ACCOUNT_DEPOSIT_AUDIENCE",
      "ACCOUNT_WITHDRAW_AUDIENCE",
      "ACCOUNT_WITHDRAWALS_AUDIENCE",
      "ACCOUNT_CHECKOUT_AUDIENCE",
      "BROWSER_SANDBOX_GRANT_AUDIENCE",
      "BROWSER_SANDBOX_AUDIENCE",
      "ALL_CONTENT_ARTIFACT_TYPES",
      "isContentArtifactType",
      "STATE_SNAPSHOT_ARTIFACT",
      "MEMORY_EXPORT_ARTIFACT",
      "GOAL_LIST_ARTIFACT",
      "CONVERSATION_LIST_ARTIFACT",
      "CONVERSATION_MESSAGES_ARTIFACT",
      "DEVICE_LIST_ARTIFACT",
      "AUDIT_TRAIL_ARTIFACT",
      "PLAN_LIST_ARTIFACT",
      "PLAN_DETAIL_ARTIFACT",
      "GRADIENT_HISTORY_ARTIFACT",
      "SYNC_PULL_ARTIFACT",
      "EXECUTION_LEDGER_ARTIFACT",
      "GOAL_RESULT_ARTIFACT",
      "TRANSPARENCY_SUITE",
      "TRANSPARENCY_ANCHOR_MEMO_PREFIX",
      "TRANSPARENCY_SPEC_ID",
      "isSignedTransparencyDeclaration",
      "SKILL_SENSITIVITY_TIERS",
      "SKILL_AUTO_LOADABLE_TIERS",
      "SKILL_PLATFORMS",
      "asDeviceId",
      "asNodeId",
      "asGoalId",
      "asEventId",
      "asConversationId",
      "asPlanId",
      "asAllocationId",
      "asSettlementId",
      "asListingId",
      "asProposalId",
      "EXECUTION_LEDGER_SPEC_V1_0",
      "EXECUTION_LEDGER_SPEC_V1_1",
      "VC_TYPE_GRADIENT",
      "VC_TYPE_REPUTATION",
      "VC_TYPE_TRUST",
    ],
  },
  {
    pkg: "@motebit/crypto",
    reason:
      "Primitive surface — README documents the verify-anything entry point; signing primitives + literal suite constants + chain verifiers shipped as named exports without README mention. Document by category in v1.3+.",
    exports: [
      "verifyHardwareAttestationClaim",
      "canonicalSecureEnclaveBodyForTest",
      "encodeSecureEnclaveReceiptForTest",
      "mintSecureEnclaveReceiptForTest",
      "verifyVerifiableCredential",
      "verifyVerifiablePresentation",
      "signContentArtifact",
      "verifyContentArtifact",
      "CONTENT_ARTIFACT_SUITE",
      "computeCredentialLeaf",
      "verifyCredentialAnchor",
      "verifyRevocationAnchor",
      "SKILL_SIGNATURE_SUITE",
      "canonicalizeSkillManifestBytes",
      "canonicalizeSkillEnvelopeBytes",
      "signSkillManifest",
      "signSkillEnvelope",
      "verifySkillManifest",
      "verifySkillManifestDetailed",
      "verifySkillEnvelope",
      "verifySkillEnvelopeDetailed",
      "decodeSkillSignaturePublicKey",
      "DELETION_CERTIFICATE_SUITE",
      "WITNESS_OMISSION_DISPUTE_WINDOW_MS",
      "canonicalizeMultiSignatureCert",
      "canonicalizeHorizonCert",
      "canonicalizeHorizonCertForWitness",
      "signCertAsSubject",
      "signCertAsOperator",
      "signCertAsDelegate",
      "signCertAsGuardian",
      "signHorizonCertAsIssuer",
      "signHorizonWitness",
      "canonicalizeHorizonWitnessRequestBody",
      "signHorizonWitnessRequestBody",
      "verifyHorizonWitnessRequestSignature",
      "verifyDeletionCertificate",
      "verifyRetentionManifest",
      "canonicalizeWitnessOmissionDispute",
      "signWitnessOmissionDispute",
      "verifyWitnessOmissionDispute",
      "verifyMerkleInclusion",
      "verifyReceipt",
      "verifySkillBundle",
    ],
  },
];

const WAIVER_INDEX = new Map<string, ReadonlySet<string>>();
for (const w of WAIVED_EXPORTS) {
  WAIVER_INDEX.set(w.pkg, new Set(w.exports));
}

// ──────────────────────────────────────────────────────────────────────────
// Discovery
// ──────────────────────────────────────────────────────────────────────────

interface PackageInfo {
  /** Directory under packages/, apps/, or services/. */
  dir: string;
  /** npm package name. */
  name: string;
  /** Version string. */
  version: string;
}

/**
 * Walk `packages/`, `apps/`, `services/` and return every package whose
 * `package.json` is neither `"private": true` nor `"0.0.0-private"`.
 */
function discoverPublishablePackages(): ReadonlyArray<PackageInfo> {
  const out: PackageInfo[] = [];
  for (const top of ["packages", "apps", "services"]) {
    const topDir = resolve(ROOT, top);
    if (!existsSync(topDir)) continue;
    for (const entry of readdirSync(topDir)) {
      const dir = resolve(topDir, entry);
      const pj = resolve(dir, "package.json");
      if (!existsSync(pj)) continue;
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;
      const raw = JSON.parse(readFileSync(pj, "utf-8")) as {
        name?: string;
        version?: string;
        private?: boolean;
      };
      if (!raw.name || !raw.version) continue;
      if (raw.private === true) continue;
      if (raw.version === "0.0.0-private") continue;
      out.push({ dir, name: raw.name, version: raw.version });
    }
  }
  return out;
}

/**
 * Extract every named VALUE export from a TypeScript source file. Skips
 * type-only exports (`export type`, `export interface`) — those don't need
 * README mention because they aren't part of the runtime programmatic
 * surface.
 *
 * Handles the four shipping shapes in motebit's index.ts files:
 *   - `export { foo, bar } from "./mod"` (re-export named)
 *   - `export { foo as fooBar } from "./mod"` (re-export aliased)
 *   - `export function foo(...)` / `export async function foo(...)`
 *   - `export const foo = ...` / `export let foo = ...`
 *   - `export class Foo` (treated as value — has runtime presence)
 */
function extractValueExports(src: string): ReadonlyArray<string> {
  const exports = new Set<string>();

  // Re-exports: `export { a, b as c, ... } from "..."` — skip when preceded
  // by `type` ("export type { ... }").
  const reExportRe = /^export\s+\{([^}]+)\}\s+from\s+/gm;
  for (const match of src.matchAll(reExportRe)) {
    const before = src.slice(Math.max(0, match.index - 20), match.index);
    if (/\bexport\s+type\s+$/.test(before)) continue;
    const block = match[1]!;
    for (const item of block.split(",")) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      // Skip `type` modifier per-item: `export { type Foo, bar }` — only `bar`.
      if (trimmed.startsWith("type ")) continue;
      const asMatch = trimmed.match(/\s+as\s+(\w+)$/);
      const name = asMatch ? asMatch[1] : trimmed.split(/\s+/)[0];
      if (name && !name.startsWith("//")) exports.add(name);
    }
  }

  // Direct declarations: function / class / const / let
  const directRe = /^export\s+(?:async\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)/gm;
  for (const match of src.matchAll(directRe)) {
    exports.add(match[1]!);
  }

  // Explicit type-form re-exports — find and remove anything that slipped
  // through (defensive; the prefix guard above should already catch them).
  const typeExportRe = /^export\s+type\s+\{([^}]+)\}/gm;
  for (const match of src.matchAll(typeExportRe)) {
    for (const item of match[1]!.split(",")) {
      const name = item.trim().split(/\s+/)[0];
      if (name) exports.delete(name);
    }
  }

  return [...exports];
}

/**
 * Check whether a README mentions an identifier. Accepts any appearance:
 * code block, inline `code`, bare word. Word-boundary match so `verifyFile`
 * doesn't accidentally count toward `verify`.
 */
function readmeMentions(readme: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(readme);
}

// ──────────────────────────────────────────────────────────────────────────
// Run
// ──────────────────────────────────────────────────────────────────────────

const violations: Array<{ pkg: string; missing: string[]; readme: string }> = [];
const staleWaivers: Array<{ pkg: string; identifier: string }> = [];

for (const pkg of discoverPublishablePackages()) {
  const indexPath = resolve(pkg.dir, "src/index.ts");
  const readmePath = resolve(pkg.dir, "README.md");

  if (!existsSync(indexPath)) continue;
  if (!existsSync(readmePath)) {
    violations.push({
      pkg: pkg.name,
      missing: ["(README.md missing entirely)"],
      readme: readmePath,
    });
    continue;
  }

  const indexSrc = readFileSync(indexPath, "utf-8");
  const readmeSrc = readFileSync(readmePath, "utf-8");
  const exports = extractValueExports(indexSrc);
  const waived = WAIVER_INDEX.get(pkg.name) ?? new Set<string>();

  const missing: string[] = [];
  const consumedWaivers = new Set<string>();
  for (const name of exports) {
    if (readmeMentions(readmeSrc, name)) {
      // If an export now appears in the README but is also waived, the
      // waiver is stale — flag it so the next PR can remove it.
      if (waived.has(name)) consumedWaivers.add(name);
      continue;
    }
    if (waived.has(name)) continue;
    missing.push(name);
  }

  // Stale-waiver detection: waiver names an export that DOES appear in the README.
  for (const name of waived) {
    if (consumedWaivers.has(name)) {
      staleWaivers.push({ pkg: pkg.name, identifier: name });
    }
  }

  if (missing.length > 0) {
    violations.push({ pkg: pkg.name, missing, readme: readmePath });
  }
}

const packageCount = discoverPublishablePackages().length;
const waivedCount = WAIVED_EXPORTS.reduce((n, w) => n + w.exports.length, 0);
console.log(
  `check-readme-public-exports — scanned ${packageCount} publish-surface package(s); ${waivedCount} exports waived as acknowledged debt`,
);
console.log("");

let failed = false;

if (staleWaivers.length > 0) {
  console.log(
    `✗ ${staleWaivers.length} waiver entry(ies) are stale (the export now appears in the README — remove from WAIVED_EXPORTS):`,
  );
  for (const s of staleWaivers) {
    console.log(`  ${s.pkg}: ${s.identifier}`);
  }
  console.log("");
  failed = true;
}

if (violations.length > 0) {
  console.log(
    `✗ ${violations.length} publish-surface package(s) have unwaived value exports not mentioned in README.md:`,
  );
  console.log("");
  for (const v of violations) {
    console.log(`  ${v.pkg}`);
    console.log(`    README: ${v.readme.replace(ROOT + "/", "")}`);
    console.log(`    missing: ${v.missing.join(", ")}`);
    console.log("");
  }
  console.log("  Fix: document each export in README.md — a code-block example, a programmatic");
  console.log("       surface table, or a lineage diagram. Renames must update both surfaces in");
  console.log("       the same commit. The published surface is the front door on npm; an");
  console.log("       undocumented export is invisible to prospective consumers.");
  console.log("");
  console.log("       If the export is genuinely internal or test-only, consider not exporting it");
  console.log("       from src/index.ts at all. If it's acknowledged debt that needs a tracked");
  console.log("       follow-up, add a per-package entry to WAIVED_EXPORTS in scripts/");
  console.log("       check-readme-public-exports.ts with a categorical reason.");
  failed = true;
}

if (!failed) {
  console.log(
    `✓ Every unwaived named value export from src/index.ts appears in its package's README.md.`,
  );
  process.exit(0);
}

process.exit(1);
