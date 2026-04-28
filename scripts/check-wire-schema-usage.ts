/**
 * Wire-schema usage check.
 *
 * Every inbound wire-format body at `services/relay` MUST be validated at the
 * relay boundary through its `@motebit/wire-schemas` parser. The three-way
 * pin in `@motebit/wire-schemas` (zod ↔ TypeScript ↔ committed JSON Schema,
 * drift invariant #22) guarantees the schemas *exist*; this gate guarantees
 * they are *called* at the boundary.
 *
 * The motivating audit: a 2026-04-20 principal-engineer pass after commit
 * 1848d2ea ("parse inbound wire bodies through @motebit/wire-schemas") found
 * four Dispute* wire types and BalanceWaiver still being handled via
 * `c.req.json<{…}>()` inline casts. Casts fail-open on shape drift — a
 * malformed `split_ratio` string slips past TypeScript into `executeFundAction`.
 *
 * Two rules:
 *
 *   (A) Import-and-use parity. Any `*Schema` symbol imported from
 *       `@motebit/wire-schemas` in `services/relay/src/*.ts` MUST have at
 *       least one `Schema.safeParse(` or `Schema.parse(` call in the same
 *       file. Catches regressions where a handler starts importing a
 *       schema for types only and loses the runtime call during a refactor.
 *
 *   (B) Required-usage manifest. Specific files MUST import AND call listed
 *       schemas. Catches the stronger failure mode — a handler bypassing
 *       the schema entirely (never importing it) and accepting untyped
 *       `c.req.json()` bodies. This is the drift the audit surfaced.
 *
 * Waivers are explicit, dated, and centralized in WAIVERS below. A waiver
 * is the registry of known protocol-compliance debt; the gate's output
 * surfaces it every run so it cannot be forgotten.
 *
 * See `docs/drift-defenses.md` (invariant #35) for the incident.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const SERVICES_RELAY_SRC = resolve(ROOT, "services", "relay", "src");

// ── Rule B: Required-usage manifest ────────────────────────────────────
//
// Each entry: "this file handles inbound bodies of these wire types; it
// MUST import the schema AND call .safeParse( / .parse( on it." The
// manifest is declarative — adding a new inbound wire handler means
// appending an entry here.
const REQUIRED_USAGE: ReadonlyArray<{
  file: string;
  schemas: ReadonlyArray<string>;
  note?: string;
}> = [
  {
    file: "services/relay/src/tasks.ts",
    schemas: ["ExecutionReceiptSchema"],
    note: "POST /tasks/:id/complete — receipt submission",
  },
  {
    file: "services/relay/src/agents.ts",
    schemas: ["ExecutionReceiptSchema"],
    note: "POST /agents/:id/receipts — receipt submission (legacy path)",
  },
  {
    file: "services/relay/src/federation.ts",
    schemas: ["ExecutionReceiptSchema"],
    note: "POST /federation/receipts — nested receipt forwarding",
  },
  {
    file: "services/relay/src/migration.ts",
    schemas: [
      "MigrationTokenSchema",
      "DepartureAttestationSchema",
      "CredentialBundleSchema",
      "BalanceWaiverSchema",
    ],
    note: "POST /agents/:id/migrate/* — four signed wire artifacts",
  },
  {
    file: "services/relay/src/disputes.ts",
    schemas: ["DisputeRequestSchema", "DisputeEvidenceSchema", "DisputeAppealSchema"],
    note: "POST /allocations/:id/dispute + /:disputeId/evidence + /:disputeId/appeal — three client-signed wire artifacts (DisputeResolution is relay-constructed, not inbound)",
  },
];

// ── Waivers ────────────────────────────────────────────────────────────
//
// Explicit, dated exemptions. A waiver exists to record known debt — it
// does NOT remove the obligation, it just defers the runtime fail-closed
// until the broader protocol-compliance work lands. Each entry prints on
// every gate run so the debt stays visible.
const WAIVERS: ReadonlyArray<{
  file: string;
  schemas: ReadonlyArray<string>;
  reason: string;
  since: string;
}> = [];

// ── Helpers ────────────────────────────────────────────────────────────

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = resolve(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
      out.push(...walkTs(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Return the set of `*Schema` symbols a file imports from
 * `@motebit/wire-schemas`. Handles multiline braces.
 */
function importedSchemas(src: string): Set<string> {
  const out = new Set<string>();
  // [^}] keeps the body capture from skating past earlier imports' closing
  // braces. Wire-schemas imports are flat name lists — no nested braces.
  const re = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']@motebit\/wire-schemas["']/g;
  for (const m of src.matchAll(re)) {
    const body = m[1] ?? "";
    for (const raw of body.split(",")) {
      const name = raw
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/i)[0]
        ?.trim();
      if (name && name.endsWith("Schema")) out.add(name);
    }
  }
  return out;
}

/**
 * Return the set of schema names invoked via `.safeParse(` or `.parse(` in
 * the file body. Conservative: we only match `Name.safeParse(` / `Name.parse(`
 * where Name ends in `Schema`; aliased usages must still route through a
 * named identifier, which is the style every existing site uses.
 */
function calledSchemas(src: string): Set<string> {
  const out = new Set<string>();
  const re = /\b(\w+Schema)\s*\.\s*(?:safeParse|parse)\s*\(/g;
  for (const m of src.matchAll(re)) {
    if (m[1]) out.add(m[1]);
  }
  return out;
}

interface Violation {
  file: string;
  kind: "import-without-call" | "manifest-missing-import" | "manifest-missing-call";
  schema: string;
  detail: string;
}

function waivedPairs(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const w of WAIVERS) {
    out.set(w.file, new Set(w.schemas));
  }
  return out;
}

// ── Main ───────────────────────────────────────────────────────────────

function main(): void {
  const waived = waivedPairs();
  const violations: Violation[] = [];

  // Build a file → { imported, called } index for every .ts in services/relay/src.
  const index = new Map<string, { imported: Set<string>; called: Set<string> }>();
  for (const abs of walkTs(SERVICES_RELAY_SRC)) {
    const rel = relative(ROOT, abs);
    const src = readFileSync(abs, "utf-8");
    index.set(rel, { imported: importedSchemas(src), called: calledSchemas(src) });
  }

  // Rule A — import-and-use parity for every file.
  for (const [file, { imported, called }] of index) {
    const waivedForFile = waived.get(file) ?? new Set<string>();
    for (const sch of imported) {
      if (waivedForFile.has(sch)) continue;
      if (!called.has(sch)) {
        violations.push({
          file,
          schema: sch,
          kind: "import-without-call",
          detail: `imports ${sch} from @motebit/wire-schemas but never calls .safeParse(/.parse( on it`,
        });
      }
    }
  }

  // Rule B — required-usage manifest.
  for (const entry of REQUIRED_USAGE) {
    const state = index.get(entry.file);
    const waivedForFile = waived.get(entry.file) ?? new Set<string>();
    if (!state) {
      // The manifest names a file that doesn't exist — that's itself a
      // violation: the manifest has drifted from the filesystem.
      for (const sch of entry.schemas) {
        if (waivedForFile.has(sch)) continue;
        violations.push({
          file: entry.file,
          schema: sch,
          kind: "manifest-missing-import",
          detail: `manifest requires ${sch} usage but the file is missing from services/relay/src — update REQUIRED_USAGE`,
        });
      }
      continue;
    }
    for (const sch of entry.schemas) {
      if (waivedForFile.has(sch)) continue;
      if (!state.imported.has(sch)) {
        violations.push({
          file: entry.file,
          schema: sch,
          kind: "manifest-missing-import",
          detail: `manifest requires ${sch} — file does not import it from @motebit/wire-schemas`,
        });
      } else if (!state.called.has(sch)) {
        violations.push({
          file: entry.file,
          schema: sch,
          kind: "manifest-missing-call",
          detail: `manifest requires ${sch} — imported but no .safeParse(/.parse( call`,
        });
      }
    }
  }

  // Print waivers on every run. The debt stays visible.
  if (WAIVERS.length > 0) {
    process.stderr.write(`wire-schema-usage waivers (${WAIVERS.length}):\n`);
    for (const w of WAIVERS) {
      process.stderr.write(`  ⚠ ${w.file} [since ${w.since}]\n`);
      process.stderr.write(`    schemas: ${w.schemas.join(", ")}\n`);
      process.stderr.write(`    reason:  ${w.reason}\n`);
    }
    process.stderr.write("\n");
  }

  if (violations.length === 0) {
    const required = REQUIRED_USAGE.reduce((n, e) => n + e.schemas.length, 0);
    const waivedCount = WAIVERS.reduce((n, w) => n + w.schemas.length, 0);
    console.log(
      `Wire-schema usage check passed — ${required} required pair(s) validated, ${waivedCount} waived`,
    );
    return;
  }

  console.error(`Wire-schema usage violations (${violations.length}):\n`);
  let current = "";
  for (const v of violations) {
    if (v.file !== current) {
      current = v.file;
      console.error(`  [${v.file}]`);
    }
    console.error(`    ${v.kind}: ${v.schema} — ${v.detail}`);
  }
  console.error(
    `\nDoctrine: every inbound wire-format body at the relay must parse through @motebit/wire-schemas (invariant #35).`,
  );
  console.error(
    `Fix: import <Name>Schema from "@motebit/wire-schemas" and call Schema.safeParse(rawBody) before any downstream use.`,
  );
  process.exit(1);
}

main();
