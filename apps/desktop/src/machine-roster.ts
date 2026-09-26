/**
 * The machine roster on the desktop — the desktop adapter for surface-kit's
 * `MachineRoster` and its Settings section (`docs/proposals/machine-roster-surfaces-v1.md`
 * C-2c, with §1B then §1A taking precedence over §1; references: the web
 * adapter and the phone's, `apps/{web,mobile}/src/machine-roster.ts`).
 *
 * The desktop is never a host (S2; it announces `Background`, never
 * `unattended_runtime`): no enrol-on-announce, no rotation capture, no
 * rotation re-enrolment — the rotation commit only appends its link (F7).
 * But it shares its machine, and so its `device_id`, with a CLI host (F5),
 * so `enroll(own id)` stays available through the kit's R17 refusals
 * (`selfIsHost: false`) and records no own mint. Whether the held key is
 * the identity key is decided by the kit after resolution
 * (`MachineRoster.gated`); no local record makes it so (#797).
 *
 * Ports:
 *   - `signer()` — `device_private_key` from the desktop's OWN key store
 *     (`~/.motebit/dev-keyring.json`, via `keyring_get`). The roster routes'
 *     bearer is a `device:auth` token minted over the SAME bytes — never the
 *     operator master token the Sovereign adapter holds (the routes 403 it).
 *   - `localSuccession()` — the succession records of the config's
 *     `_identity_file`, only when it verifies, names THIS motebit AND its
 *     current key is the key this desktop holds. A file proves possession,
 *     not identity (§1A F2); any other file contributes nothing.
 *   - `pinnedGuardian()` — always null (#799 W1): a guardian read from a
 *     self-signed local file would let that file's author sign a recovery
 *     onto any key. R6's stated cost: guardian-recovered identities stay
 *     unconfirmed here.
 *   - `storedPublicKeyHex()` / `rotationInFlight()` — from the desktop's own
 *     key store (the key it holds; its `pending_rotation`), never from the
 *     shared `config.json` or the CLI's write-ahead (F5a).
 *   - the replica — `machine-roster-store.ts`: one desktop-owned file, a
 *     compare-and-swap under a Rust file lock + in-process mutex (F3).
 *   - `exclusive` — a Rust-held lease with an owner token and a timeout (R4).
 *   - presentation — cadence and Retry-After per F8, seeded from the STORED
 *     record before every entry point, so a fresh process never presents
 *     (or repairs) inside a Retry-After an earlier one was given.
 */
import {
  MachineRoster,
  boundedRetryUntil,
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
  loadPresentationRecord,
  loadReplica,
  putPresentationRecord,
  saveReplica,
  tauriRosterIO,
  withRosterLease,
  type InvokeFn,
  type RosterFileIO,
} from "./machine-roster-store";

/** F8 — with nothing changed, present at most this often. */
export const PRESENT_EVERY_MS = 10 * 60_000;
export const DISPOSED = "this roster belongs to an identity this device no longer holds";

export interface DesktopRosterDeps {
  motebitId: string;
  deviceId: string;
  /** Tauri `invoke`: `keyring_get` (dev-keyring.json) and `read_config`. */
  invoke: InvokeFn;
  /** Keys of this motebit's devices from the local devices store (C6.3). */
  listDeviceKeys?: () => Promise<string[]>;
  io?: RosterFileIO;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** False once the roster is disposed: nothing reads the key slot after that. */
  live?: () => boolean;
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
 * names THIS motebit, and its current key IS the held key. Never a guardian.
 */
export async function identityFileRecords(
  motebitId: string,
  content: string | null,
  heldPublicKeyHex: string | null,
): Promise<KeySuccessionRecord[]> {
  if (content == null || content === "" || heldPublicKeyHex == null) return [];
  try {
    const v = await verifyIdentityFile(content, { expectedType: "identity" });
    if (v.type !== "identity" || !v.valid || !v.identity) return [];
    if (v.identity.motebit_id !== motebitId) return [];
    if (v.identity.identity.public_key.toLowerCase() !== heldPublicKeyHex.toLowerCase()) return [];
    return v.identity.succession ?? [];
  } catch {
    return [];
  }
}

export function desktopRosterPorts(deps: DesktopRosterDeps): MachineRosterPorts {
  const io = deps.io ?? tauriRosterIO(deps.invoke);
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const now = deps.now ?? Date.now;
  const live = deps.live ?? (() => true);
  const config = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await deps.invoke<string>("read_config")) as Record<string, unknown>;
  /** The held key's bytes — from the desktop's own key store, never while disposed. */
  const heldKeyHex = async (): Promise<string | null> => {
    if (!live()) return null;
    const hex = await deps.invoke<string | null>("keyring_get", { key: "device_private_key" });
    return hex == null || hex === "" ? null : hex;
  };
  const heldPublicKey = async (): Promise<string | null> => {
    const hex = await heldKeyHex();
    if (hex == null) return null;
    const s = await createRosterSigner({
      privateKey: hexToBytes(hex),
      authorization: () => Promise.resolve({}),
    });
    return s.publicKeyHex;
  };
  const agentUrl = async (): Promise<string | null> => {
    const base = (await config())["sync_url"];
    if (typeof base !== "string" || base === "") return null;
    return `${base.replace(/\/+$/, "")}/api/v1/agents/${encodeURIComponent(deps.motebitId)}`;
  };
  const get = async (path: string, headers?: Record<string, string>): Promise<RosterFetch> => {
    try {
      const agent = await agentUrl();
      if (agent == null) return { ok: false, reason: "no relay is configured" };
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
      const hex = await heldKeyHex();
      if (hex == null) return null;
      // The signer owns these bytes for its life (the kit signs with them
      // across an acquisition and an act); never persisted or logged.
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
      try {
        const agent = await agentUrl();
        if (agent == null) return { status: null, reason: "no relay is configured" };
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
      const [cfg, held] = await Promise.all([
        config().catch((): Record<string, unknown> => ({})),
        heldPublicKey().catch(() => null),
      ]);
      const file = cfg["_identity_file"];
      return identityFileRecords(deps.motebitId, typeof file === "string" ? file : null, held);
    },
    // Never a local pin (#799 W1; R6 stated cost).
    pinnedGuardian: () => Promise.resolve(null),
    cache: {
      load: () => loadReplica(io, deps.motebitId),
      save: (replica) => saveReplica(io, replica),
      exclusive: <T>(fn: () => Promise<T>): Promise<T> => withRosterLease(io, fn),
    },
    // F5a — the desktop's own key store; never config.json or the CLI's files.
    rotationInFlight: async () => {
      try {
        const held = await deps.invoke<string | null>("keyring_get", { key: "pending_rotation" });
        return held != null && held !== "";
      } catch {
        return false;
      }
    },
    storedPublicKeyHex: () => heldPublicKey().catch(() => null),
    ...(deps.listDeviceKeys ? { knownDeviceKeys: deps.listDeviceKeys } : {}),
    now,
  };
}

export interface DesktopMachineRoster {
  motebitId: string;
  deviceId: string;
  section: MachineRosterSection;
  /** The identity is being replaced, or the app stopped: nothing more is read, signed or presented. */
  dispose(): void;
}

/** The roster and its Settings section, for one motebit on this desktop. */
export function createDesktopMachineRoster(deps: DesktopRosterDeps): DesktopMachineRoster {
  const io = deps.io ?? tauriRosterIO(deps.invoke);
  const now = deps.now ?? Date.now;
  let disposed = false;
  const live = (): boolean => !disposed && (deps.live?.() ?? true);
  const isPresenter = live;
  // The Retry-After this desktop must honour (F8). Seeded from the STORED
  // record before every entry point: the kit repairs an omission inside
  // `acquire`, before `presentation.due` is ever asked, so an in-memory
  // value alone would let a fresh process POST inside a pending Retry-After.
  let retryUntil = 0;
  // The stored record could not be read: hold every presentation until it can.
  let unread = false;
  const held = (): boolean => unread || now() < retryUntil;
  const remember = (record: PresentationRecord | null): PresentationRecord | null => {
    // #801 F1 — bounded on read: a stored or planted far-future value never freezes presenting.
    retryUntil = Math.max(retryUntil, boundedRetryUntil(record, now()));
    return record;
  };
  const seed = async (): Promise<void> => {
    try {
      remember(await loadPresentationRecord(io, deps.motebitId));
      unread = false;
    } catch {
      unread = true;
    }
  };
  const roster = MachineRoster.gated(desktopRosterPorts({ ...deps, io, live }), {
    selfIsHost: false,
    repairOmissions: () => isPresenter() && !held(),
    presentationHeld: held,
  });
  const inner = createMachineRosterSection(roster, {
    deviceId: deps.deviceId,
    now,
    // F5b — this machine may be a CLI host: enroll(own) takes the kit's R17 path.
    refuseOwnEnroll: false,
    writeBlocked: () => (live() ? null : DISPOSED),
    presentation: {
      isPresenter,
      due: async (replica) =>
        presentationDue(
          remember(await loadPresentationRecord(io, deps.motebitId)),
          await replicaDigest(replica),
          now(),
          PRESENT_EVERY_MS,
        ),
      record: async (report, replica) => {
        const next = await nextPresentationRecord(
          await loadPresentationRecord(io, deps.motebitId),
          report,
          replica,
          now(),
        );
        if (next != null) await putPresentationRecord(io, deps.motebitId, remember(next)!);
      },
    },
  });
  const section: MachineRosterSection = {
    ...inner,
    refresh: async () => {
      await seed();
      return inner.refresh();
    },
    retire: async (deviceId) => {
      await seed();
      return inner.retire(deviceId);
    },
    enroll: async (deviceId, opts) => {
      await seed();
      return inner.enroll(deviceId, opts);
    },
  };
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
 * replica. Idempotent; no capture, no mint (S2). Best-effort: the key is
 * already committed, so a failure here must not fail the rotation.
 */
export async function rosterAfterRotationCommit(opts: {
  motebitId: string;
  record: KeySuccessionRecord;
  io: RosterFileIO;
}): Promise<void> {
  try {
    await saveReplica(opts.io, rotationLinkReplica(opts.motebitId, opts.record));
  } catch {
    // See above.
  }
}
