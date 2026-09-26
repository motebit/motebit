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
 *   - `localSuccession()` / `pinnedGuardian()` — the stored motebit.md, only
 *     when its signature verifies and it names THIS motebit (§1A route 1:
 *     identity files are a record source, never evidence on their own).
 *   - the replica — `machine-roster-store.ts` (AsyncStorage, one key per
 *     motebit, merge-save on its own in-process chain).
 *   - `exclusive` — a separate in-process chain (one JS process).
 *   - presentation — the phone is always the presenting surface; cadence and
 *     Retry-After per F8, as on web.
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

const HEX_32 = /^[0-9a-f]{64}$/;

/**
 * Succession records and the guardian from the stored identity file — only
 * when it verifies and names THIS motebit (a file left behind by another
 * identity contributes nothing).
 */
export async function identityFileEvidence(
  motebitId: string,
  content: string | null,
): Promise<{ records: KeySuccessionRecord[]; guardian: string | null }> {
  const none = { records: [], guardian: null };
  if (content == null || content === "") return none;
  try {
    const v = await verifyIdentityFile(content, { expectedType: "identity" });
    if (v.type !== "identity" || !v.valid || !v.identity) return none;
    if (v.identity.motebit_id !== motebitId) return none;
    const g = v.identity.guardian?.public_key;
    return {
      records: v.identity.succession ?? [],
      guardian: typeof g === "string" && HEX_32.test(g) ? g : null,
    };
  } catch {
    return none;
  }
}

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
  // One read of the identity file per acquisition (both ports ask).
  let evidence: Promise<{ records: KeySuccessionRecord[]; guardian: string | null }> | null = null;
  const local = () => {
    const p = (evidence ??= deps
      .loadIdentityFile()
      .catch(() => null)
      .then((c) => identityFileEvidence(deps.motebitId, c)));
    // Re-read next time: a rotation re-signs the file.
    void p.finally(() => {
      if (evidence === p) evidence = null;
    });
    return p;
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
    localSuccession: async () => (await local()).records,
    pinnedGuardian: async () => (await local()).guardian,
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
    if (record != null) retryUntil = Math.max(retryUntil, record.retry_until);
    return record;
  };
  const roster = MachineRoster.gated(mobileRosterPorts(deps), {
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
