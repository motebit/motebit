/**
 * Retention-coverage drift gate (invariant #67).
 *
 * Enforces: every runtime-side store with a `sensitivity` column or
 * settlement obligation registers a `RetentionShape` in
 * `RUNTIME_RETENTION_REGISTRY` (`packages/protocol/src/retention-policy.ts`),
 * and every registered store has a matching at-rest schema in at least
 * one runtime-side surface. Bidirectional check: drift in either
 * direction (stale registry / unregistered store) fails CI.
 *
 * Why this drift is real: motebit's CLAUDE.md claims "fail-closed
 * privacy" — sensitivity-classified content has time-bounded retention
 * enforced via signed deletion certificates. Today the cycle's flush
 * phase (`packages/runtime/src/consolidation-cycle.ts`) iterates
 * adapter methods (`enumerateForFlush`, `eraseMessage`, `erase`) and
 * signs `consolidation_flush` certs per record. The drift class this
 * gate prevents: a future at-rest schema adds a `sensitivity TEXT`
 * column to a new table, the team forgets to register the store with a
 * `RetentionShape`, and that table's records leak past the doctrinal
 * ceiling because the cycle never sees them. Memory's `mutable_pruning`
 * shipping in phase 3 was the original such gap; this gate closes the
 * meta-version.
 *
 * Same enforcement pattern as `check-consolidation-primitives` (#34)
 * and `check-suite-declared` (#10): one canonical home, sibling-aware
 * drift detection, fail-closed exit code.
 *
 * Scope: runtime-side surfaces only — `apps/mobile`, `apps/desktop`,
 * `packages/persistence`, `packages/browser-persistence`. The relay's
 * deployment doesn't host these stores; its retention manifest declares
 * `out_of_deployment:` for them by design.
 *
 * Exit 1 on violation. Runs in CI via `pnpm check`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Source of truth: the runtime registry ────────────────────────────
//
// We parse the registry from the protocol source rather than importing
// to keep this script independent of build artifacts and tsconfig
// references. The shape is small and stable; a regex tour over the
// registry's object literal extracts the entries we need. If the
// registry's literal layout changes substantially, this scanner needs
// to track. Sibling pattern: `check-suite-declared` parses `SuiteId`
// the same way.

const REGISTRY_FILE = join(ROOT, "packages", "protocol", "src", "retention-policy.ts");

interface RegistryEntry {
  storeId: string;
  shapeKind: "mutable_pruning" | "append_only_horizon" | "consolidation_flush";
}

function parseRegistry(): RegistryEntry[] {
  const src = readFileSync(REGISTRY_FILE, "utf-8");
  const block = src.match(/RUNTIME_RETENTION_REGISTRY[\s\S]*?Object\.freeze\(\{([\s\S]*?)\}\);/);
  if (!block) {
    throw new Error(
      "check-retention-coverage: could not locate RUNTIME_RETENTION_REGISTRY in protocol source",
    );
  }
  const body = block[1]!;
  const entries: RegistryEntry[] = [];
  // Match `<storeId>: { kind: "<kind>", ... }` per top-level key.
  // The registry's keys are bare identifiers (no quoted strings) so the
  // pattern looks for `<word>:\s*{\s*kind:\s*"<kind>"`.
  const entryPattern = /([a-z_][a-z0-9_]*)\s*:\s*\{\s*kind:\s*"([a-z_]+)"/gi;
  let m: RegExpExecArray | null;
  while ((m = entryPattern.exec(body)) !== null) {
    entries.push({
      storeId: m[1]!,
      shapeKind: m[2] as RegistryEntry["shapeKind"],
    });
  }
  if (entries.length === 0) {
    throw new Error("check-retention-coverage: parsed zero registry entries");
  }
  return entries;
}

// ── Store-to-table mapping ───────────────────────────────────────────
//
// `RuntimeStoreId` is the protocol-canonical name; physical SQL tables
// may use different names per surface (mobile `tool_audit` vs
// persistence/desktop `tool_audit_log`). The mapping is centralized
// here; surface-level divergence is intentional historical drift, not
// fixable by this gate.

const STORE_TABLE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  memory: ["memory_nodes"],
  event_log: ["events"],
  conversation_messages: ["conversation_messages"],
  tool_audit: ["tool_audit", "tool_audit_log"],
};

// ── Where to look for CREATE TABLE statements ────────────────────────
//
// Runtime-side surfaces only. Each surface declares its at-rest schema
// in one or two well-known files; the scanner reads them and extracts
// CREATE TABLE statements. Migration files (`*-migrations*.ts` and
// `migrations-registry.ts`) are also scanned because phase 5-ship
// landed the `sensitivity` column via ALTER TABLE in migrations on
// existing installs.

const SCAN_FILES: ReadonlyArray<{ path: string; surface: string }> = [
  // At-rest schemas — fresh-install tables with the post-phase-5 column
  // shape.
  { path: "packages/persistence/src/index.ts", surface: "persistence" },
  { path: "apps/mobile/src/adapters/expo-sqlite.ts", surface: "mobile" },
  { path: "apps/desktop/src-tauri/src/main.rs", surface: "desktop" },

  // Migration registries — historical ladder of ALTER TABLE additions.
  { path: "packages/persistence/src/migrations-registry.ts", surface: "persistence-migrations" },
  { path: "apps/mobile/src/adapters/expo-sqlite-migrations.ts", surface: "mobile-migrations" },
  { path: "apps/desktop/src/tauri-migrations.ts", surface: "desktop-migrations" },
];

interface CreateTableStmt {
  surface: string;
  tableName: string;
  body: string; // The full statement body between `CREATE TABLE ... (` and `)`.
}

interface AlteredColumn {
  surface: string;
  tableName: string;
  columnName: string;
}

function extractCreateTables(content: string, surface: string): CreateTableStmt[] {
  // Match: CREATE TABLE [IF NOT EXISTS] <name> ( <body> )
  // Body may contain newlines and nested parens (e.g. CHECK constraints
  // or DEFAULT expressions), but the matched body terminates at the
  // last `)` before the next CREATE/INSERT/--/ALTER on a fresh line.
  // This is heuristic — exhaustive SQL parsing is over-scoped — but
  // motebit's at-rest schemas are simple flat-column DDL and the
  // pattern fires reliably on them.
  const pattern =
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(([\s\S]*?)\)\s*;/gi;
  const stmts: CreateTableStmt[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    stmts.push({
      surface,
      tableName: m[1]!.toLowerCase(),
      body: m[2]!,
    });
  }
  return stmts;
}

function extractAlterAddColumns(content: string, surface: string): AlteredColumn[] {
  // Match: ALTER TABLE <name> ADD COLUMN <colName> <type> ...
  // Used to find migrations that retroactively add the `sensitivity`
  // column to existing tables.
  const pattern = /ALTER\s+TABLE\s+([a-z_][a-z0-9_]*)\s+ADD\s+COLUMN\s+([a-z_][a-z0-9_]*)/gi;
  const cols: AlteredColumn[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    cols.push({
      surface,
      tableName: m[1]!.toLowerCase(),
      columnName: m[2]!.toLowerCase(),
    });
  }
  return cols;
}

interface Violation {
  kind: "missing-store" | "unregistered-table" | "shape-without-sensitivity";
  detail: string;
}

function main(): void {
  const registry = parseRegistry();

  // Aggregate every CREATE TABLE / ALTER TABLE we can find.
  const allCreates: CreateTableStmt[] = [];
  const allAlters: AlteredColumn[] = [];
  for (const { path, surface } of SCAN_FILES) {
    const full = join(ROOT, path);
    let content: string;
    try {
      content = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    allCreates.push(...extractCreateTables(content, surface));
    allAlters.push(...extractAlterAddColumns(content, surface));
  }

  const violations: Violation[] = [];

  // ── Check 1: every registered store has a matching CREATE TABLE
  // in at least one surface, and the table name matches one of the
  // store's known aliases.
  for (const entry of registry) {
    const aliases = STORE_TABLE_ALIASES[entry.storeId];
    if (!aliases) {
      violations.push({
        kind: "missing-store",
        detail:
          `Registry entry "${entry.storeId}" has no STORE_TABLE_ALIASES mapping in ` +
          `scripts/check-retention-coverage.ts. Add the canonical SQL table name(s) ` +
          `the store maps to so the gate can verify the at-rest shape.`,
      });
      continue;
    }

    const matchingCreates = allCreates.filter((c) => aliases.includes(c.tableName));
    if (matchingCreates.length === 0) {
      violations.push({
        kind: "missing-store",
        detail:
          `Registry entry "${entry.storeId}" (kind: ${entry.shapeKind}) has no matching ` +
          `CREATE TABLE in any runtime-side surface. Expected table name(s): ` +
          `${aliases.join(" / ")}. Either add the at-rest schema or remove the registry entry.`,
      });
      continue;
    }

    // Check 1b: consolidation_flush stores must carry a `sensitivity`
    // column. The column may live in the original CREATE TABLE (fresh
    // install) or in a later ALTER TABLE migration (existing install).
    if (entry.shapeKind === "consolidation_flush") {
      const hasInCreate = matchingCreates.some((c) => /\bsensitivity\b/i.test(c.body));
      const hasInAlter = allAlters.some(
        (a) => aliases.includes(a.tableName) && a.columnName === "sensitivity",
      );
      if (!hasInCreate && !hasInAlter) {
        violations.push({
          kind: "shape-without-sensitivity",
          detail:
            `Registry entry "${entry.storeId}" registers shape consolidation_flush but no ` +
            `surface declares a \`sensitivity\` column on table "${aliases.join(" / ")}". ` +
            `consolidation_flush requires per-record sensitivity classification per ` +
            `docs/doctrine/retention-policy.md §"Decision 6b". Add the column at-rest ` +
            `(CREATE TABLE) and via migration (ALTER TABLE ADD COLUMN sensitivity TEXT) ` +
            `for existing installs.`,
        });
      }
    }
  }

  // ── Check 2: every CREATE TABLE with a `sensitivity` column maps
  // to a registered store. Reverse drift: a future schema adds the
  // column without registering the store, and the cycle's flush phase
  // never sees it. Same drift class as the original CLAUDE.md claim
  // gap that motivated this entire arc.
  const knownAliases = new Set<string>();
  for (const aliases of Object.values(STORE_TABLE_ALIASES)) {
    for (const a of aliases) knownAliases.add(a);
  }
  for (const create of allCreates) {
    if (!/\bsensitivity\b/i.test(create.body)) continue;
    if (knownAliases.has(create.tableName)) continue;
    violations.push({
      kind: "unregistered-table",
      detail:
        `Table "${create.tableName}" (declared in ${create.surface}) carries a \`sensitivity\` ` +
        `column but is not in RUNTIME_RETENTION_REGISTRY at ` +
        `packages/protocol/src/retention-policy.ts. Either register the store with a ` +
        `RetentionShape (typically consolidation_flush — see decision 6b) plus an alias ` +
        `entry in STORE_TABLE_ALIASES, or drop the column. A sensitivity-classified store ` +
        `with no registered shape leaks past the retention ceiling because the cycle's ` +
        `flush phase doesn't see it.`,
    });
  }

  console.log(
    `check-retention-coverage — ${registry.length} registry entries, ${allCreates.length} CREATE TABLE statements, ${allAlters.length} ALTER TABLE ADD COLUMN statements\n`,
  );

  if (violations.length === 0) {
    console.log("✓ Every runtime-side store with sensitivity-classified records is registered.\n");
    return;
  }

  for (const v of violations) {
    console.log(`✗ [${v.kind}]  ${v.detail}\n`);
  }
  process.exit(1);
}

main();
