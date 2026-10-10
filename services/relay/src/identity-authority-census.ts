/**
 * Identity-authority census — the operator's read-only measure of authority
 * state that may have been written by a party that never proved the
 * identity's current key (docs/design/identity-authority-writers.md §6,
 * Inc 1). Production allows no direct database read, so the queries ship
 * inside the relay and are served on the master-token
 * `GET /api/v1/admin/identity-authority/census`
 * (`scripts/measure-identity-authority.ts` fetches it).
 *
 * Read-only by construction: every statement here is a SELECT, and the route
 * answers counts, ids, device ids, timestamps and booleans — never a key, a
 * token, an address or a signature.
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
import { deriveSovereignMotebitId } from "@motebit/crypto";
import { hexToBytes } from "@motebit/encryption";
import type { DatabaseDriver } from "@motebit/persistence";
import { deriveSolanaAddress } from "@motebit/wallet-solana";

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

type Basis = "sovereign_lineage" | "holder_evidence" | "none";

interface CurrentKey {
  key: string | null;
  basis: Basis;
  /** Every key on the lineage from K₀ (sovereign ids only), lowercased. */
  lineage: ReadonlySet<string>;
}

interface Listed<T> {
  count: number;
  rows: T[];
}

export interface IdentityAuthorityCensus {
  measured_at: number;
  limit: number;
  /** Q1 — device rows whose key is not the identity's current key. */
  q1_planted_device_rows: {
    count: number;
    /** Of `count`, rows of identities with no current key at all. */
    count_no_current_key: number;
    rows: Array<{
      motebit_id: string;
      device_id: string;
      registered_at: number;
      current_key_basis: Basis;
      matches_holder: boolean;
      id_commits_to_device_key: boolean;
    }>;
  };
  /** Q2 — sovereign ids whose held keys are off the genesis lineage. */
  q2_sovereign_squats: { count: number; ids: string[] };
  /** Q3 — money destinations not derived from the current key. */
  q3_unbound_money_destinations: {
    settlement_address: Listed<MoneyRow>;
    pay_to_address: Listed<MoneyRow>;
    withdrawal_destination: Listed<MoneyRow & { source: string }>;
  };
  /** Q4 — guardians recorded with no provenance (all of them, before 875's v60). */
  q4_unproven_guardians: {
    identity_keys: { count: number; ids: string[] };
    agent_registry: { count: number; ids: string[] };
  };
  /** Q5 — keyless ids carrying a keyed device row (register-self's first-come residual). */
  q5_keyless_with_device_rows: { count: number; ids: string[] };
  /** Q6 — peers recorded under a federation protocol older than the v2 kinds. */
  q6_v1_peers: { count: number; by_state: Record<string, number>; ids: string[] };
}

interface MoneyRow {
  motebit_id: string;
  reason: "no_current_key" | "not_derived_from_current_key";
  /** The identity's virtual-account balance (micro-units), the ranking key. */
  balance_micro: number;
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

/** The derived Solana address of a key, or null when the key is not a 32-byte hex key. */
function derivedAddress(key: string | null): string | null {
  if (key == null || !isHex32(key)) return null;
  try {
    return deriveSolanaAddress(hexToBytes(key));
  } catch {
    return null;
  }
}

/** Resolves and caches each identity's current key (§3.2, as this branch can answer it). */
class CurrentKeys {
  private readonly cache = new Map<string, CurrentKey>();
  private readonly commits = new Map<string, Promise<string>>();

  constructor(private readonly db: DatabaseDriver) {}

  /** True iff `id` is the sovereign commitment of `key`. */
  async commitsTo(id: string, key: string): Promise<boolean> {
    if (!isHex32(key)) return false;
    const k = key.toLowerCase();
    let p = this.commits.get(k);
    if (p === undefined) {
      p = deriveSovereignMotebitId(k);
      this.commits.set(k, p);
    }
    return (await p) === id.toLowerCase();
  }

  holder(id: string): { key: string | null; source: string | null } {
    const row = this.db
      .prepare("SELECT public_key, source FROM identity_keys WHERE motebit_id = ?")
      .get(id) as { public_key: string; source: string } | undefined;
    return { key: lower(row?.public_key), source: row?.source ?? null };
  }

  registryKey(id: string): string | null {
    const row = this.db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(id) as { public_key: string } | undefined;
    return lower(row?.public_key);
  }

  /** Every key this relay holds for `id`, anywhere. */
  private knownKeys(id: string): string[] {
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
    for (const r of this.db
      .prepare(
        "SELECT old_public_key, new_public_key FROM relay_key_successions WHERE motebit_id = ?",
      )
      .all(id) as Array<{ old_public_key: string; new_public_key: string }>) {
      add(r.old_public_key);
      add(r.new_public_key);
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
    if (k0 !== null) {
      const links = this.db
        .prepare(
          "SELECT old_public_key, new_public_key FROM relay_key_successions WHERE motebit_id = ? ORDER BY id",
        )
        .all(id) as Array<{ old_public_key: string; new_public_key: string }>;
      const lineage = new Set<string>([k0]);
      let head = k0;
      for (const l of links) {
        if (lower(l.old_public_key) === head) {
          head = lower(l.new_public_key) ?? head;
          lineage.add(head);
        }
      }
      result = { key: head, basis: "sovereign_lineage", lineage };
    } else {
      const h = this.holder(id);
      result =
        h.key !== null && h.source !== null && LEGACY_EVIDENCE_SOURCES.has(h.source)
          ? { key: h.key, basis: "holder_evidence", lineage: new Set() }
          : { key: null, basis: "none", lineage: new Set() };
    }
    this.cache.set(id, result);
    return result;
  }

  /** True iff `id` claims to be sovereign: some key it holds commits to it. */
  async claimsSovereign(id: string): Promise<boolean> {
    return (await this.of(id)).basis === "sovereign_lineage";
  }
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
 * Run Q1–Q6 over `db`. Pure read: SELECTs only. `limit` caps every list
 * (clamped to 1..CENSUS_MAX_LIMIT); counts are whole.
 */
export async function measureIdentityAuthority(
  db: DatabaseDriver,
  opts: { limit?: number; now?: number } = {},
): Promise<IdentityAuthorityCensus> {
  const now = opts.now ?? Date.now();
  const limit = Math.min(
    CENSUS_MAX_LIMIT,
    Math.max(1, Math.floor(opts.limit ?? CENSUS_DEFAULT_LIMIT)),
  );
  const keys = new CurrentKeys(db);
  const accounts = hasTable(db, "relay_accounts");
  const cap = <T>(xs: T[]): T[] => xs.slice(0, limit);

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
    const proven = cur.basis === "sovereign_lineage" ? cur.lineage.has(k) : cur.key === k;
    if (proven) continue;
    if (cur.basis === "none") q1NoKey++;
    q1.push({
      motebit_id: d.motebit_id,
      device_id: d.device_id,
      registered_at: d.registered_at,
      current_key_basis: cur.basis,
      matches_holder: keys.holder(d.motebit_id).key === k,
      id_commits_to_device_key: await keys.commitsTo(d.motebit_id, k),
    });
  }

  // ── Q2 ── a sovereign-shaped id (a held key commits to it, or the id is a
  // v8 UUID) whose holder / registry key is off the genesis lineage.
  const ids = (
    db
      .prepare(
        "SELECT motebit_id FROM identity_keys UNION SELECT motebit_id FROM agent_registry ORDER BY 1",
      )
      .all() as Array<{ motebit_id: string }>
  ).map((r) => r.motebit_id);
  const q2: string[] = [];
  for (const id of ids) {
    const v8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id);
    const cur = await keys.of(id);
    if (!v8 && cur.basis !== "sovereign_lineage") continue;
    const held = [keys.holder(id).key, keys.registryKey(id)].filter((k): k is string => k !== null);
    if (held.length === 0) continue;
    if (held.some((k) => !cur.lineage.has(k))) q2.push(id);
  }

  // ── Q3 ──
  const moneyRow = async (id: string, value: string): Promise<MoneyRow | null> => {
    const cur = await keys.of(id);
    if (cur.key === null)
      return {
        motebit_id: id,
        reason: "no_current_key",
        balance_micro: balanceOf(db, id, accounts),
      };
    if (derivedAddress(cur.key) === value) return null;
    return {
      motebit_id: id,
      reason: "not_derived_from_current_key",
      balance_micro: balanceOf(db, id, accounts),
    };
  };
  const rank = <T extends MoneyRow>(xs: T[]): T[] =>
    xs.sort(
      (a, b) => b.balance_micro - a.balance_micro || a.motebit_id.localeCompare(b.motebit_id),
    );

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

  // ── Q4 ──
  const guardianIds = (sql: string): string[] =>
    (db.prepare(sql).all() as Array<{ motebit_id: string }>).map((r) => r.motebit_id);
  const g1 = guardianIds(
    "SELECT motebit_id FROM identity_keys WHERE guardian_public_key IS NOT NULL AND guardian_public_key != '' ORDER BY 1",
  );
  const g2 = guardianIds(
    "SELECT motebit_id FROM agent_registry WHERE guardian_public_key IS NOT NULL AND guardian_public_key != '' ORDER BY 1",
  );

  // ── Q5 ──
  const q5 = (
    db
      .prepare(
        `SELECT DISTINCT d.motebit_id FROM devices d
          WHERE d.public_key IS NOT NULL AND d.public_key != ''
            AND NOT EXISTS (SELECT 1 FROM identity_keys k WHERE k.motebit_id = d.motebit_id)
            AND NOT EXISTS (SELECT 1 FROM agent_registry r
                             WHERE r.motebit_id = d.motebit_id AND r.public_key IS NOT NULL AND r.public_key != '')
          ORDER BY 1`,
      )
      .all() as Array<{ motebit_id: string }>
  ).map((r) => r.motebit_id);

  // ── Q6 ──
  const peers = hasTable(db, "relay_peers")
    ? (db
        .prepare(
          "SELECT peer_relay_id, state, peer_protocol_version FROM relay_peers WHERE state != 'removed' ORDER BY peer_relay_id",
        )
        .all() as Array<{
        peer_relay_id: string;
        state: string;
        peer_protocol_version: string | null;
      }>)
    : [];
  const v1Peers = peers.filter((p) => {
    const minor = federationMinor(p.peer_protocol_version);
    return minor === null || minor < FEDERATION_V2_MIN_MINOR;
  });
  const byState: Record<string, number> = {};
  for (const p of v1Peers) byState[p.state] = (byState[p.state] ?? 0) + 1;

  return {
    measured_at: now,
    limit,
    q1_planted_device_rows: { count: q1.length, count_no_current_key: q1NoKey, rows: cap(q1) },
    q2_sovereign_squats: { count: q2.length, ids: cap(q2) },
    q3_unbound_money_destinations: {
      settlement_address: { count: settlement.length, rows: cap(rank(settlement)) },
      pay_to_address: { count: payTo.length, rows: cap(rank(payTo)) },
      withdrawal_destination: { count: withdrawals.length, rows: cap(rank(withdrawals)) },
    },
    q4_unproven_guardians: {
      identity_keys: { count: g1.length, ids: cap(g1) },
      agent_registry: { count: g2.length, ids: cap(g2) },
    },
    q5_keyless_with_device_rows: { count: q5.length, ids: cap(q5) },
    q6_v1_peers: {
      count: v1Peers.length,
      by_state: byState,
      ids: cap(v1Peers.map((p) => p.peer_relay_id)),
    },
  };
}
