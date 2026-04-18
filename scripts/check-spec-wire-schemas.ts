#!/usr/bin/env tsx
/**
 * check-spec-wire-schemas — drift defense #23.
 *
 * Every wire-format type declared in `spec/*.md` must have a matching
 * `<TypeName>Schema` export from `@motebit/wire-schemas`. That is what
 * makes the protocol *machine-readable* — a non-motebit implementer
 * (Python, Go, Rust worker) fetches the JSON Schema at its stable
 * `$id` URL and validates without bundling motebit. Without this gate,
 * a future spec author can ship a `#### Wire format (foundation law)`
 * section AND `@motebit/protocol` types AND zero machine-readable
 * schema — and the protocol's "third parties can join" claim quietly
 * rots.
 *
 * Companion to invariant #9 (`check-spec-coverage`). That probe asserts
 * spec wire-format types are exported as TypeScript types from
 * `@motebit/protocol`. This probe takes the next step: those same types
 * must also exist as runtime-validatable zod schemas in
 * `@motebit/wire-schemas`, which derive committed JSON Schemas third
 * parties consume.
 *
 * Type-name extraction (two sources, both deliberate):
 *   - Section heading: `### X.Y — TypeName` whose subsection contains a
 *     `#### Wire format (foundation law)` block. Same convention as
 *     `check-spec-coverage`.
 *   - Pseudo-code block within a wire-format section body:
 *     `^TypeName {` followed by field declarations.
 *
 * Waivers. A type may be explicitly waived from this gate if it is:
 *   (a) nested inside an existing top-level schema (the schema covers it
 *       structurally — e.g. `CapabilityPrice` is the element type of
 *       `AgentServiceListingSchema.pricing[]`), or
 *   (b) not yet schema'd but tracked as known debt with a TODO. The
 *       waiver list is long today on purpose: the gate ships HARD, and
 *       new types added after this gate must either ship a schema or
 *       receive a fresh waiver with a documented reason. Existing debt
 *       is enumerated, not silently forgiven.
 *
 * Run:
 *   tsx scripts/check-spec-wire-schemas.ts
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const SPEC_DIR = join(REPO_ROOT, "spec");
const WIRE_SCHEMAS_INDEX = join(REPO_ROOT, "packages", "wire-schemas", "src", "index.ts");

const SECTION_HEADER = /^###\s+[\d.]+\s*—\s*([A-Z][A-Za-z0-9_]*)\s*$/;
const WIRE_FORMAT_HEADER = /^####\s+Wire format\s*\(foundation law\)\s*$/i;
const STORAGE_HEADER = /^####\s+Storage\b/i;
const ANY_HEADER = /^#{1,6}\s+/;
const PSEUDO_TYPE_DECL = /^([A-Z][A-Za-z0-9_]+)\s*\{/;

// ---------------------------------------------------------------------------
// Waivers — types named in a wire-format section that intentionally do not
// require a top-level schema export. Each waiver has a reason that names
// either the structural coverage (nested in an existing schema) or the
// debt-tracking intent (TODO: ship schema). Reduce this list as schemas
// ship; do not let it grow without review justification.
// ---------------------------------------------------------------------------

const WAIVERS: Record<string, string> = {
  // Nested in existing top-level schemas (covered structurally):
  CapabilityPrice:
    "nested inside AgentServiceListingSchema as the pricing[] element — covered structurally",

  // TODO: ship as standalone schemas. Each is an open item; remove when shipped.
  AdjudicatorVote: "TODO: schema (dispute-v1) — adjudicator vote on a dispute resolution",
  BalanceWaiver: "TODO: schema (settlement-v1) — operator-signed balance reconciliation",
  CredentialAnchorBatch: "TODO: schema (credential-anchor-v1) — chain-anchored batch metadata",
  CredentialAnchorProof: "TODO: schema (credential-anchor-v1) — Merkle inclusion proof",
  CredentialBundle: "TODO: schema (credential-v1) — VC + presentation envelope",
  DepartureAttestation: "TODO: schema (relay-federation-v1) — peer departure signal",
  DisputeAppeal: "TODO: schema (dispute-v1) — appeal of a dispute resolution",
  DisputeEvidence: "TODO: schema (dispute-v1) — evidence attached to a dispute",
  DisputeRequest: "TODO: schema (dispute-v1) — open a dispute",
  DisputeResolution: "TODO: schema (dispute-v1) — adjudicator's resolution",
  GradientCredentialSubject:
    "TODO: schema (credential-v1) — VC subject body for gradient-state credentials",
  MigrationPresentation: "TODO: schema (migration-v1) — VC presentation for identity migration",
  MigrationRequest: "TODO: schema (migration-v1) — relay-side migration request",
  MigrationToken: "TODO: schema (migration-v1) — signed migration authorization",
  ReputationCredentialSubject:
    "TODO: schema (credential-v1) — VC subject body for reputation credentials",
  RouteScore: "TODO: schema (market-v1) — discovery composite score envelope",
  SettlementRecord: "TODO: schema (settlement-v1) — per-task settlement bookkeeping",
  TrustCredentialSubject: "TODO: schema (credential-v1) — VC subject body for trust credentials",
};

// ---------------------------------------------------------------------------
// Spec parsing
// ---------------------------------------------------------------------------

interface SpecFinding {
  spec: string;
  typeName: string;
  line: number;
}

function analyzeSpec(file: string): SpecFinding[] {
  const basename = file.split("/").pop()!;
  const content = readFileSync(file, "utf-8");
  const lines = content.split("\n");

  const findings: SpecFinding[] = [];
  let currentSectionType: string | null = null;
  let currentSectionLine = 0;
  let insideWireBlock = false;

  const seen = new Set<string>();
  const record = (typeName: string, line: number): void => {
    const key = `${basename}\0${typeName}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({ spec: basename, typeName, line });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Section heading (### X.Y — TypeName) — record as the parent type
    // candidate; only count it when we then enter a wire-format block.
    const sectionMatch = line.match(SECTION_HEADER);
    if (sectionMatch) {
      currentSectionType = sectionMatch[1]!;
      currentSectionLine = i + 1;
      insideWireBlock = false;
      continue;
    }

    if (WIRE_FORMAT_HEADER.test(line)) {
      insideWireBlock = true;
      // Promote the current parent section's type into the wire surface.
      if (currentSectionType != null) {
        record(currentSectionType, currentSectionLine);
      }
      continue;
    }

    if (STORAGE_HEADER.test(line)) {
      insideWireBlock = false;
      continue;
    }

    // Another section header at the same or higher level closes the wire
    // block context (mirrors check-spec-coverage's state flow).
    if (ANY_HEADER.test(line) && !line.startsWith("####")) {
      insideWireBlock = false;
    }

    // Inside a wire-format section, capture pseudo-code type declarations.
    if (insideWireBlock) {
      const declMatch = line.match(PSEUDO_TYPE_DECL);
      if (declMatch) {
        record(declMatch[1]!, i + 1);
      }
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Schema export collection
// ---------------------------------------------------------------------------

const SCHEMA_EXPORT = /\b([A-Z][A-Za-z0-9_]+)Schema\b/g;

function collectShippedSchemas(): Set<string> {
  const content = readFileSync(WIRE_SCHEMAS_INDEX, "utf-8");
  const names = new Set<string>();
  for (const m of content.matchAll(SCHEMA_EXPORT)) {
    names.add(m[1]!);
  }
  return names;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const shipped = collectShippedSchemas();
  const findings = readdirSync(SPEC_DIR)
    .filter((f) => f.endsWith(".md"))
    .flatMap((f) => analyzeSpec(join(SPEC_DIR, f)))
    .sort((a, b) => a.spec.localeCompare(b.spec) || a.typeName.localeCompare(b.typeName));

  const missing: SpecFinding[] = [];
  const honoredWaivers = new Set<string>();
  let checked = 0;

  for (const f of findings) {
    checked++;
    if (shipped.has(f.typeName)) continue;
    if (WAIVERS[f.typeName] != null) {
      honoredWaivers.add(f.typeName);
      continue;
    }
    missing.push(f);
  }

  // Stale-waiver detection: a waiver whose type no longer appears in any
  // spec wire-format section is dead weight that masks future drift.
  const referencedTypes = new Set(findings.map((f) => f.typeName));
  const staleWaivers = Object.keys(WAIVERS).filter((t) => !referencedTypes.has(t));

  process.stderr.write(
    `check-spec-wire-schemas: ${checked} type-references across ${
      new Set(findings.map((f) => f.spec)).size
    } spec(s); ${shipped.size} schemas shipped; ${honoredWaivers.size} waiver(s) used\n`,
  );

  if (staleWaivers.length > 0) {
    process.stderr.write(
      `\nstale waivers (named in WAIVERS but no longer referenced by any spec):\n`,
    );
    for (const t of staleWaivers) {
      process.stderr.write(`  - ${t}: ${WAIVERS[t]!}\n`);
    }
    process.stderr.write(`Remove these from WAIVERS to keep the gate honest.\n`);
    process.exit(1);
  }

  if (missing.length > 0) {
    process.stderr.write(
      `\nERROR: ${missing.length} spec wire-format type(s) lack a matching @motebit/wire-schemas export:\n`,
    );
    for (const f of missing) {
      process.stderr.write(`  spec/${f.spec}:${f.line}  ${f.typeName}\n`);
    }
    process.stderr.write(
      `\nResolution:\n` +
        `  (a) Add a zod schema in packages/wire-schemas/src/<type>.ts and re-export it\n` +
        `      as <TypeName>Schema from packages/wire-schemas/src/index.ts.\n` +
        `      Run \`pnpm --filter @motebit/wire-schemas build-schemas\` and commit\n` +
        `      the generated JSON.\n` +
        `  (b) If the type is structurally covered by an existing schema (e.g. it's\n` +
        `      the element type of an array field), add it to WAIVERS in this script\n` +
        `      with a reason naming the covering schema.\n`,
    );
    process.exit(1);
  }

  process.stderr.write(
    `OK: every spec wire-format type maps to a schema or a documented waiver.\n`,
  );
}

main();
