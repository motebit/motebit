/**
 * Surface-agnostic machine-roster controller —
 * `docs/proposals/machine-roster-clients-v1.md` C1 (consumer half), C2–C6,
 * with the round-3 amendments of §2A taking precedence.
 *
 * The relay stores the signed set and observes liveness; it never reduces
 * (part B). So "the machines of this motebit" is computed HERE, on a
 * key-holding surface, under a key chain this surface resolved itself
 * (`resolveRosterKeyChain`) from the key it holds and every succession
 * record it can see. Every surface that holds the identity key runs this
 * one algorithm; the platform is inverted into ports.
 *
 * ### Ports (C2)
 *   - `signer()` — resolved on EVERY call, its `publicKeyHex` DERIVED from
 *     the private key (R7): the chain anchor `held` is the key that signs,
 *     never a published copy that may have drifted (#767). The same object
 *     mints the roster routes' bearer, so the credential and the signature
 *     are one key by construction — and never the operator's master token,
 *     which the roster routes refuse (403).
 *   - `fetchSuccession` (public), `fetchRoster` / `presentRoster` (device
 *     token, via the signer).
 *   - `localSuccession()` — records from every findable signed identity file.
 *   - `pinnedGuardian()` — a LOCAL pin only, never the relay's (C1.5).
 *   - `cache` — the replica (`machine-roster-replica.ts`), three-way read.
 *
 * ### What is load-bearing
 *   - A retired machine never mints on its own (C3): only an explicit
 *     `enroll` rejoins it.
 *   - A superseded machine mints under the head ONLY on a frozen `active`
 *     keyed by the key of its current `H` (R21, R22).
 *   - Nothing mints on a failed GET, on a relay omission (R27), or on a
 *     corrupt cache read.
 *   - No quantifier over machines unless the verdict is `ok` and no
 *     suppression applies (C6.10) — see `machine-roster-view.ts`.
 */
import {
  bytesToHex,
  canonicalJson,
  getPublicKeyBySuite,
  hostEnrollmentId,
  hostRetirementId,
  resolveRosterKeyChain,
  signHostEnrollment,
  signHostRetirement,
  verifyHostRoster,
  type HostRosterVerdict,
  type RosterKeyChainOk,
} from "@motebit/encryption";
import { isHostEnrollment, isHostRetirement } from "@motebit/sdk";
import type { HostEnrollment, HostRetirement, KeySuccessionRecord } from "@motebit/sdk";
import {
  captureFor,
  emptyReplica,
  frozenFor,
  mergeReplicas,
  type FrozenValue,
  type MachineRosterReplica,
  type ReplicaRead,
  type RotationCapture,
} from "./machine-roster-replica.js";

const KEY_SUITE = "motebit-jcs-ed25519-hex-v1" as const;
/** The reference relay's per-request limit (spec §11); a chunk never exceeds it. */
export const ROSTER_CHUNK_SIZE = 64;
const HEX_32 = /^[0-9a-f]{64}$/;

export type HostEnrollmentBody = Omit<HostEnrollment, "signature" | "suite" | "type">;
export type HostRetirementBody = Omit<HostRetirement, "signature" | "suite" | "type">;

/** One key: it signs entries AND authenticates the roster routes. */
export interface RosterSigner {
  /** Derived from the private key — the chain anchor `held`. */
  readonly publicKeyHex: string;
  signEnrollment(body: HostEnrollmentBody): Promise<HostEnrollment>;
  signRetirement(body: HostRetirementBody): Promise<HostRetirement>;
  /** Headers carrying a device-key bearer (`device:auth`) minted by THIS key. */
  authorization(): Promise<Record<string, string>>;
}

/**
 * Build a signer from a private key. The public key is derived here, so a
 * surface cannot hand the controller a key that does not sign. The caller
 * owns `privateKey` (and erases it); `authorization` is the surface's own
 * device-token minter over the same bytes.
 */
export async function createRosterSigner(opts: {
  privateKey: Uint8Array;
  authorization: () => Promise<Record<string, string>>;
}): Promise<RosterSigner> {
  const publicKeyHex = bytesToHex(await getPublicKeyBySuite(opts.privateKey, KEY_SUITE));
  return {
    publicKeyHex,
    signEnrollment: (body) => signHostEnrollment(body, opts.privateKey),
    signRetirement: (body) => signHostRetirement(body, opts.privateKey),
    authorization: opts.authorization,
  };
}

/** A read that reached the relay (`ok`) or did not, with why. */
export type RosterFetch = { ok: true; body: unknown } | { ok: false; reason: string };

/** What a presentation got back: an HTTP status and body, or none (transport failure). */
export type RosterPresentResponse =
  { status: number; body: unknown } | { status: null; reason: string };

export interface MachineRosterPorts {
  motebitId: string;
  deviceId: string;
  /** `null` when no key is available on this surface right now. */
  signer(): Promise<RosterSigner | null>;
  /** The public `GET …/succession` body. */
  fetchSuccession(): Promise<RosterFetch>;
  /** `GET …/roster` under `signer.authorization()`. */
  fetchRoster(signer: RosterSigner): Promise<RosterFetch>;
  /** `POST …/roster` under `signer.authorization()`. At most `ROSTER_CHUNK_SIZE` entries. */
  presentRoster(
    signer: RosterSigner,
    body: { enrollments: HostEnrollment[]; retirements: HostRetirement[] },
  ): Promise<RosterPresentResponse>;
  /** Succession records of every findable signed identity file of THIS motebit (C1.4). */
  localSuccession(): Promise<unknown[]>;
  /** The guardian key pinned locally (identity file / config); never the relay's. */
  pinnedGuardian(): Promise<string | null>;
  cache: {
    load(): Promise<ReplicaRead>;
    /**
     * Persist. The adapter merges with what is stored NOW
     * (`mergeReplicas`) under its own lock — saving never removes anything.
     */
    save(replica: MachineRosterReplica): Promise<void>;
    /**
     * Run `fn` holding a lock that serializes every process of this surface
     * that may MINT for this replica (a `run` beside a `serve`). The kit
     * re-reads the replica inside it and decides, signs and saves before
     * releasing, so two concurrent starts never both mint (spec §4:
     * re-present, never mint per start). Must not be the lock `save` takes.
     */
    exclusive<T>(fn: () => Promise<T>): Promise<T>;
  };
  now?(): number;
  /** R23 remedy 1: a rotation write-ahead is present on this surface. */
  rotationInFlight?(): Promise<boolean>;
  /** R23 remedy 2: the public key the surface's stored config names now. */
  storedPublicKeyHex?(): Promise<string | null>;
  /** C6.3 / R25: device keys from the surface's OWN devices list. */
  knownDeviceKeys?(): Promise<string[]>;
}

// ── The served roster (part B D6), parsed defensively ────────────────

export interface LivenessRow {
  device_id: string;
  bound_under: string;
  last_seen_at: number | null;
  sockets_open: number;
}

export interface LiveUnenrolled {
  device_id: string;
  bound_under: string;
  sockets_open: number;
}

export interface ServedRoster {
  enrollments: unknown[];
  retirements: unknown[];
  liveness: {
    observed_by: string;
    retention_days: number;
    observing_since: number;
    rows: LivenessRow[];
    live_unenrolled: LiveUnenrolled[];
  };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** `null` when the body is not the part-B GET shape — read as a failed GET, never as an empty set. */
export function parseServedRoster(body: unknown): ServedRoster | null {
  if (!isObj(body)) return null;
  if (!Array.isArray(body.enrollments) || !Array.isArray(body.retirements)) return null;
  const l = body.liveness;
  if (!isObj(l)) return null;
  if (!Array.isArray(l.rows) || !Array.isArray(l.live_unenrolled)) return null;
  const rows: LivenessRow[] = [];
  for (const r of l.rows) {
    if (!isObj(r) || typeof r.device_id !== "string" || typeof r.bound_under !== "string") {
      return null;
    }
    rows.push({
      device_id: r.device_id,
      bound_under: r.bound_under,
      last_seen_at: typeof r.last_seen_at === "number" ? r.last_seen_at : null,
      sockets_open: typeof r.sockets_open === "number" ? r.sockets_open : 0,
    });
  }
  const live: LiveUnenrolled[] = [];
  for (const r of l.live_unenrolled) {
    if (!isObj(r) || typeof r.device_id !== "string" || typeof r.bound_under !== "string") {
      return null;
    }
    live.push({
      device_id: r.device_id,
      bound_under: r.bound_under,
      sockets_open: typeof r.sockets_open === "number" ? r.sockets_open : 0,
    });
  }
  return {
    enrollments: body.enrollments,
    retirements: body.retirements,
    liveness: {
      observed_by: typeof l.observed_by === "string" ? l.observed_by : "",
      retention_days: typeof l.retention_days === "number" ? l.retention_days : 0,
      observing_since: typeof l.observing_since === "number" ? l.observing_since : 0,
      rows,
      live_unenrolled: live,
    },
  };
}

// ── Outcomes ─────────────────────────────────────────────────────────

/** What to do about a refusal — a code; each surface words the command. */
export type RosterRemedy =
  /** R23.1 — a rotation write-ahead is present: resume the rotation. */
  | "finish-rotation"
  /** R23.2 — the stored config key succeeds the key this process holds: restart it. */
  | "restart"
  /** R23.3 — restore with the CURRENT key's seed or identity file. */
  | "restore"
  /** duplicate_key / fork_at_held — rotating forward to a fresh key resolves either. */
  | "rotate"
  /** A malformed call: a surface bug, nothing the user can do but report it. */
  | "report";

export type RosterRefusalReason =
  "duplicate_key" | "fork_at_held" | "held_key_superseded" | "malformed_input";

export type SuppressionReason =
  /** C1.3 — a guardian-verified branch this device is not on. */
  | "guardian_branch"
  /** C1.7 — the relay names a current key outside the resolved chain. */
  | "relay_newer_key"
  /** R27 — the relay is omitting entries this replica presents. */
  | "relay_omission"
  /**
   * The relay's roster could not be read: the verdict is over this
   * replica alone, which may be stale — no count is made from it.
   */
  | "relay_unread"
  /**
   * This device's copy of the roster could not be read (it was kept
   * aside), and no acquisition since has read the relay's roster and key
   * chain in full: the copy that would catch an omission is gone.
   */
  | "cache_corrupt";

export interface PresentReport {
  /** Entries the relay took (stored or already held). */
  taken: number;
  /** Not taken this time; retried at the next presentation. */
  notTaken: Array<{ id: string; reason: string }>;
  /** Refused `roster_full` for the FIRST time — permanent, reported once (C5). */
  rosterFull: string[];
}

export type RosterAcquisition =
  | { kind: "no-key" }
  | {
      kind: "refused";
      reason: RosterRefusalReason;
      held: string;
      detail: string;
      remedy: RosterRemedy;
      cache: ReplicaRead["kind"];
    }
  | RosterAcquired;

export interface RosterAcquired {
  kind: "acquired";
  motebitId: string;
  deviceId: string;
  signer: RosterSigner;
  /** The resolved chain; `chain.head` is the signer's key. */
  chain: RosterKeyChainOk;
  verdict: HostRosterVerdict;
  /** `null` when the GET failed — the verdict is then over the cache alone. */
  served: ServedRoster | null;
  fetchError: string | null;
  succession: {
    /** The public succession route answered. */
    served: boolean;
    /** Its `current_public_key` — a hint, never an input (C1.7). */
    hint: string | null;
    /** Links on the resolved path that the relay did not serve. */
    missingLinks: number;
  };
  /** Ids this replica presents that the relay still omits after a re-present and re-read (R27). */
  omitted: string[];
  suppressed: SuppressionReason[];
  cache: ReplicaRead["kind"];
  replica: MachineRosterReplica;
  /** Pairs with `sockets_open > 1` at the PREVIOUS read (C6.8's first read). */
  previousAmbiguous: string[];
  /** Device keys from the surface's own devices list (C6.3). */
  knownDeviceKeys: string[];
  /** Raw entries reduced over. */
  inputs: { enrollments: unknown[]; retirements: unknown[] };
  /** Id → `device_id` / key of every well-formed input enrolment — R25 takes a refused entry's `device_id` from here. */
  enrollmentIndex: Array<{ id: string; device_id: string; public_key: string }>;
  /** A re-presentation made to repair an omission, if one was needed. */
  repair: PresentReport | null;
}

/** True iff C3 may MINT from this acquisition (a successful GET, no omission, a readable cache). */
export function mayMint(acq: RosterAcquired): boolean {
  return acq.served != null && acq.omitted.length === 0 && acq.cache !== "corrupt";
}

/**
 * True iff an AUTOMATIC mint (C3 on announce, the rotation hook) may run:
 * everything `mayMint` needs, AND this acquisition read the relay's
 * succession chain. Without it the chain may be only `[held]`, the
 * device's own older-key lines come back unplaceable, and "no line" is a
 * blind spot, not a fact — a retired machine that lost its replica would
 * re-enrol itself. A failed `/succession` is a failed read, like a failed
 * roster GET (R27). Explicit acts (`enroll`, `retire`) use `mayMint`.
 */
export function mayAutoMint(acq: RosterAcquired): boolean {
  return mayMint(acq) && acq.succession.served;
}

/**
 * Rule 2: enrolments naming `deviceId` in the reduced input that the
 * verdict could not place (any rejection: an older key this surface
 * cannot place, a junk copy). While any exists, "no line" is not a fact
 * about this machine, and it is never auto-minted.
 */
export function unplacedOwnEnrollments(
  verdict: HostRosterVerdict,
  index: ReadonlyArray<{ id: string; device_id: string }>,
  deviceId: string,
): number {
  const rejected = new Set(
    verdict.rejected.filter((r) => r.kind === "enrollment" && r.id != null).map((r) => r.id!),
  );
  return index.filter((e) => e.device_id === deviceId && rejected.has(e.id)).length;
}

export type ThisDeviceStatus = "active" | "retired" | "superseded" | "none";

export function statusOf(
  verdict: HostRosterVerdict,
  deviceId: string,
): { status: ThisDeviceStatus; epoch: number | null } {
  for (const [status, list] of [
    ["active", verdict.active],
    ["retired", verdict.retired],
    ["superseded", verdict.superseded],
  ] as const) {
    const m = list.find((x) => x.device_id === deviceId);
    if (m) return { status, epoch: m.epoch };
  }
  return { status: "none", epoch: null };
}

export type EnsureEnrolledOutcome =
  | { kind: "no-key" }
  | { kind: "refused"; reason: RosterRefusalReason; detail: string; remedy: RosterRemedy }
  /** Active at the head: nothing minted, the held bytes re-presented. */
  | { kind: "active"; presented: PresentReport }
  | { kind: "minted"; enrollmentId: string; firstLine: boolean; presented: PresentReport }
  /** Retired at some epoch: never re-enrolled without an explicit act (C3). */
  | { kind: "retired"; presented: PresentReport }
  /** Superseded and no frozen `active` for its epoch: not covered until `enroll`. */
  | { kind: "superseded"; frozen: FrozenValue | null; presented: PresentReport }
  /**
   * No placeable line, but the input holds enrolments of this device the
   * chain cannot place (rule 2): not auto-minted — `enroll` is the act.
   */
  | { kind: "unplaced"; count: number; presented: PresentReport }
  /** Minting was the answer, but the state could not be read reliably enough to mint. */
  | {
      kind: "unknown";
      why: "fetch-failed" | "succession-unread" | "omission" | "cache-corrupt";
      status: ThisDeviceStatus;
      detail: string;
    };

export type RetireOutcome =
  | { kind: "no-key" }
  | { kind: "refused"; reason: RosterRefusalReason; detail: string; remedy: RosterRemedy }
  | { kind: "unreadable"; detail: string }
  | {
      kind: "retired";
      deviceId: string;
      retirementIds: string[];
      /** The line was superseded: the result is advisory (`authenticated: false`, N9). */
      advisory: boolean;
      presented: PresentReport;
    }
  | { kind: "already-retired"; deviceId: string }
  /** Connected but never enrolled — nothing to retire (C4). */
  | { kind: "not-enrolled"; deviceId: string }
  | { kind: "unknown-device"; deviceId: string };

export type EnrollRefusal =
  /** R17a — no line, and not this device's own id: a typo would be a permanently unreached active line. */
  | "no-such-line"
  /** R17b — every line superseded: it cannot hold the head key (R24: never this device's own id). */
  | "all-superseded"
  /** R17c — liveness shows it bound under a device key: a device linked without the identity key. */
  | "linked-device";

export type EnrollOutcome =
  | { kind: "no-key" }
  | { kind: "refused"; reason: RosterRefusalReason; detail: string; remedy: RosterRemedy }
  | { kind: "unreadable"; detail: string }
  | { kind: "already-active"; deviceId: string }
  | { kind: "needs-force"; deviceId: string; why: EnrollRefusal }
  | { kind: "enrolled"; deviceId: string; enrollmentId: string; presented: PresentReport };

export type RotationHookOutcome =
  | { kind: "no-verdict"; detail: string }
  | {
      kind: "frozen";
      /** The value persisted — or the one already there (first write wins). */
      value: FrozenValue;
      /**
       * What the C3 table then did under the new key — consulted ONLY on a
       * frozen `active` (a host). `null` otherwise: a surface that was not
       * an active host never becomes one by rotating (minting is tied to
       * announcing `unattended_runtime`, N8).
       */
      decided: EnsureEnrolledOutcome | null;
    };

// ── The controller ───────────────────────────────────────────────────

interface Item {
  kind: "enrollment" | "retirement";
  id: string;
  artifact: HostEnrollment | HostRetirement;
}

const pairKey = (deviceId: string, key: string): string => JSON.stringify([deviceId, key]);

type FrozenVerdictEntry = MachineRosterReplica["frozen"][number];

/** The rotation hook's authority: the frozen entry it would persist, and the capture's line. */
type RotationAuthority = FrozenVerdictEntry & { entries: string[] };

/**
 * A capture authorizes a mint on a superseded line only for the epoch it
 * was taken at AND while one of the enrolments it saw still stands there.
 */
function authorizes(
  rotation: RotationAuthority | undefined,
  hKey: string,
  standing: ReadonlyArray<{ enrollment_id: string }>,
): boolean {
  return (
    rotation != null &&
    rotation.pre_rotation_key === hKey &&
    standing.some((e) => rotation.entries.includes(e.enrollment_id))
  );
}

export class MachineRoster {
  constructor(private readonly ports: MachineRosterPorts) {}

  private now(): number {
    return Math.floor((this.ports.now ?? Date.now)());
  }

  /**
   * C1 + reduce: resolve the chain, read the relay, reduce `cache ∪ GET`,
   * hold what verifies, and repair an omission once (R27). Persists every
   * verified succession record, refusal evidence included (R26).
   */
  async acquire(explicitSigner?: RosterSigner): Promise<RosterAcquisition> {
    const { motebitId, deviceId } = this.ports;
    const signer = explicitSigner ?? (await this.ports.signer());
    if (signer == null) return { kind: "no-key" };
    const held = signer.publicKeyHex;

    const read = await this.ports.cache.load();
    let replica =
      read.kind === "value" && read.replica.motebit_id === motebitId
        ? read.replica
        : emptyReplica(motebitId);

    const [local, guardianRaw, succession] = await Promise.all([
      this.ports.localSuccession(),
      this.ports.pinnedGuardian(),
      this.ports.fetchSuccession(),
    ]);
    const guardian = guardianRaw != null && HEX_32.test(guardianRaw) ? guardianRaw : undefined;
    let servedChain: unknown[] = [];
    let hint: string | null = null;
    // A body that is not the succession shape — `null`, a list, a string, an
    // object with no `chain` list — is a FAILED read, never an empty chain:
    // rule 1 must not be satisfiable by a garbage 200.
    const successionRead =
      succession.ok && isObj(succession.body) && Array.isArray(succession.body.chain);
    if (successionRead) {
      const body = succession.body as Record<string, unknown>;
      servedChain = body.chain as unknown[];
      if (typeof body.current_public_key === "string") {
        hint = body.current_public_key.toLowerCase();
      }
    }
    const records = [...replica.succession, ...local, ...servedChain];
    const resolved = await resolveRosterKeyChain({
      motebitId,
      held,
      records,
      ...(guardian !== undefined ? { guardianKey: guardian } : {}),
    });

    // R26 — keep every verified record, the refusal's evidence included.
    const verified: KeySuccessionRecord[] = resolved.ok
      ? [...resolved.links, ...resolved.branches.map((b) => b.record)]
      : resolved.reason === "malformed_input"
        ? []
        : resolved.evidence;
    replica = mergeReplicas(replica, { ...emptyReplica(motebitId), succession: verified });

    if (!resolved.ok) {
      await this.ports.cache.save(replica);
      const remedy: RosterRemedy =
        resolved.reason === "held_key_superseded"
          ? await this.supersededRemedy(held, records, guardian)
          : resolved.reason === "malformed_input"
            ? "report"
            : "rotate";
      return {
        kind: "refused",
        reason: resolved.reason,
        held,
        detail: resolved.detail,
        remedy,
        cache: read.kind,
      };
    }

    const servedPairs = new Set<string>();
    for (const r of servedChain) {
      if (isObj(r) && typeof r.old_public_key === "string" && typeof r.new_public_key === "string")
        servedPairs.add(pairKey(r.old_public_key, r.new_public_key));
    }
    const missingLinks = successionRead
      ? resolved.links.filter((l) => !servedPairs.has(pairKey(l.old_public_key, l.new_public_key)))
          .length
      : 0;

    const fetched = await this.readRoster(signer);
    let served = fetched.served;
    const fetchError = fetched.error;
    let reduced = await this.reduceAndHold(resolved.chain, replica, served);
    replica = reduced.replica;

    // R27 — set-pinning over the ids this replica PRESENTS.
    let omitted: string[] = [];
    let repair: PresentReport | null = null;
    if (served != null) {
      omitted = await this.omissions(reduced.verdict, replica, served);
      if (omitted.length > 0) {
        const items = (await this.presentationSet(reduced.verdict, replica)).filter((i) =>
          omitted.includes(i.id),
        );
        const p = await this.presentItems(signer, items, replica);
        repair = p.report;
        replica = p.replica;
        const again = await this.readRoster(signer);
        if (again.served != null) {
          served = again.served;
          reduced = await this.reduceAndHold(resolved.chain, replica, served);
          replica = reduced.replica;
          omitted = await this.omissions(reduced.verdict, replica, served);
        }
        // A failed re-read keeps the omission standing: that GET counts as
        // failed for C3 and for the frozen verdict (R27).
      }
    }

    const suppressed: SuppressionReason[] = [];
    if (resolved.suppress_universal_claims) suppressed.push("guardian_branch");
    if (hint != null && !resolved.chain.includes(hint)) suppressed.push("relay_newer_key");
    if (omitted.length > 0) suppressed.push("relay_omission");
    if (served == null) suppressed.push("relay_unread");
    // P4 — this device's copy could not be read (this run), or was lost on
    // an earlier run and no acquisition has since read the relay in full.
    const fullRead = served != null && omitted.length === 0 && successionRead;
    const suspectBefore = replica.integrity.suspect;
    if (read.kind === "corrupt" || (suspectBefore && !fullRead)) suppressed.push("cache_corrupt");
    if (read.kind === "corrupt") {
      replica = { ...replica, integrity: { at: this.now(), suspect: true } };
    } else if (suspectBefore && fullRead) {
      replica = {
        ...replica,
        integrity: { at: Math.max(this.now(), replica.integrity.at + 1), suspect: false },
      };
    }

    const previousAmbiguous = replica.ambiguous.pairs;
    if (served != null) {
      const now = [
        ...served.liveness.rows.filter((r) => r.sockets_open > 1),
        ...served.liveness.live_unenrolled.filter((r) => r.sockets_open > 1),
      ].map((r) => pairKey(r.device_id, r.bound_under));
      replica = {
        ...replica,
        ambiguous: {
          at: Math.max(this.now(), replica.ambiguous.at + 1),
          pairs: [...new Set(now)].sort(),
        },
      };
    }
    await this.ports.cache.save(replica);

    return {
      kind: "acquired",
      motebitId,
      deviceId,
      signer,
      chain: resolved,
      verdict: reduced.verdict,
      served,
      fetchError,
      succession: { served: successionRead, hint, missingLinks },
      omitted,
      suppressed,
      cache: read.kind,
      replica,
      previousAmbiguous,
      knownDeviceKeys: (await this.ports.knownDeviceKeys?.()) ?? [],
      inputs: reduced.inputs,
      enrollmentIndex: await Promise.all(
        reduced.inputs.enrollments.filter(isHostEnrollment).map(async (e) => ({
          id: await hostEnrollmentId(e),
          device_id: e.device_id,
          public_key: e.public_key,
        })),
      ),
      repair,
    };
  }

  /**
   * C3 — decided on the CURRENT verdict over the cache ∪ a successful GET.
   * Called by whatever announces `unattended_runtime` (N8), after it has
   * registered with the relay.
   */
  async ensureEnrolled(): Promise<EnsureEnrolledOutcome> {
    const acq = await this.acquire();
    if (acq.kind === "no-key") return acq;
    if (acq.kind === "refused") return refusedOf(acq);
    return this.decide(acq);
  }

  /** The C3 status table over one acquisition. */
  private async decide(
    acq: RosterAcquired,
    rotation?: RotationAuthority,
  ): Promise<EnsureEnrolledOutcome> {
    const { status, epoch } = statusOf(acq.verdict, acq.deviceId);

    if (status === "active") return { kind: "active", presented: await this.present(acq) };
    // Retired at ANY epoch: never rejoins without an explicit act (spec §6
    // "Rejoining"), and a frozen value never overrides it (R14).
    if (status === "retired") return { kind: "retired", presented: await this.present(acq) };

    const blockedFromMinting = (): EnsureEnrolledOutcome | null =>
      acq.cache === "corrupt"
        ? {
            kind: "unknown",
            why: "cache-corrupt",
            status,
            detail: "the local roster replica could not be read; it was kept aside",
          }
        : acq.served == null
          ? {
              kind: "unknown",
              why: "fetch-failed",
              status,
              detail: acq.fetchError ?? "the relay's roster could not be read",
            }
          : acq.omitted.length > 0
            ? {
                kind: "unknown",
                why: "omission",
                status,
                detail: omissionDetail(acq.omitted.length),
              }
            : !acq.succession.served
              ? {
                  kind: "unknown",
                  why: "succession-unread",
                  status,
                  detail:
                    "the relay's key chain could not be read, so this machine's older lines cannot be placed",
                }
              : null;

    if (status === "superseded") {
      // R22 — read only the value keyed by the key of this machine's CURRENT H.
      const hKey = acq.chain.chain[epoch!]!;
      const line = acq.verdict.superseded.find((m) => m.device_id === acq.deviceId);
      const frozen = authorizes(rotation, hKey, line?.entries ?? [])
        ? "active"
        : frozenFor(acq.replica, acq.deviceId, hKey);
      if (frozen !== "active") {
        return { kind: "superseded", frozen, presented: await this.present(acq) };
      }
      return blockedFromMinting() ?? this.mintOwn(acq, false, rotation);
    }

    // Rule 2 — "no line" is a fact only when nothing of this device is unplaced.
    const unplaced = unplacedOwnEnrollments(acq.verdict, acq.enrollmentIndex, acq.deviceId);
    if (unplaced > 0) {
      return { kind: "unplaced", count: unplaced, presented: await this.present(acq) };
    }
    // No line at all: the first enrolment. (Never from the rotation hook:
    // its frozen `active` exists only for a device that had a line.)
    if (rotation != null) {
      return { kind: "superseded", frozen: null, presented: await this.present(acq) };
    }
    return blockedFromMinting() ?? this.mintOwn(acq, true);
  }

  /** C4 — sign one retirement per standing entry of `deviceId`, under the signer. */
  async retire(deviceId: string): Promise<RetireOutcome> {
    const acq = await this.acquire();
    if (acq.kind === "no-key") return acq;
    if (acq.kind === "refused") return refusedOf(acq);
    if (!mayMint(acq)) return { kind: "unreadable", detail: unreadableDetail(acq) };
    const v = acq.verdict;
    const line =
      v.active.find((m) => m.device_id === deviceId) ??
      v.superseded.find((m) => m.device_id === deviceId);
    if (line == null) {
      if (v.retired.some((m) => m.device_id === deviceId)) {
        return { kind: "already-retired", deviceId };
      }
      const connected =
        acq.served?.liveness.rows.some((r) => r.device_id === deviceId) === true ||
        acq.served?.liveness.live_unenrolled.some((r) => r.device_id === deviceId) === true;
      return connected ? { kind: "not-enrolled", deviceId } : { kind: "unknown-device", deviceId };
    }
    const retirements: HostRetirement[] = [];
    for (const entry of line.entries) {
      retirements.push(
        await acq.signer.signRetirement({
          motebit_id: acq.motebitId,
          enrollment_id: entry.enrollment_id,
          public_key: acq.signer.publicKeyHex,
          retired_at: this.now(),
        }),
      );
    }
    const replica = mergeReplicas(acq.replica, { ...emptyReplica(acq.motebitId), retirements });
    await this.ports.cache.save(replica);
    const presented = await this.presentFrom({ ...acq, replica });
    return {
      kind: "retired",
      deviceId,
      retirementIds: await Promise.all(retirements.map((r) => hostRetirementId(r))),
      advisory: !line.authenticated,
      presented,
    };
  }

  /** C4 undo — an explicit act by the key holder; R17 refusals unless `force`. */
  async enroll(deviceId: string, opts: { force?: boolean } = {}): Promise<EnrollOutcome> {
    const acq = await this.acquire();
    if (acq.kind === "no-key") return acq;
    if (acq.kind === "refused") return refusedOf(acq);
    if (!mayMint(acq)) return { kind: "unreadable", detail: unreadableDetail(acq) };
    const { status } = statusOf(acq.verdict, deviceId);
    if (status === "active") return { kind: "already-active", deviceId };
    const own = deviceId === acq.deviceId;
    if (opts.force !== true) {
      if (status === "none" && !own) return { kind: "needs-force", deviceId, why: "no-such-line" };
      // R24 — this device's own signer holds the head key by construction.
      if (status === "superseded" && !own) {
        return { kind: "needs-force", deviceId, why: "all-superseded" };
      }
      const known = new Set(acq.knownDeviceKeys);
      const bound = [
        ...(acq.served?.liveness.rows ?? []),
        ...(acq.served?.liveness.live_unenrolled ?? []),
      ].some((r) => r.device_id === deviceId && known.has(r.bound_under));
      if (bound) return { kind: "needs-force", deviceId, why: "linked-device" };
    }
    const minted = await this.mint(acq, deviceId, "explicit");
    if (minted.kind === "cache-corrupt") {
      return { kind: "unreadable", detail: unreadableDetail({ ...acq, cache: "corrupt" }) };
    }
    if (minted.kind !== "minted") return { kind: "already-active", deviceId };
    return { kind: "enrolled", deviceId, enrollmentId: minted.id, presented: minted.presented };
  }

  /**
   * R21 option (a), the first half: BEFORE the rotation is sent, under the
   * OLD key, capture this device's status — active or not at the head it is
   * about to leave — over the replica ∪ a successful roster GET ∪ a
   * successful succession read. Any failed read captures `absent`. The
   * capture replaces an older one for the same `(device_id, key)`: a
   * surface calls this only when no rotation from this key is in flight
   * (the CLI checks its write-ahead), so a resumed rotation keeps the
   * capture its original attempt took.
   */
  async captureBeforeRotation(): Promise<RotationCapture> {
    const { motebitId, deviceId } = this.ports;
    const signer = await this.ports.signer();
    const at = this.now();
    let status: RotationCapture["status"] = "absent";
    let entries: string[] = [];
    let fromKey = "";
    if (signer != null) {
      fromKey = signer.publicKeyHex;
      const acq = await this.acquire(signer);
      if (acq.kind === "acquired" && mayAutoMint(acq)) {
        const line = acq.verdict.active.find((m) => m.device_id === deviceId);
        status = line ? "active" : "not-active";
        entries = line ? line.entries.map((e) => e.enrollment_id) : [];
      }
    }
    const capture: RotationCapture = {
      motebit_id: motebitId,
      device_id: deviceId,
      from_key: fromKey,
      status,
      entries,
      at,
    };
    if (fromKey !== "") {
      await this.ports.cache.exclusive(async () => {
        await this.ports.cache.save({ ...emptyReplica(motebitId), rotation_captures: [capture] });
      });
    }
    return capture;
  }

  /**
   * R21 option (a), the second half: AFTER the local commit, under the NEW
   * key. The frozen verdict is the capture taken BEFORE the rotation was
   * sent, keyed by the rotation's old key — never a reduction of the inputs
   * as they stand now: after the relay records the link, a holder of the
   * old key can still present a fresh old-key enrolment for this device,
   * and re-reducing would read that as "active before the rotation" (#785).
   * No capture (an older client, a crash before it) is `absent`: no
   * automatic mint, the `enroll` remedy. A capture of `active` still mints
   * only through the locked C3 table (a retirement in the current verdict
   * wins, R14), and is persisted as frozen `active` only in the mint's own
   * save (F2). Idempotent on the resume paths.
   */
  async afterRotation(opts: {
    signer: RosterSigner;
    record: KeySuccessionRecord;
  }): Promise<RotationHookOutcome> {
    const { motebitId, deviceId } = this.ports;
    const oldKey = opts.record.old_public_key;
    // The new link joins the replica first (C1.4): it is a record source
    // whatever the relay later serves.
    const read = await this.ports.cache.load();
    // C3: nothing mints on a corrupt read — and a corrupt read lost the
    // capture too.
    const corruptAtStart = read.kind === "corrupt";
    const base =
      read.kind === "value" && read.replica.motebit_id === motebitId
        ? read.replica
        : emptyReplica(motebitId);
    await this.ports.cache.save(
      mergeReplicas(base, { ...emptyReplica(motebitId), succession: [opts.record] }),
    );

    const freeze = async (
      value: FrozenValue,
      replica: MachineRosterReplica,
    ): Promise<{ replica: MachineRosterReplica; value: FrozenValue }> => {
      const next = mergeReplicas(replica, {
        ...emptyReplica(motebitId),
        frozen: [{ device_id: deviceId, pre_rotation_key: oldKey, value, taken_at: this.now() }],
      });
      await this.ports.cache.save(next);
      // First write wins: report what is actually persisted.
      return { replica: next, value: frozenFor(next, deviceId, oldKey) ?? value };
    };

    const acq = await this.acquire(opts.signer);
    if (acq.kind === "no-key") return { kind: "no-verdict", detail: "no key" };
    if (acq.kind === "refused") {
      await freeze("absent", base);
      return { kind: "no-verdict", detail: acq.detail };
    }
    const pre = acq.chain.chain.slice(0, -1);
    // The ONLY input to the frozen decision: the capture taken before the
    // rotation was sent.
    const capture = corruptAtStart ? null : captureFor(acq.replica, deviceId, oldKey);
    const value: FrozenValue =
      capture == null ||
      capture.status === "absent" ||
      pre.length === 0 ||
      pre[pre.length - 1] !== oldKey ||
      !mayAutoMint(acq)
        ? "absent"
        : capture.status;
    const prior = frozenFor(acq.replica, deviceId, oldKey);
    if (value !== "active" || (prior != null && prior !== "active")) {
      // First write wins; and nothing but a frozen `active` goes further.
      const f = await freeze(value, acq.replica);
      return { kind: "frozen", value: f.value, decided: null };
    }
    // A frozen `active` is NEVER persisted on its own (F2): it is saved in
    // the mint's own critical section, in the same save as the head-key
    // line it authorizes — or as `not-active` if, under the lock, the
    // machine turns out retired in the current verdict (R14).
    const decided = await this.decide(acq, {
      device_id: deviceId,
      pre_rotation_key: oldKey,
      value: "active",
      taken_at: this.now(),
      entries: capture!.entries,
    });
    let persisted: FrozenValue;
    if (decided.kind === "minted" || decided.kind === "active") persisted = "active";
    else if (decided.kind === "retired") persisted = "not-active";
    else {
      persisted = (await freeze("absent", acq.replica)).value;
    }
    return { kind: "frozen", value: persisted, decided };
  }

  /** C5 — present this replica's presentation set, in chunks. */
  async present(acq: RosterAcquired): Promise<PresentReport> {
    return this.presentFrom(acq);
  }

  // ── internals ──────────────────────────────────────────────────────

  private async mintOwn(
    acq: RosterAcquired,
    firstLine: boolean,
    rotation?: RotationAuthority,
  ): Promise<EnsureEnrolledOutcome> {
    const m = await this.mint(acq, acq.deviceId, "auto", rotation);
    switch (m.kind) {
      case "unplaced":
        return { kind: "unplaced", count: m.count, presented: m.presented };
      case "minted":
        return { kind: "minted", enrollmentId: m.id, firstLine, presented: m.presented };
      case "held":
        return { kind: "active", presented: m.presented };
      case "retired":
        return { kind: "retired", presented: m.presented };
      case "superseded":
        return { kind: "superseded", frozen: m.frozen, presented: m.presented };
      case "cache-corrupt":
        return {
          kind: "unknown",
          why: "cache-corrupt",
          status: "none",
          detail: "the local roster replica could not be read; it was kept aside",
        };
    }
  }

  /**
   * The mint decision, the signature and the save, ATOMIC under
   * `cache.exclusive`. Inside the lock the replica is re-read and the
   * machine's status re-derived, so a concurrent start that minted first is
   * seen: its line is re-presented, never doubled (two enrolments of one
   * machine let a surface that sees only one retire half of it). An
   * automatic mint (`auto`) also re-applies the C3 rows that forbid it; an
   * explicit `enroll` mints unless the line is already active.
   */
  private async mint(
    acq: RosterAcquired,
    deviceId: string,
    mode: "auto" | "explicit",
    rotation?: RotationAuthority,
  ): Promise<
    | { kind: "minted" | "held"; id: string; presented: PresentReport }
    | { kind: "retired"; presented: PresentReport }
    | { kind: "superseded"; frozen: FrozenValue | null; presented: PresentReport }
    | { kind: "unplaced"; count: number; presented: PresentReport }
    | { kind: "cache-corrupt" }
  > {
    type Decision =
      | { kind: "minted" | "held"; id: string; replica: MachineRosterReplica }
      | { kind: "retired"; replica: MachineRosterReplica }
      | { kind: "superseded"; frozen: FrozenValue | null; replica: MachineRosterReplica }
      | { kind: "unplaced"; count: number; replica: MachineRosterReplica }
      | { kind: "cache-corrupt" };
    // The rotation hook's frozen verdict is persisted INSIDE this critical
    // section, in the same save as what it authorizes: `active` only beside
    // the head-key line (minted here, or already held), `not-active` when
    // the machine turned out retired. An interruption anywhere before that
    // save leaves no frozen `active` behind (F2).
    const frozenAs = (value: FrozenValue): Partial<MachineRosterReplica> =>
      rotation != null
        ? {
            frozen: [
              {
                device_id: rotation.device_id,
                pre_rotation_key: rotation.pre_rotation_key,
                value,
                taken_at: rotation.taken_at,
              },
            ],
          }
        : {};
    const decided = await this.ports.cache.exclusive(async (): Promise<Decision> => {
      const read = await this.ports.cache.load();
      if (read.kind === "corrupt") return { kind: "cache-corrupt" };
      const replica =
        read.kind === "value" && read.replica.motebit_id === acq.motebitId
          ? mergeReplicas(acq.replica, read.replica)
          : acq.replica;
      const now = await verifyHostRoster({
        motebitId: acq.motebitId,
        keyChain: acq.chain.chain,
        enrollments: [
          ...replica.enrollments,
          ...(acq.served?.enrollments ?? []),
        ] as HostEnrollment[],
        retirements: [
          ...replica.retirements,
          ...(acq.served?.retirements ?? []),
        ] as HostRetirement[],
      });
      const persist = async (
        extra: Partial<MachineRosterReplica>,
      ): Promise<MachineRosterReplica> => {
        const next = mergeReplicas(replica, { ...emptyReplica(acq.motebitId), ...extra });
        if (extra.frozen != null || extra.enrollments != null) await this.ports.cache.save(next);
        return next;
      };
      if (now.ok) {
        const line = now.active.find((m) => m.device_id === deviceId);
        if (line) {
          return {
            kind: "held",
            id: line.entries[0]!.enrollment_id,
            replica: await persist(frozenAs("active")),
          };
        }
        if (mode === "auto") {
          const { status, epoch } = statusOf(now, deviceId);
          if (status === "retired") {
            return { kind: "retired", replica: await persist(frozenAs("not-active")) };
          }
          if (status === "superseded") {
            const hKey = acq.chain.chain[epoch!]!;
            const line = now.superseded.find((m) => m.device_id === deviceId);
            const frozen = authorizes(rotation, hKey, line?.entries ?? [])
              ? "active"
              : frozenFor(replica, deviceId, hKey);
            if (frozen !== "active") return { kind: "superseded", frozen, replica };
          }
          if (status === "none") {
            // Rule 2, re-applied over the re-read input.
            const index: Array<{ id: string; device_id: string }> = [];
            for (const e of [...replica.enrollments, ...(acq.served?.enrollments ?? [])]) {
              if (isHostEnrollment(e) && e.device_id === deviceId) {
                index.push({ id: await hostEnrollmentId(e), device_id: e.device_id });
              }
            }
            const count = unplacedOwnEnrollments(now, index, deviceId);
            if (count > 0) return { kind: "unplaced", count, replica };
            if (rotation != null) return { kind: "superseded", frozen: null, replica };
          }
        }
      }
      // A fresh body is a fresh id (spec §4). Never one a held retirement
      // already names: a re-enrolment minted in the same millisecond as the
      // line it rejoins would be born retired.
      const named = new Set(replica.retirements.map((r) => r.enrollment_id));
      let enrolledAt = this.now();
      let enrollment: HostEnrollment;
      let id: string;
      for (;;) {
        enrollment = await acq.signer.signEnrollment({
          motebit_id: acq.motebitId,
          device_id: deviceId,
          public_key: acq.signer.publicKeyHex,
          enrolled_at: enrolledAt,
        });
        id = await hostEnrollmentId(enrollment);
        if (!named.has(id)) break;
        enrolledAt++;
      }
      const next = mergeReplicas(replica, {
        ...emptyReplica(acq.motebitId),
        enrollments: [enrollment],
        own_device_ids: deviceId === acq.deviceId ? [deviceId] : [],
        ...frozenAs("active"),
      });
      // Cached BEFORE it is presented, and before the lock is released: a
      // machine re-presents what it holds rather than minting per start.
      // One save: the enrolment and the frozen verdict that authorized it.
      await this.ports.cache.save(next);
      return { kind: "minted", id, replica: next };
    });
    if (decided.kind === "cache-corrupt") return decided;
    // Presented outside the lock: the network is no part of the decision.
    const presented = await this.presentFrom({ ...acq, replica: decided.replica });
    if (decided.kind === "superseded") {
      return { kind: "superseded", frozen: decided.frozen, presented };
    }
    if (decided.kind === "retired") return { kind: "retired", presented };
    if (decided.kind === "unplaced") return { kind: "unplaced", count: decided.count, presented };
    return { kind: decided.kind, id: decided.id, presented };
  }

  private async presentFrom(acq: RosterAcquired): Promise<PresentReport> {
    // Re-reduce over the replica as it stands (a mint or retirement may have joined it).
    const verdict = await verifyHostRoster({
      motebitId: acq.motebitId,
      keyChain: acq.chain.chain,
      enrollments: acq.replica.enrollments,
      retirements: acq.replica.retirements,
    });
    /* c8 ignore next -- the chain came from resolveRosterKeyChain, which never yields one the law refuses */
    if (!verdict.ok) return { taken: 0, notTaken: [], rosterFull: [] };
    const items = await this.presentationSet(verdict, acq.replica);
    const { report, replica } = await this.presentItems(acq.signer, items, acq.replica);
    if (report.rosterFull.length > 0) await this.ports.cache.save(replica);
    return report;
  }

  private async readRoster(
    signer: RosterSigner,
  ): Promise<{ served: ServedRoster | null; error: string | null }> {
    const got = await this.ports.fetchRoster(signer);
    if (!got.ok) return { served: null, error: got.reason };
    const parsed = parseServedRoster(got.body);
    return parsed == null
      ? { served: null, error: "the relay's roster response was not a roster" }
      : { served: parsed, error: null };
  }

  /**
   * Reduce `replica ∪ served` under `chain`, and HOLD every served copy that
   * verifies on its own (verify-before-hold: an id can be admissible through
   * one copy while another copy under a junk signature is not).
   */
  private async reduceAndHold(
    chain: string[],
    replica: MachineRosterReplica,
    served: ServedRoster | null,
  ): Promise<{
    verdict: HostRosterVerdict;
    replica: MachineRosterReplica;
    inputs: { enrollments: unknown[]; retirements: unknown[] };
  }> {
    const { motebitId } = this.ports;
    const inputs = {
      enrollments: [...replica.enrollments, ...(served?.enrollments ?? [])],
      retirements: [...replica.retirements, ...(served?.retirements ?? [])],
    };
    const result = await verifyHostRoster({
      motebitId,
      keyChain: chain,
      enrollments: inputs.enrollments as HostEnrollment[],
      retirements: inputs.retirements as HostRetirement[],
    });
    // The chain comes from `resolveRosterKeyChain`, which never yields one
    // the law refuses (no empty chain, no repeated or malformed key).
    /* c8 ignore next 3 */
    if (!result.ok) {
      throw new Error(`the roster law refused a resolved chain (${result.reason})`);
    }
    const heldEnr = new Set(replica.enrollments.map((e) => canonicalJson(e)));
    const heldRet = new Set(replica.retirements.map((e) => canonicalJson(e)));
    const newEnr: HostEnrollment[] = [];
    const newRet: HostRetirement[] = [];
    for (const e of served?.enrollments ?? []) {
      if (!isHostEnrollment(e) || heldEnr.has(canonicalJson(e))) continue;
      const alone = await verifyHostRoster({
        motebitId,
        keyChain: chain,
        enrollments: [e],
        retirements: [],
      });
      if (alone.ok && alone.rejected.length === 0) newEnr.push(e);
    }
    for (const r of served?.retirements ?? []) {
      if (!isHostRetirement(r) || heldRet.has(canonicalJson(r))) continue;
      const alone = await verifyHostRoster({
        motebitId,
        keyChain: chain,
        enrollments: [],
        retirements: [r],
      });
      if (alone.ok && alone.rejected.length === 0) newRet.push(r);
    }
    const { ok: _ok, ...verdict } = result;
    return {
      verdict,
      replica: mergeReplicas(replica, {
        ...emptyReplica(motebitId),
        enrollments: newEnr,
        retirements: newRet,
      }),
      inputs,
    };
  }

  /**
   * C5 / Q3 / R27 — what this replica presents: the head key's own entries
   * (they land in its own bucket), then the MINIMAL SUPPORT SET for the
   * foreign bucket — each non-active machine's enrolments at its highest
   * epoch and the retirements naming them (standing superseded lines
   * first), then pending tombstones. Never history below H, never old-epoch
   * entries of machines active at the head.
   */
  private async presentationSet(
    verdict: HostRosterVerdict,
    replica: MachineRosterReplica,
  ): Promise<Item[]> {
    const head = verdict.chain_head.public_key;
    const enrById = new Map<string, HostEnrollment>();
    for (const e of replica.enrollments) enrById.set(await hostEnrollmentId(e), e);
    const retById = new Map<string, HostRetirement>();
    const retByTarget = new Map<string, HostRetirement[]>();
    for (const r of replica.retirements) {
      retById.set(await hostRetirementId(r), r);
      retByTarget.set(r.enrollment_id, [...(retByTarget.get(r.enrollment_id) ?? []), r]);
    }
    const out = new Map<string, Item>();
    const addEnr = (id: string, e: HostEnrollment | undefined): void => {
      if (e && !out.has(`e:${id}`)) out.set(`e:${id}`, { kind: "enrollment", id, artifact: e });
    };
    const addRet = async (r: HostRetirement): Promise<void> => {
      const id = await hostRetirementId(r);
      if (!out.has(`r:${id}`)) out.set(`r:${id}`, { kind: "retirement", id, artifact: r });
    };
    for (const [id, e] of enrById) if (e.public_key === head) addEnr(id, e);
    for (const [, r] of retById) if (r.public_key === head) await addRet(r);
    for (const m of [...verdict.superseded, ...verdict.retired]) {
      for (const entry of m.entries) {
        addEnr(entry.enrollment_id, enrById.get(entry.enrollment_id));
        for (const r of retByTarget.get(entry.enrollment_id) ?? []) await addRet(r);
      }
    }
    for (const t of verdict.tombstones) {
      for (const r of retByTarget.get(t.enrollment_id) ?? []) await addRet(r);
    }
    return [...out.values()];
  }

  /** R27 — `(presented \ roster_full) \ served`, as ids. */
  private async omissions(
    verdict: HostRosterVerdict,
    replica: MachineRosterReplica,
    served: ServedRoster,
  ): Promise<string[]> {
    const servedIds = new Set<string>();
    for (const e of served.enrollments) {
      if (isHostEnrollment(e)) servedIds.add(await hostEnrollmentId(e));
    }
    for (const r of served.retirements) {
      if (isHostRetirement(r)) servedIds.add(await hostRetirementId(r));
    }
    const full = new Set(replica.roster_full);
    return (await this.presentationSet(verdict, replica))
      .map((i) => i.id)
      .filter((id) => !full.has(id) && !servedIds.has(id));
  }

  private async presentItems(
    signer: RosterSigner,
    all: Item[],
    replica: MachineRosterReplica,
  ): Promise<{ report: PresentReport; replica: MachineRosterReplica }> {
    const full = new Set(replica.roster_full);
    const items = all.filter((i) => !full.has(i.id)); // never retried (C5)
    const report: PresentReport = { taken: 0, notTaken: [], rosterFull: [] };
    for (let i = 0; i < items.length; i += ROSTER_CHUNK_SIZE) {
      const chunk = items.slice(i, i + ROSTER_CHUNK_SIZE);
      const enr = chunk.filter((c) => c.kind === "enrollment");
      const ret = chunk.filter((c) => c.kind === "retirement");
      const res = await this.ports.presentRoster(signer, {
        enrollments: enr.map((c) => c.artifact as HostEnrollment),
        retirements: ret.map((c) => c.artifact as HostRetirement),
      });
      if (res.status === 200 || res.status === 201) {
        report.taken += chunk.length;
        continue;
      }
      if (res.status === 422 && isObj(res.body) && Array.isArray(res.body.refused)) {
        const refused = new Map<string, string>();
        for (const r of res.body.refused) {
          if (!isObj(r) || typeof r.index !== "number") continue;
          const list = r.kind === "retirement" ? ret : enr;
          const hit = list[r.index];
          if (hit) refused.set(hit.id, typeof r.reason === "string" ? r.reason : "refused");
        }
        for (const c of chunk) {
          const reason = refused.get(c.id);
          if (reason == null) report.taken++;
          else if (reason === "roster_full") report.rosterFull.push(c.id);
          else report.notTaken.push({ id: c.id, reason });
        }
        continue;
      }
      // 413, any other status, or no response: the whole chunk was not taken.
      const why =
        res.status == null
          ? res.reason
          : res.status === 413
            ? "too large (413)"
            : `status ${res.status}`;
      for (const c of chunk) report.notTaken.push({ id: c.id, reason: why });
    }
    return {
      report,
      replica: mergeReplicas(replica, {
        ...emptyReplica(replica.motebit_id),
        roster_full: report.rosterFull,
      }),
    };
  }

  private async supersededRemedy(
    held: string,
    records: unknown[],
    guardian: string | undefined,
  ): Promise<RosterRemedy> {
    if ((await this.ports.rotationInFlight?.()) === true) return "finish-rotation";
    const stored = (await this.ports.storedPublicKeyHex?.())?.toLowerCase() ?? null;
    if (stored != null && stored !== held && HEX_32.test(stored)) {
      const fromStored = await resolveRosterKeyChain({
        motebitId: this.ports.motebitId,
        held: stored,
        records,
        ...(guardian !== undefined ? { guardianKey: guardian } : {}),
      });
      if (fromStored.ok && fromStored.chain.includes(held)) return "restart";
    }
    return "restore";
  }
}

function refusedOf(acq: Extract<RosterAcquisition, { kind: "refused" }>): {
  kind: "refused";
  reason: RosterRefusalReason;
  detail: string;
  remedy: RosterRemedy;
} {
  return { kind: "refused", reason: acq.reason, detail: acq.detail, remedy: acq.remedy };
}

function omissionDetail(n: number): string {
  return `the relay is missing ${n} entr${n === 1 ? "y" : "ies"} this device holds`;
}

function unreadableDetail(acq: RosterAcquired): string {
  if (acq.cache === "corrupt")
    return "the local roster replica could not be read; it was kept aside";
  if (acq.served == null) return acq.fetchError ?? "the relay's roster could not be read";
  return omissionDetail(acq.omitted.length);
}
