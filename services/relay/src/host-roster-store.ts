/**
 * The relay's half of the machine roster.
 *
 * `docs/doctrine/machine-roster.md`, `spec/machine-roster-v1.md`. Two
 * categories are kept here and they never mix:
 *
 * **Membership** — `relay_host_roster_entries`. What the sovereign
 * signed, stored verbatim, keyed by the entry id the law defines. This
 * relay never mints, edits, reorders, expires or infers one. Ingest is an
 * idempotent union with NO freshness window: these are durable
 * artifacts, not requests, and a surface re-presenting the set after a
 * data loss will present entries that are months old. Refusing those is
 * how the offline machine vanishes — the defect this exists to fix.
 *
 * **Liveness** — `relay_host_liveness`. What this relay observed: ONE
 * overwritten `last_seen_at` per machine, never a history. It is served
 * beside the signed set, labelled as the relay's, so no consumer can
 * mistake an observation for the sovereign's statement.
 *
 * What the relay checks at ingest is INTEGRITY: an entry verifies under
 * the key it names. It does not ask whether that key is the motebit's —
 * its own notion of a motebit's keys is mutable rows that a data loss
 * erases, and a relay that refused entries under keys it no longer
 * remembers would refuse, forever, exactly the old-key lines a surface
 * re-presents after that loss. The routes are first-person, which is the
 * bound on who may write; whose key counts is the CONSUMER's question,
 * answered by `verifyHostRoster` against a chain the consumer verified.
 *
 * Where the relay itself needs to know whether a machine is retired — to
 * stop recording it, and to prune it — it asks the LAW, never a cruder
 * rule of its own. "Some held retirement names it" is not retirement: a
 * retirement under an older key names an enrolment without ending it.
 */
import type { DatabaseDriver } from "@motebit/persistence";
import { canonicalJson } from "@motebit/encryption";
import {
  verifyHostEnrollment,
  verifyHostRetirement,
  verifyHostRoster,
  hostEnrollmentId,
  hostRetirementId,
} from "@motebit/crypto";
import type { HostEnrollment, HostRetirement } from "@motebit/protocol";
import { HostEnrollmentSchema, HostRetirementSchema } from "@motebit/wire-schemas";

/** Entries one presentation may carry. A roster is a handful of machines. */
export const MAX_ROSTER_ENTRIES_PER_REQUEST = 64;
/**
 * Enrolments one motebit may hold here. Every write is first-person, so
 * this bounds a sovereign's own mistakes (a daemon minting per start),
 * not strangers.
 */
export const MAX_ENROLLMENTS_PER_MOTEBIT = 512;
/**
 * Retirements, counted APART from enrolments. Under one shared cap, a
 * roster filled by that very mistake refused the retirement of a stolen
 * machine — the one entry that must never be the one turned away.
 */
export const MAX_RETIREMENTS_PER_MOTEBIT = 2048;
/** How long a machine's liveness record outlives its retirement. */
export const HOST_LIVENESS_RETENTION_AFTER_RETIREMENT_MS = 30 * 24 * 60 * 60 * 1000;
/** The capability a connection announces when it hosts unattended work. */
export const HOSTS_UNATTENDED_WORK = "unattended_runtime";

export type RosterEntryKind = "enrollment" | "retirement";
export type RosterRefusalReason = "malformed" | "wrong_motebit" | "bad_signature" | "roster_full";

export interface RosterIngestResult {
  accepted: Array<{ kind: RosterEntryKind; id: string; status: "stored" | "already_held" }>;
  refused: Array<{ kind: RosterEntryKind; index: number; reason: RosterRefusalReason }>;
}

export async function ingestHostRoster(
  db: DatabaseDriver,
  motebitId: string,
  presented: { enrollments: readonly unknown[]; retirements: readonly unknown[] },
  now: number = Date.now(),
): Promise<RosterIngestResult> {
  const result: RosterIngestResult = { accepted: [], refused: [] };
  const insert = db.prepare(
    "INSERT OR IGNORE INTO relay_host_roster_entries (motebit_id, entry_id, kind, device_id, artifact_json, received_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const held = db.prepare(
    "SELECT 1 FROM relay_host_roster_entries WHERE motebit_id = ? AND entry_id = ?",
  );
  // Counted at the moment of each write, not once up front: verification
  // is awaited between entries, and concurrent presentations would all
  // work from the same stale number.
  const countOf = db.prepare(
    "SELECT COUNT(*) AS n FROM relay_host_roster_entries WHERE motebit_id = ? AND kind = ?",
  );

  const take = async <T extends HostEnrollment | HostRetirement>(
    kind: RosterEntryKind,
    cap: number,
    items: readonly unknown[],
    parse: (v: unknown) => T | null,
    verify: (v: T) => Promise<boolean>,
    idOf: (v: T) => Promise<string>,
    deviceOf: (v: T) => string | null,
  ): Promise<void> => {
    for (let index = 0; index < items.length; index++) {
      const artifact = parse(items[index]);
      const reason: RosterRefusalReason | null =
        artifact == null
          ? "malformed"
          : artifact.motebit_id !== motebitId
            ? "wrong_motebit"
            : !(await verify(artifact))
              ? "bad_signature"
              : null;
      if (artifact == null || reason != null) {
        result.refused.push({ kind, index, reason: reason ?? "malformed" });
        continue;
      }
      const id = await idOf(artifact);
      if (held.get(motebitId, id) != null) {
        result.accepted.push({ kind, id, status: "already_held" });
        continue;
      }
      if ((countOf.get(motebitId, kind) as { n: number }).n >= cap) {
        result.refused.push({ kind, index, reason: "roster_full" });
        continue;
      }
      // Canonical JSON, byte-stable: what is served back re-serialises to
      // the same signed body, so a consumer's verification does not
      // depend on anything this relay did to it.
      const written = insert.run(
        motebitId,
        id,
        kind,
        deviceOf(artifact),
        canonicalJson(artifact),
        now,
      );
      // Another presentation may have stored it between the look and the
      // write; say what actually happened.
      const stored = (written as { changes?: number } | undefined)?.changes !== 0;
      result.accepted.push({ kind, id, status: stored ? "stored" : "already_held" });
      if (stored) rosterStatusCache.delete(motebitId);
    }
  };

  await take(
    "enrollment",
    MAX_ENROLLMENTS_PER_MOTEBIT,
    presented.enrollments,
    (v) => {
      const p = HostEnrollmentSchema.safeParse(v);
      return p.success ? p.data : null;
    },
    // Called here by name, not passed by reference: that every inbound
    // signed artifact is VERIFIED before it is held is a property worth
    // being able to see at the call site (and one a gate checks for).
    (e) => verifyHostEnrollment(e),
    hostEnrollmentId,
    (e) => e.device_id,
  );
  await take(
    "retirement",
    MAX_RETIREMENTS_PER_MOTEBIT,
    presented.retirements,
    (v) => {
      const p = HostRetirementSchema.safeParse(v);
      return p.success ? p.data : null;
    },
    (r) => verifyHostRetirement(r),
    hostRetirementId,
    () => null,
  );
  return result;
}

export interface StoredHostRoster {
  enrollments: HostEnrollment[];
  retirements: HostRetirement[];
}

/** The set, as stored. Ordered by entry id — never by time: a set has no order to imply. */
export function readHostRoster(db: DatabaseDriver, motebitId: string): StoredHostRoster {
  const rows = db
    .prepare(
      "SELECT kind, artifact_json FROM relay_host_roster_entries WHERE motebit_id = ? ORDER BY entry_id",
    )
    .all(motebitId) as Array<{ kind: RosterEntryKind; artifact_json: string }>;
  const out: StoredHostRoster = { enrollments: [], retirements: [] };
  for (const row of rows) {
    if (row.kind === "enrollment") {
      out.enrollments.push(JSON.parse(row.artifact_json) as HostEnrollment);
    } else {
      out.retirements.push(JSON.parse(row.artifact_json) as HostRetirement);
    }
  }
  return out;
}

/**
 * The motebit's identity keys, oldest → newest, AS THIS RELAY KNOWS
 * THEM — for the relay's own housekeeping only, never served as truth.
 * `null` when it cannot tell, and every caller treats "cannot tell" as
 * "assume nothing is retired": keep recording, never prune.
 */
export function relayKeyChain(db: DatabaseDriver, motebitId: string): string[] | null {
  const links = db
    .prepare(
      "SELECT old_public_key, new_public_key FROM relay_key_successions WHERE motebit_id = ? ORDER BY timestamp ASC, id ASC",
    )
    .all(motebitId) as Array<{ old_public_key: string; new_public_key: string }>;
  if (links.length > 0) {
    const chain = [links[0]!.old_public_key.toLowerCase()];
    for (const link of links) {
      if (link.old_public_key.toLowerCase() !== chain[chain.length - 1]) return null; // not linear
      chain.push(link.new_public_key.toLowerCase());
    }
    return chain;
  }
  const registry = db
    .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
    .get(motebitId) as { public_key: string | null } | undefined;
  if (registry?.public_key != null && registry.public_key !== "") {
    return [registry.public_key.toLowerCase()];
  }
  // No registry row and no rotation on record: if every keyed device
  // agrees on ONE key, that is the identity key. If they disagree, a
  // device linked without key transfer is among them and this relay
  // cannot say which key is the motebit's.
  const keys = new Set(
    (
      db
        .prepare("SELECT public_key FROM devices WHERE motebit_id = ? AND public_key != ''")
        .all(motebitId) as Array<{ public_key: string }>
    ).map((d) => d.public_key.toLowerCase()),
  );
  return keys.size === 1 ? [...keys] : null;
}

interface RosterStatus {
  /** device_id → the signer keys it is enrolled under, in any state. */
  enrolled: Map<string, Set<string>>;
  /** Devices the LAW reduces to `retired`; empty when the law cannot be applied. */
  retired: Set<string>;
}

/**
 * What the relay's housekeeping needs to know about a roster, computed
 * by the law and remembered until that roster next changes (`ingest`
 * evicts it). Closing a socket must not cost a roster's worth of
 * signature checks.
 */
const rosterStatusCache = new Map<string, Promise<RosterStatus>>();

export function rosterStatus(db: DatabaseDriver, motebitId: string): Promise<RosterStatus> {
  let cached = rosterStatusCache.get(motebitId);
  if (cached == null) {
    cached = (async (): Promise<RosterStatus> => {
      const roster = readHostRoster(db, motebitId);
      const enrolled = new Map<string, Set<string>>();
      for (const e of roster.enrollments) {
        const keys = enrolled.get(e.device_id) ?? new Set<string>();
        keys.add(e.public_key);
        enrolled.set(e.device_id, keys);
      }
      const chain = relayKeyChain(db, motebitId);
      const verdict =
        chain == null ? null : await verifyHostRoster({ motebitId, keyChain: chain, ...roster });
      return {
        enrolled,
        retired: new Set(verdict?.ok === true ? verdict.retired.map((m) => m.device_id) : []),
      };
    })();
    rosterStatusCache.set(motebitId, cached);
    // A failed computation must not be remembered as an answer.
    cached.catch(() => rosterStatusCache.delete(motebitId));
  }
  return cached;
}

/** For tests that build several relays in one process. */
export function resetRosterStatusCache(): void {
  rosterStatusCache.clear();
}

export interface ObservedPeer {
  deviceId: string;
  deviceIdVerified?: boolean;
  capabilities?: readonly string[];
}

/**
 * Is this connection BOUND to a roster line? The one predicate — used to
 * light a line in the response AND to decide whether a connection may be
 * recorded, so the two cannot disagree about the same socket.
 *
 * Bound means all of: it announces that it hosts unattended work (a
 * plain CLI session on the same machine is not the host, and must not
 * overwrite what the host last announced); its signed token PROVED the
 * device id (a query string binds nothing); that device is enrolled; and
 * the device's registered key is one the line was enrolled under (a
 * device linked without key transfer holds a key that signed no
 * enrolment, and after a rotation a machine that has not re-enrolled is
 * not yet the line's).
 */
export function isBoundToRosterLine(
  db: DatabaseDriver,
  motebitId: string,
  peer: ObservedPeer,
  status: RosterStatus,
): boolean {
  if (peer.capabilities?.includes(HOSTS_UNATTENDED_WORK) !== true) return false;
  if (peer.deviceIdVerified !== true) return false;
  const signerKeys = status.enrolled.get(peer.deviceId);
  if (signerKeys == null) return false;
  const device = db
    .prepare("SELECT public_key FROM devices WHERE device_id = ? AND motebit_id = ?")
    .get(peer.deviceId, motebitId) as { public_key: string | null } | undefined;
  return device?.public_key != null && signerKeys.has(device.public_key.toLowerCase());
}

/**
 * The one persisted observation: when this relay last saw a machine, and
 * what it last announced. OVERWRITTEN, never appended — "not seen since"
 * has to survive a deploy, and an activity log is not what this is.
 */
export function recordHostLastSeen(
  db: DatabaseDriver,
  motebitId: string,
  deviceId: string,
  lastAnnounced: readonly string[],
  at: number = Date.now(),
): void {
  db.prepare(
    `INSERT INTO relay_host_liveness (motebit_id, device_id, last_seen_at, last_announced)
     VALUES (?, ?, ?, ?)
     ON CONFLICT (motebit_id, device_id)
     DO UPDATE SET last_seen_at = excluded.last_seen_at, last_announced = excluded.last_announced`,
  ).run(motebitId, deviceId, at, JSON.stringify([...lastAnnounced]));
}

/**
 * Observe one connection — the ONLY door to the liveness record, shared
 * by the socket's close hook, the periodic flush and the shutdown flush.
 *
 * Records nothing unless the connection is BOUND to a roster line
 * (`isBoundToRosterLine`) and the law does not reduce that machine to
 * retired. The transparency declaration promises the relay keeps nothing
 * about an unenrolled device, and deletes a machine's record 30 days
 * after its retirement; a retired machine that stays connected must not
 * have that record written back every five minutes. Its connection is
 * still REPORTED, live, as `socket_open` — "retired, but connected" — it
 * is just not remembered. Returns whether a record was written.
 */
export async function observeHostConnection(
  db: DatabaseDriver,
  motebitId: string,
  peer: ObservedPeer,
  at: number = Date.now(),
): Promise<boolean> {
  const status = await rosterStatus(db, motebitId);
  if (!isBoundToRosterLine(db, motebitId, peer, status)) return false;
  if (status.retired.has(peer.deviceId)) return false;
  recordHostLastSeen(db, motebitId, peer.deviceId, peer.capabilities ?? [], at);
  return true;
}

export function readHostLiveness(
  db: DatabaseDriver,
  motebitId: string,
): Map<string, { last_seen_at: number; last_announced: string[] }> {
  const rows = db
    .prepare(
      "SELECT device_id, last_seen_at, last_announced FROM relay_host_liveness WHERE motebit_id = ?",
    )
    .all(motebitId) as Array<{ device_id: string; last_seen_at: number; last_announced: string }>;
  return new Map(
    rows.map((r) => [
      r.device_id,
      { last_seen_at: r.last_seen_at, last_announced: JSON.parse(r.last_announced) as string[] },
    ]),
  );
}

/**
 * Delete a machine's liveness record once the LAW has reduced it to
 * retired for longer than the window.
 *
 * Retired by the law, not by "some held retirement names its enrolment":
 * a retirement signed under an older key names an enrolment without
 * ending it, and honouring it here let a stolen old key have an ACTIVE
 * machine's last-seen value deleted — the one thing the declaration says
 * never happens. Where the relay cannot apply the law it prunes nothing.
 *
 * The clock is when the relay RECEIVED the latest retirement naming the
 * machine's enrolments, never a self-asserted `retired_at`. Returns the
 * number of records deleted.
 */
export async function pruneHostLiveness(
  db: DatabaseDriver,
  now: number = Date.now(),
): Promise<number> {
  const cutoff = now - HOST_LIVENESS_RETENTION_AFTER_RETIREMENT_MS;
  const rows = db
    .prepare("SELECT motebit_id, device_id FROM relay_host_liveness ORDER BY motebit_id")
    .all() as Array<{ motebit_id: string; device_id: string }>;
  const del = db.prepare("DELETE FROM relay_host_liveness WHERE motebit_id = ? AND device_id = ?");
  let deleted = 0;
  for (const motebitId of new Set(rows.map((r) => r.motebit_id))) {
    const status = await rosterStatus(db, motebitId);
    if (status.retired.size === 0) continue;
    // Once per motebit: which enrolment each retirement names, and when
    // the relay received it.
    const endedAt = new Map<string, number>();
    for (const r of db
      .prepare(
        "SELECT artifact_json, received_at FROM relay_host_roster_entries WHERE motebit_id = ? AND kind = 'retirement'",
      )
      .all(motebitId) as Array<{ artifact_json: string; received_at: number }>) {
      const target = (JSON.parse(r.artifact_json) as HostRetirement).enrollment_id;
      endedAt.set(target, Math.max(endedAt.get(target) ?? 0, r.received_at));
    }
    const enrolmentIds = db.prepare(
      "SELECT entry_id FROM relay_host_roster_entries WHERE motebit_id = ? AND kind = 'enrollment' AND device_id = ?",
    );
    for (const row of rows) {
      if (row.motebit_id !== motebitId || !status.retired.has(row.device_id)) continue;
      let retiredSince = 0;
      for (const e of enrolmentIds.all(motebitId, row.device_id) as Array<{ entry_id: string }>) {
        retiredSince = Math.max(retiredSince, endedAt.get(e.entry_id) ?? 0);
      }
      if (retiredSince > 0 && retiredSince <= cutoff) {
        del.run(motebitId, row.device_id);
        deleted++;
      }
    }
  }
  return deleted;
}
