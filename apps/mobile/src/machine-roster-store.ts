/**
 * The phone's machine-roster storage — `docs/proposals/machine-roster-surfaces-v1.md`
 * S3, §1A F3/F4, §1B R3. AsyncStorage, ONE key per motebit_id
 * (`machineRosterKey`): a pairing or restore to another identity never
 * inherits, or destroys, the previous identity's replica, and one corrupt
 * value cannot take every replica with it.
 *
 * The phone is one JS process, so the locks are in-process promise chains:
 *
 *   - the SAVE chain (per motebit) serializes get → set aside if corrupt →
 *     `mergeReplicas` → set. AsyncStorage has no transaction, so without it
 *     two saves interleave get/get/set/set and the second loses the first's
 *     retirement (F3). A load that finds a corrupt value moves it aside on
 *     the same chain, so it can never race a save.
 *   - the EXCLUSIVE chain (per motebit) is the kit's `exclusive` — the mint
 *     decision. It is a different chain on purpose: the kit saves while
 *     holding `exclusive`, so one chain for both would deadlock.
 *
 * A corrupt value is copied to `<key>.corrupt-<t>` BEFORE the name is
 * freed or written, and nothing ever deletes an aside key (R3).
 */
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  mergeReplicas,
  parseReplica,
  type MachineRosterReplica,
  type PresentationRecord,
  type ReplicaRead,
} from "@motebit/surface-kit";
import {
  machineRosterAsideKey,
  machineRosterKey,
  machineRosterPresentationKey,
} from "./storage-keys";

/** The slice of AsyncStorage the roster uses (injectable for tests). */
export interface RosterKV {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const defaultRosterKV: RosterKV = {
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
  removeItem: (k) => AsyncStorage.removeItem(k),
};

/** One in-process promise chain per name: `run` waits for every earlier holder. */
class Chains {
  private tails = new Map<string, Promise<unknown>>();
  run<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(name) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(name, tail);
    void tail.then(() => {
      if (this.tails.get(name) === tail) this.tails.delete(name);
    });
    return next;
  }
}

// Module-level: every roster instance and the rotation commit's step share
// them, so a save from Settings and a save from a rotation still serialize.
const saveChains = new Chains();
const exclusiveChains = new Chains();

/** The kit's `exclusive` for this motebit (the mint decision). */
export function rosterExclusive<T>(motebitId: string, fn: () => Promise<T>): Promise<T> {
  return exclusiveChains.run(motebitId, fn);
}

const readable = (raw: string, motebitId: string): MachineRosterReplica | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const r = parseReplica(parsed);
  return r != null && r.motebit_id === motebitId ? r : null;
};

/** R3 — copy the unreadable bytes aside; throws (and nothing is written) if the copy fails. */
async function keepAside(
  kv: RosterKV,
  motebitId: string,
  raw: string,
  now: () => number,
): Promise<void> {
  await kv.setItem(machineRosterAsideKey(motebitId, now()), raw);
}

/**
 * Three-way read (absent / value / corrupt). An unreadable value is moved
 * aside — on the save chain, re-read there so a value a save just repaired
 * is never moved — and the name is freed.
 */
export async function loadReplica(
  motebitId: string,
  kv: RosterKV = defaultRosterKV,
  now: () => number = Date.now,
): Promise<ReplicaRead> {
  const key = machineRosterKey(motebitId);
  const raw = await kv.getItem(key);
  if (raw == null) return { kind: "absent" };
  const r = readable(raw, motebitId);
  if (r != null) return { kind: "value", replica: r };
  return saveChains.run(motebitId, async (): Promise<ReplicaRead> => {
    const again = await kv.getItem(key);
    if (again == null) return { kind: "absent" };
    const fixed = readable(again, motebitId);
    if (fixed != null) return { kind: "value", replica: fixed };
    await keepAside(kv, motebitId, again, now);
    await kv.removeItem(key);
    return { kind: "corrupt" };
  });
}

/** Merge `replica` into what is stored NOW, on the save chain; nothing is ever removed (F3, R3). */
export function saveReplica(
  replica: MachineRosterReplica,
  kv: RosterKV = defaultRosterKV,
  now: () => number = Date.now,
): Promise<void> {
  const id = replica.motebit_id;
  const key = machineRosterKey(id);
  return saveChains.run(id, async () => {
    const raw = await kv.getItem(key);
    let base: MachineRosterReplica | null = null;
    if (raw != null) {
      base = readable(raw, id);
      // R3 — kept aside BEFORE the write.
      if (base == null) await keepAside(kv, id, raw, now);
    }
    const next = base != null ? mergeReplicas(base, replica) : replica;
    await kv.setItem(key, JSON.stringify(next));
  });
}

// ── Presentation cadence (F8) ────────────────────────────────────────

const isRecord = (v: unknown): v is PresentationRecord => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    (r.digest === null || typeof r.digest === "string") &&
    typeof r.taken_at === "number" &&
    typeof r.retry_until === "number"
  );
};

export async function loadPresentationRecord(
  motebitId: string,
  kv: RosterKV = defaultRosterKV,
): Promise<PresentationRecord | null> {
  const raw = await kv.getItem(machineRosterPresentationKey(motebitId));
  if (raw == null) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

export async function putPresentationRecord(
  motebitId: string,
  record: PresentationRecord,
  kv: RosterKV = defaultRosterKV,
): Promise<void> {
  await kv.setItem(machineRosterPresentationKey(motebitId), JSON.stringify(record));
}
