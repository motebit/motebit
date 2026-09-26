/**
 * The machine roster in the browser — the web adapter for surface-kit's
 * `MachineRoster` and its Settings section (`docs/proposals/machine-roster-surfaces-v1.md`
 * C-2a, with §1A and §1B taking precedence over §1).
 *
 * A browser tab is never a host (S2): it reads, keeps, retires and enrols
 * OTHER machines, and never enrols itself. So there is no enrol-on-announce,
 * no rotation capture and no rotation re-enrolment here — the rotation
 * commit only appends its link to the replica (F7). There is no local
 * custody record (#797): only a rooted chain, a refusal naming the held
 * key, or a legacy relay naming it make this browser's key the identity's.
 *
 * Ports:
 *   - `signer()` — the key in the encrypted keystore; the roster routes'
 *     bearer is a `device:auth` token minted over the SAME bytes (the
 *     primitive `createSyncToken` uses), never the operator's master token.
 *   - the replica — `machine-roster-store.ts` (IndexedDB, one transaction
 *     per merge-save, per motebit_id).
 *   - `exclusive` — the Web Locks API, which excludes across tabs. Without
 *     it the write actions are refused and reading still works (S3).
 *   - presentation — only the tab holding `motebit-roster-present` presents
 *     and repairs omissions (R2); cadence and Retry-After per F8.
 */
import {
  MachineRoster,
  createMachineRosterSection,
  createRosterSigner,
  nextPresentationRecord,
  presentationDue,
  replicaDigest,
  rotationLinkReplica,
  type MachineRosterPorts,
  type MachineRosterSection,
  type PresentationRecord,
  type RosterFetch,
} from "@motebit/surface-kit";
import { hexToBytes, mintAudienceToken } from "@motebit/encryption";
import type { KeySuccessionRecord } from "@motebit/sdk";
import {
  loadPresentationRecord,
  loadReplica,
  openRosterDb,
  putPresentationRecord,
  saveReplica,
} from "./machine-roster-store.js";

/** The presentation leader lock (§1B R2): held for the tab's life. */
export const PRESENT_LOCK = "motebit-roster-present";
/** F8 — with nothing changed, present at most this often. */
export const PRESENT_EVERY_MS = 10 * 60_000;
export const NO_LOCKS = "this browser can't lock the roster across tabs";

/** The slice of the Web Locks API the adapter uses. */
export interface RosterLocks {
  request<T>(name: string, options: { mode: "exclusive" }, fn: () => Promise<T>): Promise<T>;
}

export interface WebRosterDeps {
  motebitId: string;
  deviceId: string;
  loadPrivateKeyHex: () => Promise<string | null>;
  syncUrl: () => string | null;
  /** Keys of this motebit's devices from the local devices store (C6.3). */
  listDeviceKeys?: () => Promise<string[]>;
  db?: () => Promise<IDBDatabase>;
  /** `navigator.locks`, or null/undefined when the browser has none. */
  locks?: RosterLocks | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

let sharedDb: Promise<IDBDatabase> | null = null;
const defaultDb = (): Promise<IDBDatabase> => {
  sharedDb ??= openRosterDb().catch((err: unknown) => {
    sharedDb = null;
    throw err;
  });
  return sharedDb;
};

async function readJson(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date; absent/unparseable ⇒ undefined. */
export function retryAfterMs(header: string | null, now: number): number | undefined {
  if (header == null || header.trim() === "") return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - now) : undefined;
}

export function webRosterPorts(deps: WebRosterDeps): MachineRosterPorts {
  const db = deps.db ?? defaultDb;
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? Date.now;
  const agentUrl = (): string | null => {
    const base = deps.syncUrl();
    if (base == null || base === "") return null;
    return `${base.replace(/\/+$/, "")}/api/v1/agents/${encodeURIComponent(deps.motebitId)}`;
  };
  const get = async (path: string, headers?: Record<string, string>): Promise<RosterFetch> => {
    const agent = agentUrl();
    if (agent == null) return { ok: false, reason: "no relay is configured" };
    try {
      const resp = await fetchImpl(`${agent}${path}`, {
        ...(headers ? { headers } : {}),
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) return { ok: false, reason: `${path.slice(1)} route answered ${resp.status}` };
      return { ok: true, body: await readJson(resp) };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };
  return {
    motebitId: deps.motebitId,
    deviceId: deps.deviceId,
    signer: async () => {
      const hex = await deps.loadPrivateKeyHex();
      if (hex == null || hex === "") return null;
      const privateKey = hexToBytes(hex);
      return createRosterSigner({
        privateKey,
        // A device token under THIS key — never the master token.
        authorization: async () => {
          const { token } = await mintAudienceToken(
            { mid: deps.motebitId, did: deps.deviceId, aud: "device:auth" },
            privateKey,
          );
          return { Authorization: `Bearer ${token}` };
        },
      });
    },
    fetchSuccession: async () => {
      const got = await get("/succession");
      if (!got.ok) return got;
      const body = got.body;
      // Not the succession shape: a failed read, never an empty chain.
      if (
        typeof body !== "object" ||
        body === null ||
        Array.isArray(body) ||
        !Array.isArray((body as { chain?: unknown }).chain)
      ) {
        return { ok: false, reason: "the succession route's answer was not a key chain" };
      }
      return got;
    },
    fetchRoster: async (signer) => get("/roster", await signer.authorization()),
    presentRoster: async (signer, body) => {
      const agent = agentUrl();
      if (agent == null) return { status: null, reason: "no relay is configured" };
      try {
        const resp = await fetchImpl(`${agent}/roster`, {
          method: "POST",
          headers: { ...(await signer.authorization()), "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        const wait =
          resp.status === 429 ? retryAfterMs(resp.headers.get("Retry-After"), now()) : undefined;
        return {
          status: resp.status,
          body: await readJson(resp),
          ...(wait !== undefined ? { retryAfterMs: wait } : {}),
        };
      } catch (err) {
        return { status: null, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    // The browser keeps no identity file: its record sources are the
    // replica and the relay (and the link its own rotations append, F7).
    localSuccession: () => Promise.resolve([]),
    pinnedGuardian: () => Promise.resolve(null),
    cache: {
      load: async () => loadReplica(await db(), deps.motebitId),
      save: async (replica) => saveReplica(await db(), replica),
      exclusive: <T>(fn: () => Promise<T>): Promise<T> =>
        deps.locks == null
          ? Promise.reject(new Error(NO_LOCKS))
          : deps.locks.request(`motebit-roster-mint:${deps.motebitId}`, { mode: "exclusive" }, fn),
    },
    ...(deps.listDeviceKeys ? { knownDeviceKeys: deps.listDeviceKeys } : {}),
    now,
  };
}

export interface WebMachineRoster {
  section: MachineRosterSection;
  /** This tab holds the presentation lock. */
  isPresenter(): boolean;
  /** Release the presentation lock (the tab is going away). */
  dispose(): void;
}

/** The roster, its presentation leader lock, and the Settings section, for one motebit. */
export function createWebMachineRoster(deps: WebRosterDeps): WebMachineRoster {
  const db = deps.db ?? defaultDb;
  const now = deps.now ?? Date.now;
  let presenter = false;
  const held: { release: (() => void) | null } = { release: null };
  let disposed = false;
  if (deps.locks != null) {
    // Held until the tab dies (or dispose): the browser releases it then,
    // and the next waiting tab becomes the presenter.
    void deps.locks
      .request(PRESENT_LOCK, { mode: "exclusive" }, () => {
        if (disposed) return Promise.resolve();
        presenter = true;
        return new Promise<void>((resolve) => {
          held.release = resolve;
        });
      })
      .catch(() => {
        presenter = false;
      });
  }
  const isPresenter = (): boolean => presenter;
  // The last Retry-After this tab has seen (F8): an omission repair is a
  // presentation, so it waits too.
  let retryUntil = 0;
  const remember = (record: PresentationRecord | null): PresentationRecord | null => {
    if (record != null) retryUntil = Math.max(retryUntil, record.retry_until);
    return record;
  };
  // #799 F1 — the stored Retry-After (this tab's or another's) is read
  // BEFORE the replica, on every load. Every acquisition (and every act)
  // loads the replica before it repairs or presents, so a Retry-After
  // stored earlier holds the first presentation too — never only after `due`.
  const ports = webRosterPorts(deps);
  const load = ports.cache.load.bind(ports.cache);
  ports.cache.load = async () => {
    remember(
      await db()
        .then((d) => loadPresentationRecord(d, deps.motebitId))
        .catch(() => null),
    );
    return load();
  };
  const roster = MachineRoster.gated(ports, {
    selfIsHost: false,
    // R2 — only the presenting tab repairs an omission, and not while the
    // relay has asked it to wait.
    repairOmissions: () => presenter && now() >= retryUntil,
    // F8 — an act's own presentation waits out a pending Retry-After too:
    // its entry is kept in the replica and presented again later.
    presentationHeld: () => now() < retryUntil,
  });
  const section = createMachineRosterSection(roster, {
    deviceId: deps.deviceId,
    now,
    refuseOwnEnroll: true,
    writeBlocked: () => (deps.locks == null ? NO_LOCKS : null),
    presentation: {
      isPresenter,
      due: async (replica) =>
        presentationDue(
          remember(await loadPresentationRecord(await db(), deps.motebitId)),
          await replicaDigest(replica),
          now(),
          PRESENT_EVERY_MS,
        ),
      record: async (report, replica) => {
        const d = await db();
        const next = await nextPresentationRecord(
          await loadPresentationRecord(d, deps.motebitId),
          report,
          replica,
          now(),
        );
        if (next != null) await putPresentationRecord(d, deps.motebitId, remember(next)!);
      },
    },
  });
  return {
    section,
    isPresenter,
    dispose: () => {
      disposed = true;
      presenter = false;
      const release = held.release;
      held.release = null;
      release?.();
    },
  };
}

/**
 * The rotation commit's roster step (F7): append the committed link to the
 * replica. Idempotent (a commit re-run finishes it); no capture, no mint
 * (S2). Best-effort: the key is already committed, so a failure here — an
 * IndexedDB that will not open, which `openRosterDb` bounds — must not fail
 * the rotation; the relay's served chain still carries the link.
 */
export async function rosterAfterRotationCommit(opts: {
  motebitId: string;
  record: KeySuccessionRecord;
  db?: () => Promise<IDBDatabase>;
}): Promise<void> {
  try {
    await saveReplica(
      await (opts.db ?? defaultDb)(),
      rotationLinkReplica(opts.motebitId, opts.record),
    );
  } catch {
    // See above.
  }
}
