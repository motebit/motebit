/**
 * Relay-side retention-coverage drift gate (invariant #68).
 *
 * Sibling to #67 (`check-retention-coverage`). Where #67 governs the
 * runtime-side `RUNTIME_RETENTION_REGISTRY` and the user-device stores
 * (memory, event_log, conversation_messages, tool_audit), this gate
 * governs the relay-side `RETENTION_MANIFEST_CONTENT.stores[]`
 * projection in `services/relay/src/retention-manifest.ts` and the
 * five operational ledgers the relay actually hosts
 * (relay_execution_ledgers, relay_settlements,
 * relay_credential_anchor_batches, relay_revocation_events,
 * relay_disputes).
 *
 * Why two gates instead of one: the registries live in different
 * places by design — runtime-scoped state is on the user's device
 * (per-motebit) and relay-scoped state is on the operator (per-deploy).
 * The relay's manifest declares `out_of_deployment:` for runtime stores
 * by design (#67's framing); each motebit's runtime publishes its own
 * retention manifest covering its conversation + tool-audit stores.
 * Two registries, two scopes, two gates — different drift surfaces.
 *
 * Bidirectional check:
 *
 *   (A) every entry in `RETENTION_MANIFEST_CONTENT.stores[]` has a
 *       matching alias in `RELAY_STORE_TABLE_ALIASES` AND a CREATE
 *       TABLE for that alias in `services/relay/src/`. A registered
 *       store with no schema is a false claim — the manifest declares
 *       enforcement of a store that doesn't exist.
 *
 *   (B) every alias in `RELAY_STORE_TABLE_ALIASES` has a matching
 *       entry in `RETENTION_MANIFEST_CONTENT.stores[]` AND a CREATE
 *       TABLE for that alias in `services/relay/src/`. The alias map
 *       IS the curated source of "retention-obligated relay tables";
 *       a curated entry without a manifest projection is doctrine
 *       drift (we promised the surface, never declared the policy).
 *
 * Drift this gate prevents: a future operational ledger
 * (e.g. `relay_attestation_audit`) ships a CREATE TABLE without
 * appearing in the manifest, and the operator's transparency claim
 * "every retention-obligated store is declared" silently rots.
 *
 * Why a curated alias map instead of auto-detection: relay-side
 * tables don't carry a uniform "retention obligation" marker like
 * runtime stores' `sensitivity` column does. Federation peers, agent
 * registry, pairing sessions, etc. all carry timestamps but are
 * presence/state stores governed by TTLs (declared in
 * /.well-known/motebit-transparency.json), not by signed deletion
 * certs. The alias map names exactly which tables fall under
 * retention-cert governance; the gate enforces full bidirectional
 * consistency from there. Adding a new operational ledger means three
 * coordinated additions — table DDL + alias entry + manifest store —
 * which is the right friction level for protocol-shaped surfaces.
 *
 * Exit 1 on violation. Runs in CI via `pnpm check`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const MANIFEST_FILE = join(ROOT, "services", "relay", "src", "retention-manifest.ts");
const RELAY_SRC_DIR = join(ROOT, "services", "relay", "src");

// ── Curated alias map: relay tables under retention-cert governance ──
//
// Source of truth for which physical tables in `services/relay/src/`
// fall under signed-deletion-certificate retention. Adding a new
// operational ledger means: (1) add the CREATE TABLE in services/relay,
// (2) add the alias here, (3) add the entry to
// `RETENTION_MANIFEST_CONTENT.stores[]`. The gate enforces all three
// stay in sync.
//
// 1:1 mapping today (each store_id maps to exactly one physical table).
// The array shape mirrors #67's `STORE_TABLE_ALIASES` and leaves room
// for future per-surface divergence (different physical names across
// deployments) — same pattern as memory ↔ memory_nodes,
// tool_audit ↔ tool_audit / tool_audit_log in #67.

const RELAY_STORE_TABLE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  relay_execution_ledgers: ["relay_execution_ledgers"],
  relay_settlements: ["relay_settlements"],
  relay_credential_anchor_batches: ["relay_credential_anchor_batches"],
  relay_revocation_events: ["relay_revocation_events"],
  relay_disputes: ["relay_disputes"],
};

// ── Manifest parsing ─────────────────────────────────────────────────
//
// Same approach as #67: parse the source rather than import, to keep
// this script independent of build artifacts. The manifest's
// stores[] literal is small and stable; a focused regex tour extracts
// store_id values.

interface ManifestStore {
  storeId: string;
  shapeKind: string;
}

function parseManifestStores(): ManifestStore[] {
  const src = readFileSync(MANIFEST_FILE, "utf-8");
  // Locate the OPERATIONAL_LEDGER_STORES literal — it's the canonical
  // list the manifest's `stores` field references. We scan for
  // `store_id: "<id>", store_name: ..., shape: { kind: "<kind>"`.
  const entryPattern =
    /store_id:\s*"([a-z_][a-z0-9_]*)"[\s\S]*?shape:\s*\{\s*kind:\s*"([a-z_]+)"/gi;
  const entries: ManifestStore[] = [];
  let m: RegExpExecArray | null;
  while ((m = entryPattern.exec(src)) !== null) {
    entries.push({ storeId: m[1]!, shapeKind: m[2]! });
  }
  return entries;
}

// ── Relay-source CREATE TABLE scanner ────────────────────────────────
//
// Walks `services/relay/src/` looking for CREATE TABLE statements
// matching aliases. Mirrors #67's extractCreateTables but without the
// migration-registry split (relay's migrations live in one file:
// `services/relay/src/migrations.ts`, included in the walk).

interface CreateTableHit {
  file: string;
  tableName: string;
}

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

function extractCreateTables(content: string, file: string): CreateTableHit[] {
  // Same heuristic as #67: CREATE TABLE [IF NOT EXISTS] <name> ( ... ).
  const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_][a-z0-9_]*)\s*\(/gi;
  const hits: CreateTableHit[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(content)) !== null) {
    hits.push({ file, tableName: m[1]!.toLowerCase() });
  }
  return hits;
}

// ── Main ─────────────────────────────────────────────────────────────

interface Violation {
  kind: "missing-alias" | "missing-ddl" | "alias-without-manifest" | "alias-without-ddl";
  detail: string;
}

function main(): void {
  const manifestStores = parseManifestStores();
  if (manifestStores.length === 0) {
    console.error(
      "check-relay-retention-coverage: parsed zero stores from RETENTION_MANIFEST_CONTENT — manifest source layout may have changed. Update the parser in scripts/check-relay-retention-coverage.ts.",
    );
    process.exit(1);
  }

  // Aggregate every CREATE TABLE in services/relay/src/.
  const allCreates: CreateTableHit[] = [];
  for (const file of walkTs(RELAY_SRC_DIR)) {
    let content: string;
    try {
      content = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    allCreates.push(...extractCreateTables(content, file));
  }
  const knownTables = new Set(allCreates.map((c) => c.tableName));

  const violations: Violation[] = [];

  // ── Direction A: every manifest store has alias + DDL ──────────────
  for (const store of manifestStores) {
    const aliases = RELAY_STORE_TABLE_ALIASES[store.storeId];
    if (!aliases) {
      violations.push({
        kind: "missing-alias",
        detail:
          `Manifest declares store "${store.storeId}" (kind: ${store.shapeKind}) but ` +
          `RELAY_STORE_TABLE_ALIASES in scripts/check-relay-retention-coverage.ts has no ` +
          `entry for it. Add the canonical SQL table name(s) the store maps to.`,
      });
      continue;
    }
    const hasMatchingDdl = aliases.some((a) => knownTables.has(a));
    if (!hasMatchingDdl) {
      violations.push({
        kind: "missing-ddl",
        detail:
          `Manifest declares store "${store.storeId}" (kind: ${store.shapeKind}) but ` +
          `no CREATE TABLE for any of [${aliases.join(", ")}] exists in services/relay/src/. ` +
          `Either add the at-rest schema or remove the manifest entry — declaring enforcement ` +
          `of a store that doesn't exist is a false claim.`,
      });
    }
  }

  // ── Direction B: every alias has manifest + DDL ────────────────────
  const manifestStoreIds = new Set(manifestStores.map((s) => s.storeId));
  for (const [aliasStoreId, aliases] of Object.entries(RELAY_STORE_TABLE_ALIASES)) {
    if (!manifestStoreIds.has(aliasStoreId)) {
      violations.push({
        kind: "alias-without-manifest",
        detail:
          `RELAY_STORE_TABLE_ALIASES entry "${aliasStoreId}" has no matching ` +
          `RETENTION_MANIFEST_CONTENT.stores[] entry in ` +
          `services/relay/src/retention-manifest.ts. The alias map IS the curated source ` +
          `of "retention-obligated relay tables"; an alias without a manifest projection ` +
          `means we promised the surface but never declared the policy.`,
      });
    }
    const hasMatchingDdl = aliases.some((a) => knownTables.has(a));
    if (!hasMatchingDdl) {
      violations.push({
        kind: "alias-without-ddl",
        detail:
          `RELAY_STORE_TABLE_ALIASES entry "${aliasStoreId}" → [${aliases.join(", ")}] ` +
          `has no matching CREATE TABLE in services/relay/src/. Either remove the alias ` +
          `or add the schema.`,
      });
    }
  }

  console.log(
    `check-relay-retention-coverage — ${manifestStores.length} manifest store(s), ${
      Object.keys(RELAY_STORE_TABLE_ALIASES).length
    } alias entry(ies), ${allCreates.length} CREATE TABLE statement(s) in services/relay/src/\n`,
  );

  if (violations.length === 0) {
    console.log(
      "✓ Every manifest-declared store has an alias + DDL; every alias has a manifest entry + DDL.\n",
    );
    return;
  }

  for (const v of violations) {
    console.log(`✗ [${v.kind}]  ${v.detail}\n`);
  }
  process.exit(1);
}

main();
