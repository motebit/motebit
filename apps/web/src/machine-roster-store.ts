/**
 * The browser's machine-roster storage — `docs/proposals/machine-roster-surfaces-v1.md`
 * S3, §1A F3/F4, §1B R3. Its own IndexedDB database, `motebit-roster`:
 *
 *   - `replicas`     — one replica per motebit_id (F4): a pairing or restore
 *                      to another identity never inherits, or destroys, the
 *                      previous identity's.
 *   - `aside`        — unreadable values, kept with their bytes (R3), never
 *                      overwritten.
 *   - `presentation` — the last presentation the relay fully took, and any
 *                      Retry-After (F8).
 *
 * `saveReplica` is ONE readwrite transaction: get → set aside if corrupt →
 * `mergeReplicas` → put. The merge is synchronous, so IndexedDB's
 * transaction serialization makes it atomic across tabs without a lock
 * (F3): two tabs saving at once never lose each other's retirement. Web
 * Locks guard only the kit's `exclusive` (the mint decision).
 */
import {
  mergeReplicas,
  parseReplica,
  type MachineRosterReplica,
  type PresentationRecord,
  type ReplicaRead,
} from "@motebit/surface-kit";

export const ROSTER_DB_NAME = "motebit-roster";
const REPLICAS = "replicas";
const ASIDE = "aside";
const PRESENTATION = "presentation";

/** How long an open may wait (another tab blocking an upgrade, a wedged IDB) before it gives up. */
export const ROSTER_DB_OPEN_TIMEOUT_MS = 5_000;

/**
 * Open the roster database. Never hangs: a `blocked` open (another tab
 * holding an older version) or one that does not settle within the timeout
 * rejects, and every caller proceeds without the roster — a rotation, a
 * refresh or a pairing is never held hostage by it.
 */
export function openRosterDb(
  factory: IDBFactory = indexedDB,
  timeoutMs: number = ROSTER_DB_OPEN_TIMEOUT_MS,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err: Error | null, db?: IDBDatabase): void => {
      if (settled) {
        // Opened after we gave up: close it, nobody holds it.
        db?.close();
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(db!);
    };
    const timer = setTimeout(
      () => finish(new Error("the roster database did not open in time")),
      timeoutMs,
    );
    const req = factory.open(ROSTER_DB_NAME, 1);
    req.onblocked = () =>
      finish(new Error("the roster database is blocked by another tab; the roster is skipped"));
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of [REPLICAS, PRESENTATION]) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name);
      }
      if (!db.objectStoreNames.contains(ASIDE)) {
        db.createObjectStore(ASIDE, { autoIncrement: true });
      }
    };
    req.onsuccess = () => finish(null, req.result);
    req.onerror = () => finish(req.error ?? new Error("the roster database could not be opened"));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error("the roster transaction was aborted"));
    tx.onerror = () => reject(tx.error ?? new Error("the roster transaction failed"));
  });
}

/** An aside entry: the unreadable value, byte-for-byte, and when it was moved. */
export interface AsideEntry {
  motebit_id: string;
  store: string;
  at: number;
  raw: unknown;
}

const readable = (raw: unknown, motebitId: string): MachineRosterReplica | null => {
  const r = parseReplica(raw);
  return r != null && r.motebit_id === motebitId ? r : null;
};

/**
 * Three-way read (absent / value / corrupt). An unreadable value is moved
 * aside in the same transaction that finds it — re-checked there, so a
 * value another tab just repaired is never moved — and the name is freed.
 */
export async function loadReplica(db: IDBDatabase, motebitId: string): Promise<ReplicaRead> {
  const tx = db.transaction([REPLICAS, ASIDE], "readwrite");
  const replicas = tx.objectStore(REPLICAS);
  let out: ReplicaRead = { kind: "absent" };
  const req = replicas.get(motebitId);
  req.onsuccess = () => {
    const raw: unknown = req.result;
    if (raw === undefined) return;
    const r = readable(raw, motebitId);
    if (r != null) {
      out = { kind: "value", replica: r };
      return;
    }
    const entry: AsideEntry = { motebit_id: motebitId, store: REPLICAS, at: Date.now(), raw };
    tx.objectStore(ASIDE).add(entry);
    replicas.delete(motebitId);
    out = { kind: "corrupt" };
  };
  await done(tx);
  return out;
}

/** Merge `replica` into what is stored NOW, in one transaction; nothing is ever removed (F3, R3). */
export async function saveReplica(db: IDBDatabase, replica: MachineRosterReplica): Promise<void> {
  const id = replica.motebit_id;
  const tx = db.transaction([REPLICAS, ASIDE], "readwrite");
  const replicas = tx.objectStore(REPLICAS);
  const req = replicas.get(id);
  req.onsuccess = () => {
    const raw: unknown = req.result;
    let base: MachineRosterReplica | null = null;
    if (raw !== undefined) {
      base = readable(raw, id);
      // R3 — kept aside BEFORE the write, inside the same transaction.
      if (base == null) {
        const entry: AsideEntry = { motebit_id: id, store: REPLICAS, at: Date.now(), raw };
        tx.objectStore(ASIDE).add(entry);
      }
    }
    replicas.put(base != null ? mergeReplicas(base, replica) : replica, id);
  };
  await done(tx);
}

/** Every aside entry (a diagnostic read; nothing ever deletes them). */
export async function listAside(db: IDBDatabase): Promise<AsideEntry[]> {
  const tx = db.transaction(ASIDE, "readonly");
  const req = tx.objectStore(ASIDE).getAll();
  await done(tx);
  return req.result as AsideEntry[];
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
  db: IDBDatabase,
  motebitId: string,
): Promise<PresentationRecord | null> {
  const tx = db.transaction(PRESENTATION, "readonly");
  const req = tx.objectStore(PRESENTATION).get(motebitId);
  await done(tx);
  return isRecord(req.result) ? req.result : null;
}

export async function putPresentationRecord(
  db: IDBDatabase,
  motebitId: string,
  record: PresentationRecord,
): Promise<void> {
  const tx = db.transaction(PRESENTATION, "readwrite");
  tx.objectStore(PRESENTATION).put(record, motebitId);
  await done(tx);
}
