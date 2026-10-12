/**
 * Identity-authority census — the operator's read-only measure of authority
 * state that may have been written by a party that never proved the
 * identity's current key (docs/design/identity-authority-writers.md §6,
 * Inc 1). Production allows no direct database read, so the queries ship
 * inside the relay and are served on the master-token
 * `GET /api/v1/admin/identity-authority/census`
 * (`scripts/measure-identity-authority.ts` fetches it).
 *
 * Read-only AT THE DATABASE, not by convention: every statement the census
 * runs goes through `readOnlyHandle`, which executes it on the relay's own
 * better-sqlite3 connection with `PRAGMA query_only = ON` set for exactly that
 * statement (synchronously, so no other request's statement can run inside
 * the window) and restored after. A write attempted through the handle is
 * refused by SQLite itself (`SQLITE_READONLY`, "attempt to write a readonly
 * database"); `exec`, `pragma`, `transaction` and `close` are refused on the
 * handle outright, so nothing can switch the pragma off from inside. A
 * second, `readonly`-opened connection was not used: the relay opens its
 * database only in `index.ts` (its TEMP freeze triggers are per connection),
 * and a test relay's database is in memory, which a second connection cannot
 * see. The route answers counts, ids, device ids, timestamps, booleans and
 * buckets — never a key, a token, an address or a signature.
 *
 * Every row or id the census flags carries exactly ONE bucket
 * (`CensusBucket`; the per-query rules are on `bucketQ1`… below and in §6):
 *
 *   - `definitely_invalid` — provably written without proof of the
 *     identity's current key where that proof was required. Only this bucket
 *     may ever become eligible for automatic cleanup; the census cleans
 *     nothing, and no cleanup exists.
 *   - `suspicious` — cannot be decided from what the relay holds; a human
 *     reviews it.
 *   - `legitimate_legacy` — written by a door that was legitimate when it
 *     wrote (a pairing approval, a key the identity's own chain retired, a
 *     peer recorded under an older federation protocol).
 *
 * "Current key" (§3.2), as far as the schema on this branch can answer it:
 *
 *   - Sovereign id (the id is the commitment of some key it holds): the head
 *     of the recorded succession chain walked from that genesis key K₀, link
 *     by link (`old_public_key` = the current head). Recovery links are walked
 *     like any other — the guardian-standing rule (875's v60) is not on this
 *     branch, so a recovery link can only make the lineage LONGER, never make
 *     a row read planted that the full design would call proven. A sovereign
 *     id with no held key committing to it has no K₀ and no current key.
 *   - Legacy id: the `identity_keys` holder only when its source is evidence
 *     the relay recorded by proof — `succession`, `migration`, `operator`.
 *     `register` and `backfill:registry` are not evidence for a legacy id
 *     (D2), so such an id has NO current key and every one of its authority
 *     values is listed as unproven.
 *
 * The lists are capped (`limit`); the counts are whole.
 */
import type { DatabaseDriver, PreparedStatement } from "@motebit/persistence";
import { hexToBytes } from "@motebit/encryption";
import { deriveSolanaAddress } from "@motebit/wallet-solana";
import { proveSovereignFirstKey, provenGuardianOf } from "./identity-keys.js";

/** Legacy-id holder sources that are evidence the relay recorded by proof (D2). */
const LEGACY_EVIDENCE_SOURCES: ReadonlySet<string> = new Set([
  "succession",
  "migration",
  "operator",
]);

/** The federation protocol version at which the v2 heartbeat/remove kinds ship (Q6). */
export const FEDERATION_V2_MIN_MINOR = 5;

/** Withdrawal destinations are read over this trailing window (Q3). */
const WITHDRAWAL_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

export const CENSUS_DEFAULT_LIMIT = 200;
export const CENSUS_MAX_LIMIT = 1000;

/** Exactly one per flagged row or id; see the module comment and §6. */
export type CensusBucket = "definitely_invalid" | "suspicious" | "legitimate_legacy";
export type BucketCounts = Record<CensusBucket, number>;
export type IdsByBucket = Record<CensusBucket, string[]>;

const BUCKETS: readonly CensusBucket[] = ["definitely_invalid", "suspicious", "legitimate_legacy"];

/**
 * A sovereign id's SHAPE, decidable from the id alone. Mirrors `isSovereignShaped`
 * in `@motebit/crypto`'s roster-key-chain.ts (not exported); whether a KEY is
 * that id's commitment is decided only by the relay's own predicate,
 * `proveSovereignFirstKey`.
 */
const SOVEREIGN_SHAPE = (id: string): boolean =>
  id.startsWith("did:key:") ||
  /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);

function queryOnlyOn(db: DatabaseDriver): boolean {
  const r = db.pragma("query_only");
  const row = Array.isArray(r) ? (r[0] as Record<string, unknown> | undefined) : r;
  if (typeof row === "number") return row === 1;
  return (row as { query_only?: number } | undefined)?.query_only === 1;
}

/**
 * A handle on `db` on which the DATABASE refuses every write: each statement
 * executes with `PRAGMA query_only = ON` (restored to its prior value after),
 * so an INSERT/UPDATE/DELETE fails inside SQLite with `SQLITE_READONLY`.
 * Statement execution is synchronous, so no other caller's statement runs
 * inside the window. `exec`, `pragma`, `transaction` and `close` are refused.
 */
export function readOnlyHandle(db: DatabaseDriver): DatabaseDriver {
  const guarded = <T>(fn: () => T): T => {
    const prior = queryOnlyOn(db);
    if (!prior) db.pragma("query_only = ON");
    try {
      return fn();
    } finally {
      if (!prior) db.pragma("query_only = OFF");
    }
  };
  const refused = (what: string) => (): never => {
    throw new Error(`identity-authority census: ${what} is refused on the read-only handle`);
  };
  return {
    driverName: db.driverName,
    exec: refused("exec"),
    pragma: refused("pragma"),
    close: refused("close"),
    transaction: refused("transaction"),
    prepare(sql: string): PreparedStatement {
      const st = db.prepare(sql);
      return {
        run: (...p: unknown[]) => guarded(() => st.run(...p)),
        get: (...p: unknown[]) => guarded(() => st.get(...p)),
        all: (...p: unknown[]) => guarded(() => st.all(...p)),
      };
    },
  };
}

type Basis = "sovereign_lineage" | "holder_evidence" | "none";

interface CurrentKey {
  key: string | null;
  basis: Basis;
  /**
   * Sovereign ids: every key on the lineage from K₀. Legacy evidence-backed
   * ids: the holder and the keys its recorded chain walks back through. Lowercased.
   */
  lineage: ReadonlySet<string>;
}

interface Listed<T> {
  count: number;
  buckets: BucketCounts;
  rows: T[];
}

interface IdList {
  count: number;
  ids: string[];
  buckets: BucketCounts;
  by_bucket: IdsByBucket;
}

export interface IdentityAuthorityCensus {
  measured_at: number;
  limit: number;
  /** Q1 — device rows whose key is not the identity's current key. */
  q1_planted_device_rows: {
    count: number;
    /** Of `count`, rows of identities with no current key at all. */
    count_no_current_key: number;
    buckets: BucketCounts;
    rows: Array<{
      motebit_id: string;
      device_id: string;
      registered_at: number;
      current_key_basis: Basis;
      matches_holder: boolean;
      id_commits_to_device_key: boolean;
      /** The row is a pairing session's `approved_device_id` for this identity. */
      paired: boolean;
      bucket: CensusBucket;
    }>;
  };
  /** Q2 — sovereign ids whose held keys are off the genesis lineage. */
  q2_sovereign_squats: IdList;
  /** Q3 — money destinations not derived from the current key. */
  q3_unbound_money_destinations: {
    settlement_address: Listed<MoneyRow>;
    pay_to_address: Listed<MoneyRow>;
    withdrawal_destination: Listed<MoneyRow & { source: string }>;
  };
  /** Q4 — guardians recorded with no provenance (all of them on a relay before v58). */
  q4_unproven_guardians: { identity_keys: IdList; agent_registry: IdList };
  /** Q5 — keyless ids carrying a keyed device row (register-self's first-come residual). */
  q5_keyless_with_device_rows: IdList;
  /** Q6 — peers with no evidence of the v2 (relay-federation@1.5) protocol. */
  q6_v1_peers: IdList & { by_state: Record<string, number> };
}

interface MoneyRow {
  motebit_id: string;
  reason: "no_current_key" | "not_derived_from_current_key";
  /** The identity's virtual-account balance (micro-units), the ranking key. */
  balance_micro: number;
  bucket: CensusBucket;
}

const lower = (k: string | null | undefined): string | null =>
  k == null || k === "" ? null : k.toLowerCase();

const isHex32 = (k: string): boolean => /^[0-9a-f]{64}$/i.test(k);

function hasTable(db: DatabaseDriver, table: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

function hasColumn(db: DatabaseDriver, table: string, column: string): boolean {
  return (
    db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column) !== undefined
  );
}

/** The derived Solana address of a key, or null when the key is not a 32-byte hex key. */
function derivedAddress(key: string | null): string | null {
  if (key == null || !isHex32(key)) return null;
  try {
    return deriveSolanaAddress(hexToBytes(key));
  } catch {
    return null;
  }
}

function tally(buckets: Iterable<CensusBucket>): BucketCounts {
  const out: BucketCounts = { definitely_invalid: 0, suspicious: 0, legitimate_legacy: 0 };
  for (const b of buckets) out[b]++;
  return out;
}

function idList(entries: Array<{ id: string; bucket: CensusBucket }>, limit: number): IdList {
  const by_bucket = {} as IdsByBucket;
  for (const b of BUCKETS)
    by_bucket[b] = entries
      .filter((e) => e.bucket === b)
      .map((e) => e.id)
      .slice(0, limit);
  return {
    count: entries.length,
    ids: entries.map((e) => e.id).slice(0, limit),
    buckets: tally(entries.map((e) => e.bucket)),
    by_bucket,
  };
}

/** Resolves and caches each identity's current key (§3.2, as this branch can answer it). */
class CurrentKeys {
  private readonly cache = new Map<string, CurrentKey>();
  private readonly commits = new Map<string, Promise<boolean>>();

  constructor(private readonly db: DatabaseDriver) {}

  /**
   * True iff `key` is `id`'s sovereign commitment — the relay's own predicate
   * (`proveSovereignFirstKey`: a UUIDv8 commitment or a did:key, exact id),
   * over the key's canonical lowercase spelling.
   */
  commitsTo(id: string, key: string): Promise<boolean> {
    if (!isHex32(key)) return Promise.resolve(false);
    const k = key.toLowerCase();
    const memo = `${id}\u0000${k}`;
    let p = this.commits.get(memo);
    if (p === undefined) {
      p = proveSovereignFirstKey(id, k).then((proof) => proof !== null);
      this.commits.set(memo, p);
    }
    return p;
  }

  holder(id: string): { key: string | null; source: string | null; updated_at: number | null } {
    const row = this.db
      .prepare("SELECT public_key, source, updated_at FROM identity_keys WHERE motebit_id = ?")
      .get(id) as { public_key: string; source: string; updated_at: number | null } | undefined;
    return {
      key: lower(row?.public_key),
      source: row?.source ?? null,
      updated_at: row?.updated_at ?? null,
    };
  }

  registryKey(id: string): string | null {
    const row = this.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(id) as { public_key: string } | undefined;
    return lower(row?.public_key);
  }

  private links(id: string): Array<{ old: string | null; new: string | null }> {
    return (
      this.db
        .prepare(
          "SELECT old_public_key, new_public_key FROM relay_key_successions WHERE motebit_id = ? ORDER BY id",
        )
        .all(id) as Array<{ old_public_key: string; new_public_key: string }>
    ).map((l) => ({ old: lower(l.old_public_key), new: lower(l.new_public_key) }));
  }

  /** Every key this relay holds for `id`, anywhere. */
  knownKeys(id: string): string[] {
    const keys = new Set<string>();
    const add = (k: string | null | undefined): void => {
      const l = lower(k);
      if (l !== null) keys.add(l);
    };
    add(this.holder(id).key);
    add(this.registryKey(id));
    for (const r of this.db
      .prepare("SELECT public_key FROM devices WHERE motebit_id = ?")
      .all(id) as Array<{ public_key: string }>)
      add(r.public_key);
    for (const l of this.links(id)) {
      add(l.old);
      add(l.new);
    }
    return [...keys];
  }

  async of(id: string): Promise<CurrentKey> {
    const hit = this.cache.get(id);
    if (hit !== undefined) return hit;
    let k0: string | null = null;
    for (const k of this.knownKeys(id)) {
      if (await this.commitsTo(id, k)) {
        k0 = k;
        break;
      }
    }
    let result: CurrentKey;
    const links = this.links(id);
    if (k0 !== null) {
      const lineage = new Set<string>([k0]);
      let head = k0;
      for (const l of links) {
        if (l.old === head) {
          head = l.new ?? head;
          lineage.add(head);
        }
      }
      result = { key: head, basis: "sovereign_lineage", lineage };
    } else {
      const h = this.holder(id);
      if (h.key !== null && h.source !== null && LEGACY_EVIDENCE_SOURCES.has(h.source)) {
        // The holder's ancestry: walk the recorded chain BACK from the holder.
        const lineage = new Set<string>([h.key]);
        let cur = h.key;
        for (let i = links.length - 1; i >= 0; i--) {
          const l = links[i]!;
          if (l.new === cur && l.old !== null && !lineage.has(l.old)) {
            cur = l.old;
            lineage.add(cur);
          }
        }
        result = { key: h.key, basis: "holder_evidence", lineage };
      } else {
        result = { key: null, basis: "none", lineage: new Set() };
      }
    }
    this.cache.set(id, result);
    return result;
  }

  /** True iff `key` IS `id`'s current key (sovereign: on the lineage from K₀). */
  async onCurrent(id: string, key: string): Promise<boolean> {
    const cur = await this.of(id);
    const k = key.toLowerCase();
    return cur.basis === "sovereign_lineage" ? cur.lineage.has(k) : cur.key === k;
  }
}

/**
 * The census's own reading of one device key under one identity — the same
 * predicate Q1 applies (exported so a test can ask it of a row Q1 does not list).
 */
export async function deviceKeyStanding(
  db: DatabaseDriver,
  motebitId: string,
  publicKey: string,
): Promise<{ on_current_lineage: boolean; id_commits_to_device_key: boolean }> {
  const keys = new CurrentKeys(readOnlyHandle(db));
  return {
    on_current_lineage: await keys.onCurrent(motebitId, publicKey),
    id_commits_to_device_key: await keys.commitsTo(motebitId, publicKey),
  };
}

function balanceOf(db: DatabaseDriver, id: string, accounts: boolean): number {
  if (!accounts) return 0;
  const row = db.prepare("SELECT balance FROM relay_accounts WHERE motebit_id = ?").get(id) as
    { balance: number } | undefined;
  return row?.balance ?? 0;
}

/** `motebit/relay-federation@1.4` → 4; anything else → null. */
function federationMinor(version: string | null): number | null {
  const m = /^motebit\/relay-federation@1\.(\d+)$/.exec(version ?? "");
  return m ? Number(m[1]) : null;
}

/**
 * Q1's bucket for a device row whose key is not the identity's current key.
 *
 *   1. Approved through pairing (`pairing_sessions.approved_device_id` for
 *      this identity) — the approve route required an authenticated device of
 *      the identity: `legitimate_legacy` when the row holds a key that pairing
 *      carried (the claiming key, or the transfer's `identity_pubkey_check`),
 *      else `suspicious` (rewritten since by another door). Never invalid.
 *   2. The identity has no current key — no proof was possible: `suspicious`.
 *   3. The key is on the evidence-backed holder's own recorded ancestry (a key
 *      the identity's chain retired): `legitimate_legacy`.
 *   4. A legacy evidence-backed id whose holder record is newer than the row
 *      (`identity_keys.updated_at` > `registered_at`) — the key that proof
 *      would have been demanded of may not have existed yet: `suspicious`.
 *   5. Otherwise — the identity had a current key, the row's key was never
 *      on it, no pairing approved it, and the id does not commit to it:
 *      `definitely_invalid`.
 */
function bucketQ1(
  cur: CurrentKey,
  key: string,
  registeredAt: number,
  holderUpdatedAt: number | null,
  pairing: { paired: boolean; approved: ReadonlySet<string> },
): CensusBucket {
  if (pairing.paired) return pairing.approved.has(key) ? "legitimate_legacy" : "suspicious";
  if (cur.basis === "none") return "suspicious";
  if (cur.lineage.has(key)) return "legitimate_legacy";
  if (cur.basis === "holder_evidence" && (holderUpdatedAt ?? 0) > registeredAt) return "suspicious";
  return "definitely_invalid";
}

/**
 * Run Q1–Q6 over `db` through `readOnlyHandle` — the database refuses any
 * write. `limit` caps every list (clamped to 1..CENSUS_MAX_LIMIT); counts are whole.
 */
export async function measureIdentityAuthority(
  rw: DatabaseDriver,
  opts: { limit?: number; now?: number } = {},
): Promise<IdentityAuthorityCensus> {
  const db = readOnlyHandle(rw);
  const now = opts.now ?? Date.now();
  const limit = Math.min(
    CENSUS_MAX_LIMIT,
    Math.max(1, Math.floor(opts.limit ?? CENSUS_DEFAULT_LIMIT)),
  );
  const keys = new CurrentKeys(db);
  const accounts = hasTable(db, "relay_accounts");
  const pairingTable = hasTable(db, "pairing_sessions");
  const cap = <T>(xs: T[]): T[] => xs.slice(0, limit);

  const pairingOf = (
    id: string,
    deviceId: string,
  ): { paired: boolean; approved: ReadonlySet<string> } => {
    if (!pairingTable) return { paired: false, approved: new Set() };
    const rows = db
      .prepare(
        "SELECT claiming_public_key, json_extract(key_transfer_payload, '$.identity_pubkey_check') AS transferred FROM pairing_sessions WHERE motebit_id = ? AND approved_device_id = ?",
      )
      .all(id, deviceId) as Array<{ claiming_public_key: string | null; transferred: unknown }>;
    const approved = new Set<string>();
    for (const r of rows) {
      const c = lower(r.claiming_public_key);
      if (c !== null) approved.add(c);
      if (typeof r.transferred === "string") {
        const t = lower(r.transferred);
        if (t !== null) approved.add(t);
      }
    }
    return { paired: rows.length > 0, approved };
  };

  // ── Q1 ──
  const devices = db
    .prepare(
      "SELECT motebit_id, device_id, public_key, registered_at FROM devices WHERE public_key IS NOT NULL AND public_key != '' ORDER BY motebit_id, registered_at",
    )
    .all() as Array<{
    motebit_id: string;
    device_id: string;
    public_key: string;
    registered_at: number;
  }>;
  const q1: IdentityAuthorityCensus["q1_planted_device_rows"]["rows"] = [];
  let q1NoKey = 0;
  for (const d of devices) {
    const cur = await keys.of(d.motebit_id);
    const k = d.public_key.toLowerCase();
    if (await keys.onCurrent(d.motebit_id, k)) continue;
    if (cur.basis === "none") q1NoKey++;
    const h = keys.holder(d.motebit_id);
    const pairing = pairingOf(d.motebit_id, d.device_id);
    q1.push({
      motebit_id: d.motebit_id,
      device_id: d.device_id,
      registered_at: d.registered_at,
      current_key_basis: cur.basis,
      matches_holder: h.key === k,
      id_commits_to_device_key: await keys.commitsTo(d.motebit_id, k),
      paired: pairing.paired,
      bucket: bucketQ1(cur, k, d.registered_at, h.updated_at, pairing),
    });
  }

  // ── Q2 ── a sovereign-shaped id (a held key commits to it, or the id has
  // the sovereign shape) whose holder / registry key is off the genesis
  // lineage. Bucket: `definitely_invalid` when K₀ is held here and an
  // off-lineage value is not an evidence-backed holder (a registry key, or a
  // holder written by a door that proves nothing); `suspicious` when K₀ is
  // not held here (the owner may have rotated elsewhere) or the off-lineage
  // key arrived by evidence (migration / operator / succession). Never
  // `legitimate_legacy`.
  const ids = (
    db
      .prepare(
        "SELECT motebit_id FROM identity_keys UNION SELECT motebit_id FROM agent_registry ORDER BY 1",
      )
      .all() as Array<{ motebit_id: string }>
  ).map((r) => r.motebit_id);
  const q2: Array<{ id: string; bucket: CensusBucket }> = [];
  for (const id of ids) {
    const cur = await keys.of(id);
    if (!SOVEREIGN_SHAPE(id) && cur.basis !== "sovereign_lineage") continue;
    const h = keys.holder(id);
    const held = [h.key, keys.registryKey(id)].filter((k): k is string => k !== null);
    const off = held.filter((k) => !cur.lineage.has(k));
    if (off.length === 0) continue;
    const evidenced = h.source !== null && LEGACY_EVIDENCE_SOURCES.has(h.source) ? h.key : null;
    q2.push({
      id,
      bucket:
        cur.basis === "sovereign_lineage" && off.some((k) => k !== evidenced)
          ? "definitely_invalid"
          : "suspicious",
    });
  }

  // ── Q3 ── bucket: no current key → `suspicious`; the value is the derived
  // address of a key on the identity's own lineage/ancestry (a retired key)
  // → `legitimate_legacy`; of a key this relay holds for the identity that
  // was never on it (a planted key) → `definitely_invalid`; any other
  // address (the unverified rung, not decidable here) → `suspicious`.
  const moneyRow = async (id: string, value: string): Promise<MoneyRow | null> => {
    const cur = await keys.of(id);
    const balance_micro = balanceOf(db, id, accounts);
    if (cur.key === null)
      return { motebit_id: id, reason: "no_current_key", balance_micro, bucket: "suspicious" };
    if (derivedAddress(cur.key) === value) return null;
    let bucket: CensusBucket = "suspicious";
    if ([...cur.lineage].some((k) => derivedAddress(k) === value)) bucket = "legitimate_legacy";
    else if (keys.knownKeys(id).some((k) => !cur.lineage.has(k) && derivedAddress(k) === value))
      bucket = "definitely_invalid";
    return { motebit_id: id, reason: "not_derived_from_current_key", balance_micro, bucket };
  };
  const rank = <T extends MoneyRow>(xs: T[]): T[] =>
    xs.sort(
      (a, b) => b.balance_micro - a.balance_micro || a.motebit_id.localeCompare(b.motebit_id),
    );
  const listed = <T extends MoneyRow>(xs: T[]): Listed<T> => ({
    count: xs.length,
    buckets: tally(xs.map((x) => x.bucket)),
    rows: cap(rank(xs)),
  });

  const settlement: MoneyRow[] = [];
  for (const r of db
    .prepare(
      "SELECT motebit_id, settlement_address FROM agent_registry WHERE settlement_address IS NOT NULL AND settlement_address != ''",
    )
    .all() as Array<{ motebit_id: string; settlement_address: string }>) {
    const row = await moneyRow(r.motebit_id, r.settlement_address);
    if (row) settlement.push(row);
  }
  const payTo: MoneyRow[] = [];
  for (const r of db
    .prepare(
      "SELECT motebit_id, pay_to_address FROM relay_service_listings WHERE pay_to_address IS NOT NULL AND pay_to_address != ''",
    )
    .all() as Array<{ motebit_id: string; pay_to_address: string }>) {
    const row = await moneyRow(r.motebit_id, r.pay_to_address);
    if (row) payTo.push(row);
  }
  const since = now - WITHDRAWAL_WINDOW_MS;
  const withdrawals: Array<MoneyRow & { source: string }> = [];
  const withdrawalSources: Array<[string, string]> = [
    [
      "relay_withdrawals",
      "SELECT motebit_id, destination FROM relay_withdrawals WHERE requested_at >= ? AND destination IS NOT NULL AND destination != '' AND destination != 'pending'",
    ],
    [
      "relay_pending_withdrawals",
      "SELECT motebit_id, destination FROM relay_pending_withdrawals WHERE enqueued_at >= ? AND destination IS NOT NULL AND destination != ''",
    ],
  ];
  for (const [source, sql] of withdrawalSources) {
    if (!hasTable(db, source)) continue;
    for (const r of db.prepare(sql).all(since) as Array<{
      motebit_id: string;
      destination: string;
    }>) {
      const row = await moneyRow(r.motebit_id, r.destination);
      if (row) withdrawals.push({ ...row, source });
    }
  }

  // ── Q4 ── every guardian WITHOUT provenance is `suspicious`: provenance is
  // the identity's latest `relay_guardian_evidence` row naming exactly that
  // guardian (`provenGuardianOf`, the rule /rotate-key enforces). A relay
  // before v58 recorded none, so there every guardian is listed, and the
  // owner re-confirms each.
  const suspiciousIds = (sql: string): Array<{ id: string; bucket: CensusBucket }> =>
    (db.prepare(sql).all() as Array<{ motebit_id: string }>).map((r) => ({
      id: r.motebit_id,
      bucket: "suspicious",
    }));
  const evidenceHeld = hasTable(db, "relay_guardian_evidence");
  const unprovenGuardians = (sql: string): Array<{ id: string; bucket: CensusBucket }> =>
    (db.prepare(sql).all() as Array<{ motebit_id: string; guardian_public_key: string }>)
      .filter((r) => !evidenceHeld || provenGuardianOf(db, r.motebit_id) !== r.guardian_public_key)
      .map((r) => ({ id: r.motebit_id, bucket: "suspicious" }));
  const g1 = unprovenGuardians(
    "SELECT motebit_id, guardian_public_key FROM identity_keys WHERE guardian_public_key IS NOT NULL AND guardian_public_key != '' ORDER BY 1",
  );
  const g2 = unprovenGuardians(
    "SELECT motebit_id, guardian_public_key FROM agent_registry WHERE guardian_public_key IS NOT NULL AND guardian_public_key != '' ORDER BY 1",
  );

  // ── Q5 ── every keyless id with a keyed device row is `suspicious`: with
  // no key on file, no proof could have been demanded, so the first-come
  // writer and the owner are indistinguishable here.
  const q5 = suspiciousIds(
    `SELECT DISTINCT d.motebit_id FROM devices d
      WHERE d.public_key IS NOT NULL AND d.public_key != ''
        AND NOT EXISTS (SELECT 1 FROM identity_keys k WHERE k.motebit_id = d.motebit_id)
        AND NOT EXISTS (SELECT 1 FROM agent_registry r
                         WHERE r.motebit_id = d.motebit_id AND r.public_key IS NOT NULL AND r.public_key != '')
      ORDER BY 1`,
  );

  // ── Q6 ── a peer counts only when NO v2 evidence is stored for it: neither
  // its claimed `peer_protocol_version` nor the `handshake_protocol_version`
  // a relay-federation@1.5 relay records at a completed confirm is 1.5 or
  // later. A relay without that column (this one runs 1.4) holds no v2
  // evidence, so every peer counts. (The CLI proposer sends no spec_version,
  // so a null claim is not evidence of v1.) Bucket: a recorded pre-1.5
  // version → `legitimate_legacy`; nothing recorded → `suspicious`.
  const handshakeCol =
    hasTable(db, "relay_peers") && hasColumn(db, "relay_peers", "handshake_protocol_version");
  const peers = hasTable(db, "relay_peers")
    ? (db
        .prepare(
          `SELECT peer_relay_id, state, peer_protocol_version, ${handshakeCol ? "handshake_protocol_version" : "NULL AS handshake_protocol_version"} FROM relay_peers WHERE state != 'removed' ORDER BY peer_relay_id`,
        )
        .all() as Array<{
        peer_relay_id: string;
        state: string;
        peer_protocol_version: string | null;
        handshake_protocol_version: string | null;
      }>)
    : [];
  const isV2 = (v: string | null): boolean => {
    const minor = federationMinor(v);
    return minor !== null && minor >= FEDERATION_V2_MIN_MINOR;
  };
  const v1Peers = peers.filter(
    (p) => !isV2(p.peer_protocol_version) && !isV2(p.handshake_protocol_version),
  );
  const byState: Record<string, number> = {};
  for (const p of v1Peers) byState[p.state] = (byState[p.state] ?? 0) + 1;

  return {
    measured_at: now,
    limit,
    q1_planted_device_rows: {
      count: q1.length,
      count_no_current_key: q1NoKey,
      buckets: tally(q1.map((r) => r.bucket)),
      rows: cap(q1),
    },
    q2_sovereign_squats: idList(q2, limit),
    q3_unbound_money_destinations: {
      settlement_address: listed(settlement),
      pay_to_address: listed(payTo),
      withdrawal_destination: listed(withdrawals),
    },
    q4_unproven_guardians: { identity_keys: idList(g1, limit), agent_registry: idList(g2, limit) },
    q5_keyless_with_device_rows: idList(q5, limit),
    q6_v1_peers: {
      ...idList(
        v1Peers.map((p) => ({
          id: p.peer_relay_id,
          bucket:
            federationMinor(p.peer_protocol_version) !== null ||
            federationMinor(p.handshake_protocol_version) !== null
              ? "legitimate_legacy"
              : "suspicious",
        })),
        limit,
      ),
      by_state: byState,
    },
  };
}
