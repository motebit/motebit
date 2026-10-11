#!/usr/bin/env tsx
/**
 * check-identity-authority-inventory — the committed identity-authority census
 * is fresh (docs/design/identity-authority-writers.md §4 item 5, Inc 0).
 *
 * The census (`docs/design/identity-authority-inventory.generated.md`) lists
 * every writer of identity-keyed state, which columns it assigns, and the
 * weakest door that reaches it. A new authority writer must show up as a diff
 * in review — before the static gate (`check-identity-authority-writers`)
 * names it, and whether or not it ever does. A census that silently lags the
 * code is the one way that diff never appears, so a stale census fails here.
 *
 * Two further parts ride on the same scan (identity-authority Inc 2):
 *   - shadow-guard coverage: `AUTHORITY_COLUMNS` in
 *     services/relay/src/identity-authority.ts equals the census's
 *     authority-bearing schema columns (D5: the full list);
 *   - one writer (§4 item 3, I1): every census authority writer is either in
 *     identity-authority.ts or registered in OUTSIDE_SINGLE_WRITER with why and
 *     the increment that moves it — a NEW writer elsewhere fails with a repair
 *     instruction naming writeAuthority.
 *
 * Aperture: the census script's SCAN_ROOTS (printed on success). Anything the
 * census cannot see (its header lists the limits) is invisible to this gate
 * too — the gate proves freshness, never completeness.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { failWithRepair, type RepairReport } from "./lib/gate-report.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The lines that differ between the committed census and a fresh render,
 * as committed/fresh line pairs, capped. Pure, so the stale verdict is
 * testable without the scan.
 */
export function censusDrift(committed: string, fresh: string, cap = 12): string[] {
  if (committed === fresh) return [];
  const a = committed.split("\n");
  const b = fresh.split("\n");
  const out: string[] = [];
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n && out.length < cap; i++) {
    if (a[i] === b[i]) continue;
    if (a[i] !== undefined)
      out.push(`line ${i + 1} committed: ${a[i]!.replace(/\s{2,}/g, " ").slice(0, 200)}`);
    if (b[i] !== undefined && out.length < cap)
      out.push(`line ${i + 1} fresh:     ${b[i]!.replace(/\s{2,}/g, " ").slice(0, 200)}`);
  }
  if (out.length === 0) out.push("(trailing whitespace / line-count difference only)");
  return out;
}

/** The failure block for a stale census — pure, so its repair contract is testable. */
export function staleReport(out: string, drift: string[], aperture: string): RepairReport {
  return {
    invariant: `the committed identity-authority census is stale — ${out} no longer matches the code it describes (${aperture})`,
    canonical: "scripts/inventory-identity-authority.ts",
    fix: `run \`npx tsx scripts/inventory-identity-authority.ts\` and commit ${out}. Review the diff: a new or changed row under "Authority writers" is a new door onto identity authority and must be justified against docs/design/identity-authority-writers.md (I1/I2) before merge.`,
    sites: drift,
    doctrine: "docs/design/identity-authority-writers.md §4 item 5",
  };
}

/**
 * The `table.column` pairs `AUTHORITY_COLUMNS` declares in the relay's single
 * writer (identity-authority.ts), read from the source text — the object
 * literal's keys and string-array values. Pure, so the comparison is testable.
 */
export function declaredAuthorityColumns(src: string): string[] {
  const start = src.indexOf("export const AUTHORITY_COLUMNS");
  if (start < 0) return [];
  const open = src.indexOf("= {", start);
  let depth = 0;
  let end = open + 2;
  for (; end < src.length; end++) {
    if (src[end] === "{") depth++;
    else if (src[end] === "}" && --depth === 0) break;
  }
  const body = src.slice(open + 3, end);
  const out: string[] = [];
  for (const m of body.matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
    for (const col of m[2]!.matchAll(/"(\w+)"/g)) out.push(`${m[1]}.${col[1]}`);
  }
  return out.sort();
}

/** Columns the census calls authority-bearing that the guard does not declare, and vice versa. */
export function guardCoverageDrift(census: string[], declared: string[]): string[] {
  const d = new Set(declared);
  const c = new Set(census);
  return [
    ...census
      .filter((f) => !d.has(f))
      .map(
        (f) => `UNGUARDED: ${f} is authority-bearing in the census but not in AUTHORITY_COLUMNS`,
      ),
    ...declared
      .filter((f) => !c.has(f))
      .map((f) => `STALE: ${f} is in AUTHORITY_COLUMNS but not authority-bearing in the census`),
  ];
}

/** The failure block for a guard that does not cover the census's columns. */
export function coverageReport(drift: string[]): RepairReport {
  return {
    invariant: `the identity-authority shadow guard covers exactly the census's authority-bearing columns (D5: the full list, never a hand-picked subset) — ${drift.length} difference(s)`,
    canonical: "services/relay/src/identity-authority.ts (AUTHORITY_COLUMNS)",
    fix: 'make AUTHORITY_COLUMNS equal the census\'s "Authority-bearing fields" (relay/persistence schema rows): add every UNGUARDED column, remove every STALE one. A column the census newly calls authority-bearing is guarded the moment it is declared — installAuthorityGuards installs its triggers and throws at boot if the column does not exist.',
    sites: drift,
    doctrine: "docs/design/identity-authority-writers.md §4 item 1 (Inc 2), decision D5",
  };
}

const SINGLE_WRITER_FILE = "services/relay/src/identity-authority.ts";

// ── Part 3: one writer — a new authority writer outside identity-authority.ts fails ──

/** One census authority writer, identified without its line (lines move). */
export interface AuthorityWriterSite {
  file: string;
  fn: string;
  /** `VERB table`, as the census prints it. */
  write: string;
  /**
   * The authority-bearing columns it writes (sorted). Part of the identity of
   * a registration: a registered writer that starts writing another authority
   * column is a new writer (F3b of the Inc 2 review).
   */
  columns?: readonly string[];
}

/**
 * The single writer's own declarations — the ONLY exemption (F3a of the Inc 2
 * review): a writer elsewhere in identity-authority.ts, exported or not, is a
 * writer outside the single writer like any other.
 */
export const SINGLE_WRITER_DECLARATIONS: ReadonlySet<string> = new Set([
  "writeAuthority",
  "applyChange",
  "writeOperatorAct",
]);

const insideSingleWriter = (s: AuthorityWriterSite): boolean =>
  s.file === SINGLE_WRITER_FILE && SINGLE_WRITER_DECLARATIONS.has(s.fn);

interface Outside extends AuthorityWriterSite {
  count: number;
  /** Why it is not (yet) the single writer, and the increment that moves it. */
  why: string;
}

const INC3_SUCCESSION =
  "G-succession (§1.3 rows 11–16): `applySuccession` is signed by the departing key; Inc 3 folds its verification into `proveSuccession` and departs only from the proven current key";
const INC3_DEVICE =
  "device rows (§1.3 row 8): written without proof of the identity's key today; Inc 3 makes bootstrap / register-self prove possession (verifyKeyPossession, refuseSovereignIdSquat) and re-homes the write";
const INC4_REVOKE =
  "revocation / listing state (§1.3 rows 17–19, D3): Inc 4 requires a ProvenKey or an OperatorAct (writeOperatorAct, reducing changes only)";
const HOLDER =
  "evidence-gated holder writer (rule 23: E-sov / E-link / E-mig / E-op / E-main); Inc 3 re-homes it under writeAuthority / writeOperatorAct";
const HELPER =
  "writer helper called only inside writeAuthority's open window (identity-authority.ts), so its write is the single writer's";
const DERIVED_TRUST =
  "derived (§3.5): a trust edge from a receipt that passed `admitReceipt` (rule 28), or the worker's own adapter — Inc 5 (`trust-authority.ts`) for the worker store";
const PEER =
  "peer authority (§5): `writePeerRow` / the relay's own forward observations — Inc 6 (`peer-authority.ts`, PeerProof)";
const DERIVED_MONEY =
  "derived (§3.5): copies the destination of a withdrawal or settlement the relay already admitted (rule 13 / rule 9 snapshot); its source door is the single writer's";
const RETENTION =
  "retention or migration: deletes rows past a horizon or rewrites at boot — no request chooses the value (I2: may reduce, never create)";
const NOT_AUTHORITY =
  "not authority — a false positive of the census name rule (§1.3: intake ledger, self-certifying skill namespace)";

/**
 * Every census authority writer that is NOT `identity-authority.ts`, with why
 * and the increment that retires it. Counted per (file, function, write): a
 * second writer cut into a function that already has one fails too. Shrinks as
 * increments land; a new entry is a design decision, never a quiet append.
 */
export const OUTSIDE_SINGLE_WRITER: readonly Outside[] = [
  {
    file: "services/relay/src/agents.ts",
    fn: "applyRevocation",
    write: "UPDATE agent_registry",
    columns: ["delisted_at", "revoked"],
    count: 2,
    why: INC4_REVOKE,
  },
  {
    file: "services/relay/src/key-rotation.ts",
    fn: "POST /api/v1/agents/:motebitId/revoke",
    write: "UPDATE agent_registry",
    columns: ["capabilities", "delisted_at", "endpoint_url", "revoked"],
    count: 1,
    why: INC4_REVOKE,
  },
  {
    file: "services/relay/src/migration.ts",
    fn: "commitDeparture",
    write: "UPDATE agent_registry",
    columns: ["capabilities", "delisted_at", "endpoint_url", "revoked"],
    count: 1,
    why: INC4_REVOKE,
  },
  {
    file: "services/relay/src/migration.ts",
    fn: "POST /api/v1/agents/accept-migration",
    write: "INSERT agent_registry",
    columns: ["capabilities", "delisted_at", "endpoint_url", "public_key", "revoked"],
    count: 1,
    why: "evidence-gated: a migration arrival whose sovereign binding verified (E-mig, rule 23); Inc 4 re-homes it under writeAuthority",
  },
  {
    file: "services/relay/src/migrations.ts",
    fn: "up",
    write: "UPDATE agent_registry",
    columns: ["delisted_at"],
    count: 1,
    why: RETENTION,
  },
  {
    file: "services/relay/src/succession-apply.ts",
    fn: "applySuccession",
    write: "UPDATE agent_registry",
    columns: ["public_key"],
    count: 1,
    why: INC3_SUCCESSION,
  },
  {
    file: "services/relay/src/succession-apply.ts",
    fn: "applySuccession",
    write: "UPDATE agent_registry",
    columns: ["settlement_address"],
    count: 1,
    why: INC3_SUCCESSION,
  },
  {
    file: "services/relay/src/tasks.ts",
    fn: "healRegistryKey",
    write: "UPDATE agent_registry",
    columns: ["public_key"],
    count: 1,
    why: "§1.3 row 7: a device-row key promoted to the registry key; Inc 3 deletes `healRegistryKey`",
  },
  {
    file: "packages/persistence/src/index.ts",
    fn: "<module>",
    write: "REPLACE agent_trust",
    columns: ["failed_tasks", "interaction_count", "public_key", "successful_tasks", "trust_level"],
    count: 1,
    why: DERIVED_TRUST,
  },
  {
    file: "packages/persistence/src/index.ts",
    fn: "<module>",
    write: "UPDATE agent_trust",
    columns: ["trust_level"],
    count: 1,
    why: DERIVED_TRUST,
  },
  {
    file: "services/relay/src/migration.ts",
    fn: "POST /api/v1/agents/accept-migration",
    write: "REPLACE agent_trust",
    columns: ["trust_level"],
    count: 1,
    why: "evidence-gated: a migration arrival whose sovereign binding verified (E-mig, rule 23); Inc 4 re-homes it under writeAuthority",
  },
  {
    file: "packages/runtime/src/agent-trust.ts",
    fn: "bumpTrustFromReceipt",
    write: "STORE agent_trust (adapter)",
    columns: [
      "avg_quality",
      "failed_tasks",
      "interaction_count",
      "public_key",
      "successful_tasks",
      "trust_level",
    ],
    count: 2,
    why: DERIVED_TRUST,
  },
  {
    file: "packages/runtime/src/agent-trust.ts",
    fn: "recordAgentInteraction",
    write: "STORE agent_trust (adapter)",
    columns: [
      "avg_quality",
      "failed_tasks",
      "interaction_count",
      "public_key",
      "successful_tasks",
      "trust_level",
    ],
    count: 2,
    why: DERIVED_TRUST,
  },
  {
    file: "packages/runtime/src/motebit-runtime.ts",
    fn: "setAgentPetname",
    write: "STORE agent_trust (adapter)",
    columns: [
      "avg_quality",
      "failed_tasks",
      "interaction_count",
      "public_key",
      "successful_tasks",
      "trust_level",
    ],
    count: 1,
    why: DERIVED_TRUST,
  },
  {
    file: "services/relay/src/tasks.ts",
    fn: "settleLocalAnswer",
    write: "STORE agent_trust (adapter)",
    columns: [
      "avg_quality",
      "failed_tasks",
      "interaction_count",
      "public_key",
      "successful_tasks",
      "trust_level",
    ],
    count: 2,
    why: DERIVED_TRUST,
  },
  {
    file: "packages/persistence/src/index.ts",
    fn: "<module>",
    write: "REPLACE devices",
    columns: ["device_id", "device_token", "hardware_attestation_credential", "public_key"],
    count: 1,
    why: INC3_DEVICE,
  },
  {
    file: "services/relay/src/succession-apply.ts",
    fn: "applySuccession",
    write: "UPDATE devices",
    columns: ["hardware_attestation_credential", "public_key"],
    count: 1,
    why: INC3_SUCCESSION,
  },
  {
    file: "services/relay/src/identity-keys.ts",
    fn: "recordIdentityKey",
    write: "INSERT identity_keys",
    columns: ["guardian_public_key", "public_key"],
    count: 1,
    why: HOLDER,
  },
  {
    file: "services/relay/src/identity-keys.ts",
    fn: "recordIdentityGuardian",
    write: "UPDATE identity_keys",
    columns: ["guardian_public_key"],
    count: 1,
    why: HOLDER,
  },
  {
    file: "services/relay/src/identity-keys.ts",
    fn: "<module>",
    write: "INSERT identity_keys",
    columns: ["guardian_public_key", "public_key"],
    count: 1,
    why: HOLDER,
  },
  {
    file: "services/relay/src/pairing.ts",
    fn: "POST /pairing/claim",
    write: "UPDATE pairing_sessions",
    columns: ["claiming_public_key", "claiming_x25519_pubkey"],
    count: 1,
    why: "§1.3 row 10: the claiming device's key — a sync-only grant under D1 (a device is never identity authority); Inc 3 adds possession proof at claim",
  },
  {
    file: "services/relay/src/agent-revocation.ts",
    fn: "insertRevocationRecord",
    write: "INSERT relay_agent_revocations",
    columns: ["revoked"],
    count: 1,
    why: INC4_REVOKE,
  },
  {
    file: "services/relay/src/bond-store.ts",
    fn: "recordBondCommitment",
    write: "INSERT relay_bond_commitments",
    columns: ["bonded_address", "bonded_public_key"],
    count: 1,
    why: "§1.3 row 25 (G-bond): verified under the holder, else the registry key; Inc 3 binds it to the proven current key",
  },
  {
    file: "services/relay/src/delegation-revocations.ts",
    fn: "insertDelegationRevocation",
    write: "INSERT relay_delegation_revocations",
    columns: ["delegator_public_key", "revoked_at"],
    count: 1,
    why: "request-signed: the revocation verifies under a key the relay holds for its delegator (bindByDelegationRevocation, #850)",
  },
  {
    file: "services/relay/src/identity-keys.ts",
    fn: "recordGuardianEvidence",
    write: "INSERT relay_guardian_evidence",
    columns: ["guardian_public_key"],
    count: 1,
    why: HELPER,
  },
  {
    file: "services/relay/src/identity-revocation.ts",
    fn: "recordIdentityRevocation",
    write: "INSERT relay_identity_revocations",
    columns: ["revoked_at"],
    count: 1,
    why: INC4_REVOKE,
  },
  {
    file: "services/relay/src/identity-revocation.ts",
    fn: "liftRevocation",
    write: "DELETE relay_identity_revocations",
    columns: ["revoked_at"],
    count: 1,
    why: INC4_REVOKE,
  },
  {
    file: "services/relay/src/key-proof-replay.ts",
    fn: "recordKeyProofAccepted",
    write: "DELETE relay_key_proofs_accepted",
    columns: ["public_key"],
    count: 1,
    why: HELPER,
  },
  {
    file: "services/relay/src/key-proof-replay.ts",
    fn: "recordKeyProofAccepted",
    write: "INSERT relay_key_proofs_accepted",
    columns: ["public_key"],
    count: 1,
    why: HELPER,
  },
  {
    file: "services/relay/src/succession-apply.ts",
    fn: "applySuccession",
    write: "INSERT relay_key_successions",
    columns: ["guardian_signature", "new_public_key", "old_public_key", "recovery"],
    count: 1,
    why: INC3_SUCCESSION,
  },
  {
    file: "services/relay/src/intake-routes.ts",
    fn: "POST /api/v1/motebits/announce",
    write: "INSERT relay_motebit_intake",
    columns: ["public_key"],
    count: 1,
    why: NOT_AUTHORITY,
  },
  {
    file: "services/relay/src/federation-callbacks.ts",
    fn: "settleFederatedAnswer",
    write: "UPDATE relay_peers",
    columns: ["failed_forwards", "successful_forwards", "trust_level", "trust_score"],
    count: 1,
    why: PEER,
  },
  {
    file: "services/relay/src/federation.ts",
    fn: "writePeerRow",
    write: "INSERT relay_peers",
    columns: [
      "endpoint_url",
      "missed_heartbeats",
      "nonce",
      "peer_protocol_version",
      "peered_at",
      "public_key",
      "state",
      "trust_score",
    ],
    count: 1,
    why: PEER,
  },
  {
    file: "services/relay/src/federation.ts",
    fn: "writePeerRow",
    write: "DELETE relay_peers",
    columns: [
      "endpoint_url",
      "failed_forwards",
      "missed_heartbeats",
      "nonce",
      "peer_protocol_version",
      "peered_at",
      "public_key",
      "state",
      "successful_forwards",
      "trust_level",
      "trust_score",
    ],
    count: 1,
    why: PEER,
  },
  {
    file: "services/relay/src/federation.ts",
    fn: "writePeerRow",
    write: "UPDATE relay_peers",
    columns: [
      "endpoint_url",
      "missed_heartbeats",
      "nonce",
      "peer_protocol_version",
      "peered_at",
      "state",
    ],
    count: 1,
    why: PEER,
  },
  {
    file: "services/relay/src/task-routing.ts",
    fn: "recordPeerForwardResult",
    write: "UPDATE relay_peers",
    columns: ["failed_forwards"],
    count: 1,
    why: PEER,
  },
  {
    file: "services/relay/src/task-routing.ts",
    fn: "recordPeerForwardResult",
    write: "UPDATE relay_peers",
    columns: ["state"],
    count: 1,
    why: PEER,
  },
  {
    file: "services/relay/src/task-routing.ts",
    fn: "resetCircuitBreaker",
    write: "UPDATE relay_peers",
    columns: ["failed_forwards"],
    count: 1,
    why: PEER,
  },
  {
    file: "services/relay/src/tasks.ts",
    fn: "deliverLocalAnswer",
    write: "UPDATE relay_peers",
    columns: ["failed_forwards", "successful_forwards", "trust_level", "trust_score"],
    count: 1,
    why: PEER,
  },
  {
    file: "services/relay/src/account-store-sqlite.ts",
    fn: "debitAndEnqueuePending",
    write: "INSERT relay_pending_withdrawals",
    columns: ["destination", "rail"],
    count: 1,
    why: DERIVED_MONEY,
  },
  {
    file: "services/relay/src/identity-keys.ts",
    fn: "recordRegistryKeyEvidence",
    write: "INSERT relay_registry_key_evidence",
    columns: ["public_key"],
    count: 1,
    why: HELPER,
  },
  {
    file: "services/relay/src/federation.ts",
    fn: "insertRevocationEvent",
    write: "INSERT relay_revocation_events",
    columns: ["new_public_key"],
    count: 1,
    why: "derived: the federation `key_rotated` / revocation event recorded after a verified succession or revocation (§1.3 rows 11–16)",
  },
  {
    file: "services/relay/src/horizon.ts",
    fn: "truncateRevocationEventsBeforeHorizon",
    write: "DELETE relay_revocation_events",
    columns: ["new_public_key"],
    count: 1,
    why: RETENTION,
  },
  {
    file: "services/relay/src/index.ts",
    fn: "createSyncRelay",
    write: "DELETE relay_service_listings",
    columns: ["capabilities", "pay_to_address", "pricing"],
    count: 1,
    why: RETENTION,
  },
  {
    file: "services/relay/src/succession-apply.ts",
    fn: "applySuccession",
    write: "UPDATE relay_service_listings",
    columns: ["pay_to_address"],
    count: 1,
    why: INC3_SUCCESSION,
  },
  {
    file: "services/relay/src/allocation-escrow.ts",
    fn: "insertRow",
    write: "INSERT relay_settlements",
    columns: ["p2p_worker_address", "p2p_worker_address_rung"],
    count: 2,
    why: DERIVED_MONEY,
  },
  {
    file: "services/relay/src/horizon.ts",
    fn: "truncateSettlementsBeforeHorizon",
    write: "DELETE relay_settlements",
    columns: ["p2p_worker_address", "p2p_worker_address_rung"],
    count: 1,
    why: RETENTION,
  },
  {
    file: "services/relay/src/migrations.ts",
    fn: "up",
    write: "DELETE relay_settlements",
    columns: ["p2p_worker_address", "p2p_worker_address_rung"],
    count: 1,
    why: RETENTION,
  },
  {
    file: "services/relay/src/skill-registry.ts",
    fn: "POST /api/v1/skills/submit",
    write: "REPLACE relay_skill_registry",
    columns: ["signature_public_key"],
    count: 1,
    why: NOT_AUTHORITY,
  },
  {
    file: "services/relay/src/account-store-sqlite.ts",
    fn: "insertWithdrawal",
    write: "INSERT relay_withdrawals",
    columns: ["destination"],
    count: 1,
    why: "the withdrawal store's own insert, reached from the withdraw door only through `requestWithdrawal` inside `writeAuthority` / `writeAuthorityUnproven` (identity-authority.ts)",
  },
  {
    file: "services/relay/src/batch-withdrawals.ts",
    fn: "recordFiredWithdrawal",
    write: "INSERT relay_withdrawals",
    columns: ["destination"],
    count: 1,
    why: DERIVED_MONEY,
  },
  {
    file: "packages/persistence/src/index.ts",
    fn: "<module>",
    write: "REPLACE service_listings",
    columns: ["capabilities", "pricing"],
    count: 1,
    why: "the worker's own local listing copy (persistence; over-reach of the census name graph, §1.3) — no relay route reads it as authority",
  },
  {
    file: "packages/persistence/src/index.ts",
    fn: "<module>",
    write: "DELETE service_listings",
    columns: ["capabilities", "pricing"],
    count: 1,
    why: "the worker's own local listing copy (persistence; over-reach of the census name graph, §1.3) — no relay route reads it as authority",
  },
];

const key = (s: AuthorityWriterSite): string =>
  `${s.file} | ${s.fn} | ${s.write}${s.columns !== undefined ? ` [${s.columns.join(", ")}]` : ""}`;

/** The census writers the registry does not account for, and stale entries. Pure. */
export function singleWriterProblems(
  sites: readonly AuthorityWriterSite[],
  registry: readonly Outside[] = OUTSIDE_SINGLE_WRITER,
): string[] {
  const have = new Map<string, number>();
  for (const s of sites) {
    if (insideSingleWriter(s)) continue;
    have.set(key(s), (have.get(key(s)) ?? 0) + 1);
  }
  const want = new Map(registry.map((r) => [key(r), r.count]));
  const problems: string[] = [];
  for (const [k, n] of have) {
    const w = want.get(k) ?? 0;
    if (n > w)
      problems.push(
        `NEW authority writer outside the single writer: ${k}${w > 0 ? ` (${n} found, ${w} registered)` : ""}`,
      );
  }
  for (const [k, w] of want) {
    const n = have.get(k) ?? 0;
    if (n < w) problems.push(`STALE entry: ${k} — ${w} registered, ${n} found; lower or delete it`);
  }
  return problems;
}

/** The failure block for a writer outside the single writer. */
export function singleWriterReport(problems: string[], aperture: string): RepairReport {
  return {
    invariant: `I1 — an authority-bearing column is written only by the canonical authority writer (${SINGLE_WRITER_FILE}); ${problems.length} census writer(s) outside it are unaccounted for (${aperture})`,
    canonical: `${SINGLE_WRITER_FILE} (writeAuthority / AuthorityChange) and OUTSIDE_SINGLE_WRITER in scripts/check-identity-authority-inventory.ts`,
    fix: "route the write through writeAuthority(db, cap, change): add its change to the AuthorityChange union in identity-authority.ts, have the door mint the ProvenKey with authorityFromRequest / proveCurrentKey, and apply it with applyAuthorityChange. Only a write that is derived from an artifact that already passed its own chokepoint (design §3.5) or one a named later increment moves may instead be registered in OUTSIDE_SINGLE_WRITER, with that reason. A STALE entry means a writer moved or left: lower or delete it.",
    sites: problems,
    doctrine: "docs/design/identity-authority-writers.md §3–§4 (I1, I2)",
  };
}

async function main(): Promise<void> {
  // Importing the census runs the scan (≈5 s); its main() is guarded.
  const { renderCensus, censusAperture, CENSUS_OUT, authoritySchemaFields, authorityWriterSites } =
    await import("./inventory-identity-authority.js");
  const fresh = await renderCensus();
  const path = resolve(ROOT, CENSUS_OUT);
  const committed = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const drift = censusDrift(committed, fresh);
  if (drift.length > 0) {
    failWithRepair(staleReport(CENSUS_OUT, drift, censusAperture()));
  }
  const census = authoritySchemaFields();
  const declared = declaredAuthorityColumns(
    readFileSync(resolve(ROOT, SINGLE_WRITER_FILE), "utf-8"),
  );
  const coverage = guardCoverageDrift(census, declared);
  if (coverage.length > 0) failWithRepair(coverageReport(coverage));
  const sites = authorityWriterSites();
  const writerProblems = singleWriterProblems(sites);
  if (writerProblems.length > 0)
    failWithRepair(singleWriterReport(writerProblems, censusAperture()));
  console.log(`✓ check-identity-authority-inventory — census fresh: ${censusAperture()}`);
  console.log(
    `  Shadow guard: AUTHORITY_COLUMNS (${SINGLE_WRITER_FILE}) declares exactly the census's ${census.length} authority-bearing schema column(s).`,
  );
  const inside = sites.filter(insideSingleWriter).length;
  console.log(
    `  Single writer: ${sites.length} census authority writer(s) — ${inside} in ${SINGLE_WRITER_FILE}'s writer declarations (${[...SINGLE_WRITER_DECLARATIONS].join(" / ")}), ${sites.length - inside} outside them, each registered in OUTSIDE_SINGLE_WRITER (${OUTSIDE_SINGLE_WRITER.length} entries, keyed by file, function, table and authority COLUMN SET) with the increment that moves it. Aperture: the census's SCAN_ROOTS and name rule; a writer the census cannot see is not examined.`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
