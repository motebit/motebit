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
 * Verification here is defence in depth, not the trust root. The keys
 * this relay associates with a motebit are mutable rows; a consumer
 * re-verifies against keys IT trusts (`verifyHostRoster`).
 */
import type { DatabaseDriver } from "@motebit/persistence";
import { canonicalJson } from "@motebit/encryption";
import {
  verifyHostEnrollment,
  verifyHostRetirement,
  hostEnrollmentId,
  hostRetirementId,
} from "@motebit/crypto";
import type { HostEnrollment, HostRetirement } from "@motebit/protocol";
import { HostEnrollmentSchema, HostRetirementSchema } from "@motebit/wire-schemas";

/** Entries one presentation may carry. A roster is a handful of machines. */
export const MAX_ROSTER_ENTRIES_PER_REQUEST = 64;
/**
 * Entries one motebit may hold here. Every one is signed by the
 * sovereign's own key, so this is a bound on a key-holder's mistakes (a
 * daemon minting per start), not on strangers.
 */
export const MAX_ROSTER_ENTRIES_PER_MOTEBIT = 512;
/** How long a machine's liveness record outlives its retirement. */
export const HOST_LIVENESS_RETENTION_AFTER_RETIREMENT_MS = 30 * 24 * 60 * 60 * 1000;

export type RosterEntryKind = "enrollment" | "retirement";
export type RosterRefusalReason =
  "malformed" | "wrong_motebit" | "untrusted_key" | "bad_signature" | "roster_full";

export interface RosterIngestResult {
  accepted: Array<{ kind: RosterEntryKind; id: string; status: "stored" | "already_held" }>;
  refused: Array<{ kind: RosterEntryKind; index: number; reason: RosterRefusalReason }>;
}

/**
 * Every key this relay has ever associated with the motebit: its
 * registry key, its device keys, and both sides of every succession
 * record. Superseded keys are INCLUDED — after a rotation the old-key
 * lines are how a consumer sees the machine that was cut off, and a
 * relay that refused to hold them would be where they are lost.
 */
export function knownKeysFor(db: DatabaseDriver, motebitId: string): Set<string> {
  const keys = new Set<string>();
  const add = (k: string | null | undefined): void => {
    if (k != null && k !== "") keys.add(k.toLowerCase());
  };
  add(
    (
      db.prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?").get(motebitId) as
        { public_key: string | null } | undefined
    )?.public_key,
  );
  for (const d of db
    .prepare("SELECT public_key FROM devices WHERE motebit_id = ?")
    .all(motebitId) as Array<{ public_key: string | null }>) {
    add(d.public_key);
  }
  for (const s of db
    .prepare(
      "SELECT old_public_key, new_public_key FROM relay_key_successions WHERE motebit_id = ?",
    )
    .all(motebitId) as Array<{ old_public_key: string; new_public_key: string }>) {
    add(s.old_public_key);
    add(s.new_public_key);
  }
  return keys;
}

export async function ingestHostRoster(
  db: DatabaseDriver,
  motebitId: string,
  presented: { enrollments: readonly unknown[]; retirements: readonly unknown[] },
  now: number = Date.now(),
): Promise<RosterIngestResult> {
  const result: RosterIngestResult = { accepted: [], refused: [] };
  const known = knownKeysFor(db, motebitId);
  const held = db.prepare(
    "SELECT 1 FROM relay_host_roster_entries WHERE motebit_id = ? AND entry_id = ?",
  );
  const insert = db.prepare(
    "INSERT OR IGNORE INTO relay_host_roster_entries (motebit_id, entry_id, kind, device_id, artifact_json, received_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  let count = (
    db
      .prepare("SELECT COUNT(*) AS n FROM relay_host_roster_entries WHERE motebit_id = ?")
      .get(motebitId) as { n: number }
  ).n;

  const take = async <T extends HostEnrollment | HostRetirement>(
    kind: RosterEntryKind,
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
            : !known.has(artifact.public_key)
              ? "untrusted_key"
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
      if (count >= MAX_ROSTER_ENTRIES_PER_MOTEBIT) {
        result.refused.push({ kind, index, reason: "roster_full" });
        continue;
      }
      // Canonical JSON, byte-stable: what is served back re-serialises to
      // the same signed body, so a consumer's verification does not
      // depend on anything this relay did to it.
      insert.run(motebitId, id, kind, deviceOf(artifact), canonicalJson(artifact), now);
      count++;
      result.accepted.push({ kind, id, status: "stored" });
    }
  };

  await take(
    "enrollment",
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
    if (row.kind === "enrollment")
      out.enrollments.push(JSON.parse(row.artifact_json) as HostEnrollment);
    else out.retirements.push(JSON.parse(row.artifact_json) as HostRetirement);
  }
  return out;
}

/** Is this machine on the stored roster at all (in any state)? */
export function isEnrolledDevice(db: DatabaseDriver, motebitId: string, deviceId: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM relay_host_roster_entries WHERE motebit_id = ? AND kind = 'enrollment' AND device_id = ? LIMIT 1",
      )
      .get(motebitId, deviceId) != null
  );
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
 * by the socket's close hook and the periodic flush, so the two cannot
 * come to disagree about what may be recorded.
 *
 * Records nothing unless the socket's signed token PROVED its device id
 * and that machine is on the motebit's roster. The transparency
 * declaration promises the relay keeps nothing about when an unenrolled
 * device came and went; this function is where that promise is kept.
 * Returns whether a record was written.
 */
export function observeHostConnection(
  db: DatabaseDriver,
  motebitId: string,
  peer: { deviceId: string; deviceIdVerified?: boolean; capabilities?: readonly string[] },
  at: number = Date.now(),
): boolean {
  if (peer.deviceIdVerified !== true) return false;
  if (!isEnrolledDevice(db, motebitId, peer.deviceId)) return false;
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
 * Delete a machine's liveness record once EVERY enrolment this relay
 * holds for it has been retired for longer than the window.
 *
 * Keyed on when the relay RECEIVED the retirement, never on the
 * self-asserted `retired_at`. An active machine's record is never pruned
 * by age: silence is not an exit, and "not seen for a year" is exactly
 * what the line is for. Returns the number of records deleted.
 */
export function pruneHostLiveness(db: DatabaseDriver, now: number = Date.now()): number {
  const cutoff = now - HOST_LIVENESS_RETENTION_AFTER_RETIREMENT_MS;
  const candidates = db
    .prepare("SELECT motebit_id, device_id FROM relay_host_liveness")
    .all() as Array<{ motebit_id: string; device_id: string }>;
  const enrolments = db.prepare(
    "SELECT entry_id FROM relay_host_roster_entries WHERE motebit_id = ? AND kind = 'enrollment' AND device_id = ?",
  );
  const retirements = db.prepare(
    "SELECT artifact_json, received_at FROM relay_host_roster_entries WHERE motebit_id = ? AND kind = 'retirement'",
  );
  const del = db.prepare("DELETE FROM relay_host_liveness WHERE motebit_id = ? AND device_id = ?");
  let deleted = 0;
  for (const c of candidates) {
    const ids = (enrolments.all(c.motebit_id, c.device_id) as Array<{ entry_id: string }>).map(
      (r) => r.entry_id,
    );
    if (ids.length === 0) continue;
    const endedAt = new Map<string, number>();
    for (const r of retirements.all(c.motebit_id) as Array<{
      artifact_json: string;
      received_at: number;
    }>) {
      const target = (JSON.parse(r.artifact_json) as HostRetirement).enrollment_id;
      endedAt.set(target, Math.min(endedAt.get(target) ?? Infinity, r.received_at));
    }
    const allLongEnded = ids.every((id) => (endedAt.get(id) ?? Infinity) <= cutoff);
    if (allLongEnded) {
      del.run(c.motebit_id, c.device_id);
      deleted++;
    }
  }
  return deleted;
}
