/**
 * The machine-roster REPLICA a key-holding surface keeps
 * (`docs/proposals/machine-roster-clients-v1.md` C5, R22, R26, R27).
 *
 * What it holds, and why each part is load-bearing:
 *
 *   - `succession` — every succession record this surface has seen VERIFIED,
 *     including the evidence a refusal carried (R26). The cache is records,
 *     never a key list: a key list carries no signature, so it could only be
 *     trusted (storage as authority) or ignored. After a relay loses its
 *     database, these records alone resolve the same chain, and a
 *     `held_key_superseded` stays in force across a relay switch.
 *   - `enrollments` / `retirements` — entries this surface verified against
 *     its accepted chain before holding them (verify-before-hold, spec §9).
 *   - `frozen` — the pre-rotation verdict (C3, R13, R21, R22), keyed by
 *     `(device_id, pre_rotation_key)`. Only a frozen `active` mints on a
 *     superseded line; first write wins, so a later computation (which an
 *     old-key holder could have influenced) never replaces it.
 *   - `roster_full` — ids a relay refused `roster_full`: permanent, reported
 *     once, never retried, and excluded from set-pinning (C5, R20).
 *   - `own_device_ids` — device ids this surface minted for ITSELF, so a
 *     restore that gives a fresh `device_id` can offer to retire the prior
 *     line (§2A N12).
 *   - `ambiguous` — `(device_id, key)` pairs seen with `sockets_open > 1` at
 *     the last read, stamped with that read's time; the hint needs two
 *     successive reads (C6.8, R19).
 *
 * Saving never removes anything: every set is a union (`mergeReplicas`).
 */
import { canonicalJson } from "@motebit/encryption";
import { isHostEnrollment, isHostRetirement } from "@motebit/sdk";
import type { HostEnrollment, HostRetirement, KeySuccessionRecord } from "@motebit/sdk";

/** The three states a pre-rotation verdict is persisted as (R13). */
export type FrozenValue = "absent" | "active" | "not-active";

export interface FrozenVerdict {
  device_id: string;
  /** The key of the epoch the chain extended past — the pre-rotation head (R22). */
  pre_rotation_key: string;
  value: FrozenValue;
  taken_at: number;
}

export interface MachineRosterReplica {
  version: 1;
  motebit_id: string;
  succession: KeySuccessionRecord[];
  enrollments: HostEnrollment[];
  retirements: HostRetirement[];
  frozen: FrozenVerdict[];
  roster_full: string[];
  own_device_ids: string[];
  /** The last read's pairs with `sockets_open > 1`; `at` = 0 means no read yet. */
  ambiguous: { at: number; pairs: string[] };
}

/** A cache read: `corrupt` is never `absent` (the three-way read, key-file-durability R1). */
export type ReplicaRead =
  { kind: "absent" } | { kind: "value"; replica: MachineRosterReplica } | { kind: "corrupt" };

export function emptyReplica(motebitId: string): MachineRosterReplica {
  return {
    version: 1,
    motebit_id: motebitId,
    succession: [],
    enrollments: [],
    retirements: [],
    frozen: [],
    roster_full: [],
    own_device_ids: [],
    ambiguous: { at: 0, pairs: [] },
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");

const isRecordShape = (v: unknown): v is KeySuccessionRecord => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.old_public_key === "string" &&
    typeof r.new_public_key === "string" &&
    typeof r.new_key_signature === "string"
  );
};

const isFrozen = (v: unknown): v is FrozenVerdict => {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return (
    typeof f.device_id === "string" &&
    typeof f.pre_rotation_key === "string" &&
    (f.value === "absent" || f.value === "active" || f.value === "not-active") &&
    typeof f.taken_at === "number"
  );
};

/**
 * Parse a stored replica, or `null` when it is not one. Strict: a stored
 * value that does not have exactly this shape is CORRUPT to the caller —
 * never read as a smaller replica, which would drop what it held.
 */
export function parseReplica(raw: unknown): MachineRosterReplica | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || typeof r.motebit_id !== "string" || r.motebit_id === "") return null;
  if (!Array.isArray(r.succession) || !r.succession.every(isRecordShape)) return null;
  if (!Array.isArray(r.enrollments) || !r.enrollments.every((e) => isHostEnrollment(e))) {
    return null;
  }
  if (!Array.isArray(r.retirements) || !r.retirements.every((e) => isHostRetirement(e))) {
    return null;
  }
  if (!Array.isArray(r.frozen) || !r.frozen.every(isFrozen)) return null;
  if (!isStringArray(r.roster_full) || !isStringArray(r.own_device_ids)) return null;
  const amb = r.ambiguous;
  if (!isObj(amb) || typeof amb.at !== "number" || !isStringArray(amb.pairs)) return null;
  return {
    version: 1,
    motebit_id: r.motebit_id,
    succession: r.succession,
    enrollments: r.enrollments,
    retirements: r.retirements,
    frozen: r.frozen,
    roster_full: r.roster_full,
    own_device_ids: r.own_device_ids,
    ambiguous: { at: amb.at, pairs: amb.pairs },
  };
}

function unionBy<T>(a: readonly T[], b: readonly T[], key: (v: T) => string): T[] {
  const out = new Map<string, T>();
  for (const v of a) if (!out.has(key(v))) out.set(key(v), v);
  for (const v of b) if (!out.has(key(v))) out.set(key(v), v);
  return [...out.values()];
}

const frozenKey = (f: FrozenVerdict): string => JSON.stringify([f.device_id, f.pre_rotation_key]);

/**
 * Union of two replicas of ONE motebit — what an adapter writes under its
 * lock so two processes (`run` beside `serve`) never lose each other's
 * entries. Every set is a union keyed by its exact canonical bytes; a
 * frozen verdict keeps the value already `stored` (first write wins, R22);
 * `ambiguous` is the later read's.
 */
export function mergeReplicas(
  stored: MachineRosterReplica,
  incoming: MachineRosterReplica,
): MachineRosterReplica {
  if (stored.motebit_id !== incoming.motebit_id) {
    throw new Error("refusing to merge the machine-roster replicas of two different motebits");
  }
  return {
    version: 1,
    motebit_id: stored.motebit_id,
    succession: unionBy(stored.succession, incoming.succession, canonicalJson),
    enrollments: unionBy(stored.enrollments, incoming.enrollments, canonicalJson),
    retirements: unionBy(stored.retirements, incoming.retirements, canonicalJson),
    frozen: unionBy(stored.frozen, incoming.frozen, frozenKey),
    roster_full: unionBy(stored.roster_full, incoming.roster_full, (s) => s),
    own_device_ids: unionBy(stored.own_device_ids, incoming.own_device_ids, (s) => s),
    ambiguous: incoming.ambiguous.at >= stored.ambiguous.at ? incoming.ambiguous : stored.ambiguous,
  };
}

/** The frozen value for `(device_id, key)`, or `null` when none was ever taken (R22). */
export function frozenFor(
  replica: MachineRosterReplica,
  deviceId: string,
  preRotationKey: string,
): FrozenValue | null {
  const hit = replica.frozen.find(
    (f) => f.device_id === deviceId && f.pre_rotation_key === preRotationKey,
  );
  return hit?.value ?? null;
}
