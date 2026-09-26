/**
 * The machine roster on the phone — the mobile adapter for surface-kit's
 * `MachineRoster` and its Settings section (`docs/proposals/machine-roster-surfaces-v1.md`
 * C-2b, with §1B then §1A taking precedence over §1; reference: the web
 * adapter, `apps/web/src/machine-roster.ts`).
 *
 * A phone is never a host (S2) and never a machine (F6): it reads, keeps,
 * retires and enrols OTHER machines, and never enrols itself. So there is
 * no enrol-on-announce, no rotation capture and no rotation re-enrolment
 * here — the rotation commit only appends its link to the replica (F7).
 * Whether the held key is the identity key is decided by the kit after
 * resolution (`MachineRoster.gated`); no local record makes it so (#797).
 *
 * Ports:
 *   - `signer()` — the key in SecureStore (`device_private_key`); the
 *     roster routes' bearer is a `device:auth` token minted over the SAME
 *     bytes, never the operator's master token.
 *   - `localSuccession()` — the succession records of the stored motebit.md,
 *     only when it verifies, names THIS motebit AND its current key is the
 *     key this phone holds. A file proves possession, not identity (§1A F2):
 *     a file signed by any other key contributes nothing. The records are
 *     self-verifying; they are evidence for the resolver, never a class.
 *   - `pinnedGuardian()` — always null. Nothing on the phone ever writes a
 *     guardian from a trusted source, and a guardian read from a
 *     self-signed file would let that file's author sign a recovery onto
 *     any key (#799 W1). R6's stated cost applies: guardian-recovered
 *     identities stay unconfirmed here.
 *   - the replica — `machine-roster-store.ts` (AsyncStorage, one key per
 *     motebit, merge-save on its own in-process chain).
 *   - `exclusive` — a separate in-process chain (one JS process).
 *   - presentation — the phone is always the presenting surface; cadence and
 *     Retry-After per F8, as on web.
 */
import {
  MachineRoster,
  boundedRetryUntil,
  createMachineRosterSection,
  createRosterSigner,
  identityFileRecords as kitIdentityFileRecords,
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
import { verify as verifyIdentityFile } from "@motebit/identity-file";
import type { KeySuccessionRecord } from "@motebit/sdk";
import {
  defaultRosterKV,
  loadPresentationRecord,
  loadReplica,
  putPresentationRecord,
  rosterExclusive,
  saveReplica,
  type RosterKV,
} from "./machine-roster-store";

/** F8 — with nothing changed, present at most this often. */
export const PRESENT_EVERY_MS = 10 * 60_000;
export const DISPOSED = "this roster belongs to an identity this device no longer holds";

export interface MobileRosterDeps {
  motebitId: string;
  deviceId: string;
  /** The SecureStore `device_private_key` slot. */
  loadPrivateKeyHex: () => Promise<string | null>;
  syncUrl: () => Promise<string | null>;
  /** The stored motebit.md (AsyncStorage `@motebit/identity_file`), if any. */
  loadIdentityFile: () => Promise<string | null>;
  kv?: RosterKV;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

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

/**
 * Succession records from the stored identity file — only when it verifies,
 * names THIS motebit, and its current key IS the held key. A file signed by
 * any other key (left behind by another identity, or planted) contributes
 * nothing. Never a guardian (#799 W1).
 * The rule lives once in surface-kit (#800).
 */
export const identityFileRecords = (
  motebitId: string,
  content: string | null,
  heldPublicKeyHex: string | null,
): Promise<KeySuccessionRecord[]> =>
  kitIdentityFileRecords(motebitId, content, heldPublicKeyHex, verifyIdentityFile);

export function mobileRosterPorts(deps: MobileRosterDeps): MachineRosterPorts {
  const kv = deps.kv ?? defaultRosterKV;
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? Date.now;
  const agentUrl = async (): Promise<string | null> => {
    const base = await deps.syncUrl();
    if (base == null || base === "") return null;
    return `${base.replace(/\/+$/, "")}/api/v1/agents/${encodeURIComponent(deps.motebitId)}`;
  };
  const get = async (path: string, headers?: Record<string, string>): Promise<RosterFetch> => {
    const agent = await agentUrl();
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
  /** The public key of the key this phone holds now, or null. */
  const heldPublicKey = async (): Promise<string | null> => {
    const hex = await deps.loadPrivateKeyHex();
    if (hex == null || hex === "") return null;
    const s = await createRosterSigner({
      privateKey: hexToBytes(hex),
      authorization: () => Promise.resolve({}),
    });
    return s.publicKeyHex;
  };
  return {
    motebitId: deps.motebitId,
    deviceId: deps.deviceId,
    signer: async () => {
      const hex = await deps.loadPrivateKeyHex();
      if (hex == null || hex === "") return null;
      // The signer owns these bytes for its life (the kit signs with them
      // across an acquisition and an act); it has no release hook, so they
      // are not erased here — they are never persisted or logged.
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
      const agent = await agentUrl();
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
    localSuccession: async () => {
      const [content, held] = await Promise.all([
        deps.loadIdentityFile().catch(() => null),
        heldPublicKey().catch(() => null),
      ]);
      return identityFileRecords(deps.motebitId, content, held);
    },
    // Never a local pin on the phone (#799 W1; R6 stated cost).
    pinnedGuardian: () => Promise.resolve(null),
    cache: {
      load: () => loadReplica(deps.motebitId, kv, now),
      save: (replica) => saveReplica(replica, kv, now),
      exclusive: <T>(fn: () => Promise<T>): Promise<T> => rosterExclusive(deps.motebitId, fn),
    },
    // No local devices list on the phone (§1A F1): knownDeviceKeys omitted.
    now,
  };
}

export interface MobileMachineRoster {
  motebitId: string;
  deviceId: string;
  section: MachineRosterSection;
  /** The identity changed or the app stopped: nothing more is presented from this one. */
  dispose(): void;
}

/** The roster and its Settings section, for one motebit on this phone. */
export function createMobileMachineRoster(deps: MobileRosterDeps): MobileMachineRoster {
  const kv = deps.kv ?? defaultRosterKV;
  const now = deps.now ?? Date.now;
  let disposed = false;
  // The phone is one JS process: it is the presenting surface while it is
  // live, and a disposed roster (identity switch, stop) presents nothing.
  const isPresenter = (): boolean => !disposed;
  // The last Retry-After seen (F8): an omission repair is a presentation, so it waits too.
  let retryUntil = 0;
  const remember = (record: PresentationRecord | null): PresentationRecord | null => {
    // #801 F1 — bounded on read: a stored or planted far-future value never freezes presenting.
    retryUntil = Math.max(retryUntil, boundedRetryUntil(record, now()));
    return record;
  };
  // #799 F1 — the stored Retry-After is read BEFORE the replica, on every
  // load. Every acquisition (and every act) loads the replica before it
  // repairs or presents, so a Retry-After a previous run stored holds the
  // first presentation after a restart too — never only after `due`.
  const ports = mobileRosterPorts(deps);
  const load = ports.cache.load.bind(ports.cache);
  ports.cache.load = async () => {
    remember(await loadPresentationRecord(deps.motebitId, kv).catch(() => null));
    return load();
  };
  const roster = MachineRoster.gated(ports, {
    selfIsHost: false,
    repairOmissions: () => isPresenter() && now() >= retryUntil,
    presentationHeld: () => now() < retryUntil,
  });
  const section = createMachineRosterSection(roster, {
    deviceId: deps.deviceId,
    now,
    // S2 — "this device is not a host".
    refuseOwnEnroll: true,
    // A roster left over from an identity this phone no longer holds signs nothing.
    writeBlocked: () => (disposed ? DISPOSED : null),
    presentation: {
      isPresenter,
      due: async (replica) =>
        presentationDue(
          remember(await loadPresentationRecord(deps.motebitId, kv)),
          await replicaDigest(replica),
          now(),
          PRESENT_EVERY_MS,
        ),
      record: async (report, replica) => {
        const next = await nextPresentationRecord(
          await loadPresentationRecord(deps.motebitId, kv),
          report,
          replica,
          now(),
        );
        if (next != null) await putPresentationRecord(deps.motebitId, remember(next)!, kv);
      },
    },
  });
  return {
    motebitId: deps.motebitId,
    deviceId: deps.deviceId,
    section,
    dispose: () => {
      disposed = true;
    },
  };
}

/**
 * The rotation commit's roster step (F7): append the committed link to the
 * replica. Idempotent (a commit re-run finishes it); no capture, no mint
 * (S2). Best-effort: the key is already committed, so a failure here must
 * not fail the rotation; the relay's served chain still carries the link.
 */
export async function rosterAfterRotationCommit(opts: {
  motebitId: string;
  record: KeySuccessionRecord;
  kv?: RosterKV;
}): Promise<void> {
  try {
    await saveReplica(rotationLinkReplica(opts.motebitId, opts.record), opts.kv);
  } catch {
    // See above.
  }
}
