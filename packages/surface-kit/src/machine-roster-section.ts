/**
 * The Machines section a C-2 surface (phone, desktop, browser) renders
 * under Settings — `docs/proposals/machine-roster-surfaces-v1.md` S5, S6,
 * with §1A (F1, F6, F8, F9) and §1B (R1, R2) taking precedence.
 *
 * One state holder (`subscribe` / `getState` / `refresh` / `retire` /
 * `enroll`) over a gated `MachineRoster`, so each surface adds only its
 * ports and its render. Pure of I/O: everything reaches the platform
 * through the roster's ports and these deps.
 *
 * What it guarantees, whatever the surface draws:
 *   - no action is offered, and none is performed, unless the held key is
 *     the identity key (R1) and the surface can write (a browser without
 *     cross-tab locks reads only, S3);
 *   - Retire only on a machine line (active or superseded, C4); Enroll only
 *     on superseded and retired lines and on devices the relay has a
 *     liveness ROW for with no line — never on `live_unenrolled` sockets,
 *     which are non-host by construction (F6);
 *   - `enroll` of this device's own id is refused on a surface that is never
 *     a host ("this device is not a host", S2);
 *   - a `needs-force` answer becomes an explicit second tap, never a retry;
 *   - results are inline notices — no toast (calm software).
 */
import { canonicalJson, bytesToHex, sha256 } from "@motebit/encryption";
import type {
  EnrollOutcome,
  EnrollRefusal,
  HeldKeyRefusal,
  MachineRoster,
  PresentReport,
  RetireOutcome,
  RosterAcquired,
} from "./machine-roster.js";
import type { MachineRosterReplica } from "./machine-roster-replica.js";
import { classifyHeldKey, heldKeyText, type HeldKeyClass } from "./machine-roster-held-key.js";
import { buildRosterView, type MachineRosterView } from "./machine-roster-view.js";

// ── Presentation cadence (F8) ────────────────────────────────────────

/** What a surface remembers about its last presentation, per motebit. */
export interface PresentationRecord {
  /** Digest of the replica the relay last took in full; `null` when never. */
  digest: string | null;
  taken_at: number;
  /** A 429's `Retry-After`: nothing is presented before this. */
  retry_until: number;
}

/** A digest of what a replica presents (its entries): changes when an entry joins. */
export async function replicaDigest(replica: MachineRosterReplica): Promise<string> {
  const enr = replica.enrollments.map((e) => canonicalJson(e)).sort();
  const ret = replica.retirements.map((r) => canonicalJson(r)).sort();
  const bytes = new TextEncoder().encode(canonicalJson({ enr, ret }));
  return bytesToHex(await sha256(bytes));
}

/**
 * F8 — present only when the replica changed since the last presentation
 * the relay fully took, or once `everyMs` has passed; never before a
 * `Retry-After` expires.
 */
export function presentationDue(
  record: PresentationRecord | null,
  digest: string,
  now: number,
  everyMs: number,
): boolean {
  if (record == null) return true;
  if (now < record.retry_until) return false;
  if (record.digest !== digest) return true;
  return now - record.taken_at >= everyMs;
}

/**
 * The record after a presentation: a `Retry-After` defers the next one; a
 * presentation the relay took in full (nothing left to retry) stamps the
 * digest. `replica` is `null` for a report whose replica is not in hand
 * (an act's own presentation) — only its `Retry-After` is kept.
 */
export async function nextPresentationRecord(
  prev: PresentationRecord | null,
  report: PresentReport,
  replica: MachineRosterReplica | null,
  now: number,
): Promise<PresentationRecord | null> {
  if (report.refused != null) return null;
  const base: PresentationRecord = prev ?? { digest: null, taken_at: 0, retry_until: 0 };
  if (report.retryAfterMs != null) {
    return { ...base, retry_until: now + report.retryAfterMs };
  }
  if (replica != null && report.notTaken.length === 0) {
    return { ...base, digest: await replicaDigest(replica), taken_at: now };
  }
  return null;
}

// ── The state holder (S6) ────────────────────────────────────────────

export interface RosterLineActions {
  retire: boolean;
  enroll: boolean;
}

export interface MachineRosterSectionState {
  phase: "idle" | "loading" | "ready";
  view: MachineRosterView | null;
  heldKey: HeldKeyClass | null;
  /** What to say about the held key (a disclosed rung, or why nothing can be done), or `null`. */
  heldKeyText: string | null;
  /**
   * Positive evidence the held key is a device-only key: its one-key chain
   * reads every real entry as unplaceable, so no roster is shown — only
   * `heldKeyText` (§1A: "linked without the identity key").
   */
  rosterHidden: boolean;
  /** Why write actions are unavailable here right now; `null` when they are. */
  writeBlocked: string | null;
  /** Per line of `view.lines` (same order): which actions it offers. */
  lineActions: RosterLineActions[];
  busy: { deviceId: string; action: "retire" | "enroll" } | null;
  /** An enroll the kit answered `needs-force`: the second, explicit tap. */
  confirmForce: { deviceId: string; why: EnrollRefusal; text: string } | null;
  /** The last act's result, shown inline beside the section. */
  notice: { deviceId: string; text: string; tone: "done" | "error" } | null;
  /** A refresh that threw (not an outcome): shown inline. */
  error: string | null;
}

export interface PresentationCadence {
  /** This surface is the presenting one now (web: the tab holding the leader lock). */
  isPresenter(): boolean;
  due(replica: MachineRosterReplica): Promise<boolean>;
  record(report: PresentReport, replica: MachineRosterReplica | null): Promise<void>;
}

export interface MachineRosterSectionDeps {
  /** This device's id — for the own-id refusal and actions. */
  deviceId: string;
  now?: () => number;
  /** Why this surface cannot write now (e.g. no cross-tab lock), or `null`. */
  writeBlocked?: () => string | null;
  /** Refuse `enroll` of this device's own id: "this device is not a host" (S2). Default true. */
  refuseOwnEnroll?: boolean;
  /**
   * When to present after a refresh (F8). Absent: present on every refresh
   * (S4, "whenever it connects").
   */
  presentation?: PresentationCadence;
}

export interface MachineRosterSection {
  subscribe(listener: (state: MachineRosterSectionState) => void): () => void;
  getState(): MachineRosterSectionState;
  refresh(): Promise<void>;
  retire(deviceId: string): Promise<void>;
  enroll(deviceId: string, opts?: { force?: boolean }): Promise<void>;
  /** Dismiss a pending second tap. */
  cancelForce(): void;
}

/** The actions each line of a roster view offers (F6, C4, S2). */
export function rosterLineActions(
  acq: RosterAcquired,
  view: MachineRosterView,
  opts: { allowed: boolean; refuseOwnEnroll: boolean },
): RosterLineActions[] {
  if (view.kind !== "roster") return [];
  const none = (): RosterLineActions => ({ retire: false, enroll: false });
  if (!opts.allowed) return view.lines.map(none);
  const v = acq.verdict;
  const hasLine = new Set([...v.active, ...v.retired, ...v.superseded].map((m) => m.device_id));
  // Liveness ROWS only (F6): `live_unenrolled` are non-host sockets.
  const rowDevices = new Set((acq.served?.liveness.rows ?? []).map((r) => r.device_id));
  const offered = new Set<string>();
  return view.lines.map((l) => {
    const mayEnroll = !(opts.refuseOwnEnroll && l.device_id === acq.deviceId);
    switch (l.kind) {
      case "active":
        return { retire: true, enroll: false };
      case "superseded":
        return { retire: true, enroll: mayEnroll };
      case "retired":
        return { retire: false, enroll: mayEnroll };
      case "unplaced-enrollment":
        return none();
      default: {
        const d = l.device_id;
        const enroll = mayEnroll && !hasLine.has(d) && rowDevices.has(d) && !offered.has(d);
        if (enroll) offered.add(d);
        return { retire: false, enroll };
      }
    }
  });
}

const entries = (n: number): string => `${n} ${n === 1 ? "entry" : "entries"}`;

function notTakenText(p: PresentReport): string {
  if (p.retryAfterMs != null) return " The relay asked to wait; kept here and presented later.";
  if (p.notTaken.length > 0) return " Not yet taken by the relay; kept here and presented again.";
  if (p.rosterFull.length > 0) {
    return ` The relay refused ${entries(p.rosterFull.length)} permanently (roster full).`;
  }
  return "";
}

type NothingSigned = Extract<
  RetireOutcome | EnrollOutcome | HeldKeyRefusal,
  { kind: "no-key" | "refused" | "unreadable" | "held-key-not-identity" }
>;

function nothingSigned(out: NothingSigned): string {
  switch (out.kind) {
    case "no-key":
      return "Nothing was signed: no identity key is available on this device.";
    case "refused":
      return "Nothing was signed: this device has no roster (see above).";
    case "unreadable":
      return `Nothing was signed: ${out.detail}.`;
    case "held-key-not-identity":
      return `Nothing was signed: ${heldKeyText(out.heldKey) ?? "the held key is not confirmed as the identity key"}.`;
  }
}

type Notice = { text: string; tone: "done" | "error" };

/** The inline words for a retire result (C4, N9, F9). */
export function retireNotice(out: RetireOutcome | HeldKeyRefusal): Notice {
  switch (out.kind) {
    case "no-key":
    case "refused":
    case "unreadable":
    case "held-key-not-identity":
      return { text: nothingSigned(out), tone: "error" };
    case "retired":
      return {
        tone: "done",
        text:
          `Retired ${out.deviceId}.` +
          (out.advisory ? " Advisory: its line is on a superseded key." : "") +
          notTakenText(out.presented) +
          // F9 — the undo, with its stated cost (#786).
          " Enroll undoes it — enrolled from this surface; the machine's own next rotation won't carry it.",
      };
    case "already-retired":
      return { tone: "done", text: `${out.deviceId} is already retired.` };
    case "not-enrolled":
      return {
        tone: "error",
        text: out.socketOpen
          ? `${out.deviceId}: the relay believes a socket is open; this device sees no enrolment for it to retire.`
          : `${out.deviceId}: the relay has seen it; this device sees no enrolment for it to retire.`,
      };
    case "unplaced-lines":
      return {
        tone: "error",
        text: `${out.deviceId} has ${out.count} ${out.count === 1 ? "enrolment" : "enrolments"} under keys this device cannot place in its chain; none retirable from here.`,
      };
    case "unknown-device":
      return {
        tone: "error",
        text: `No machine ${out.deviceId} is on the roster this device can see.`,
      };
  }
}

/** Why an enroll needs the second tap (R17). */
export function needsForceText(why: EnrollRefusal, deviceId: string, key?: string): string {
  switch (why) {
    case "no-such-line":
      return `This device sees no line for ${deviceId}. Enroll it anyway only if the id is right.`;
    case "unplaced-lines":
      return `${deviceId} is enrolled only under keys this device cannot place in its chain. Enroll anyway?`;
    case "all-superseded":
      return `Every line of ${deviceId} this device can see is on a superseded key${key ? ` (${key.slice(0, 16)}…)` : ""}. Enroll anyway only if it now holds the current key.`;
    case "linked-device":
      return `The relay has seen ${deviceId} under a linked device's key, not the identity key. Enroll anyway?`;
  }
}

/** The inline words for an enroll result (a `needs-force` is shown as its second tap). */
export function enrollNotice(out: EnrollOutcome | HeldKeyRefusal): Notice {
  switch (out.kind) {
    case "no-key":
    case "refused":
    case "unreadable":
    case "held-key-not-identity":
      return { text: nothingSigned(out), tone: "error" };
    case "enrolled":
      return {
        tone: "done",
        text: `Enrolled ${out.deviceId} under the current key.${notTakenText(out.presented)}`,
      };
    case "already-active":
      return { tone: "done", text: `${out.deviceId} is already active on the current key.` };
    case "needs-force":
      return { tone: "error", text: needsForceText(out.why, out.deviceId, out.key) };
  }
}

/** S6 — the shared state holder over a gated roster. */
export function createMachineRosterSection(
  roster: MachineRoster<HeldKeyRefusal>,
  deps: MachineRosterSectionDeps,
): MachineRosterSection {
  const now = (): number => (deps.now ?? Date.now)();
  const refuseOwnEnroll = deps.refuseOwnEnroll !== false;
  const listeners = new Set<(s: MachineRosterSectionState) => void>();
  let state: MachineRosterSectionState = {
    phase: "idle",
    view: null,
    heldKey: null,
    heldKeyText: null,
    rosterHidden: false,
    writeBlocked: null,
    lineActions: [],
    busy: null,
    confirmForce: null,
    notice: null,
    error: null,
  };
  let inFlight: Promise<void> | null = null;

  const set = (patch: Partial<MachineRosterSectionState>): void => {
    state = { ...state, ...patch };
    for (const l of listeners) l(state);
  };

  /** Actions are allowed only for the identity key on a surface that can write (R1, S3). */
  const allowed = (heldKey: HeldKeyClass | null): boolean =>
    heldKey?.kind === "identity" && (deps.writeBlocked?.() ?? null) == null;

  const load = async (): Promise<void> => {
    set({ phase: "loading", error: null });
    try {
      const acq = await roster.acquire();
      // A roster built without the gate never reaches here in a C-2
      // surface; if it did, its key is unconfirmed (fail-closed).
      const heldKey: HeldKeyClass =
        acq.kind === "acquired"
          ? (acq.heldKey ?? { kind: "unconfirmed", why: "no-evidence" })
          : classifyHeldKey(acq);
      const view = buildRosterView(acq, now());
      const writeBlocked = deps.writeBlocked?.() ?? null;
      const lineActions =
        acq.kind === "acquired"
          ? rosterLineActions(acq, view, { allowed: allowed(heldKey), refuseOwnEnroll })
          : [];
      set({
        phase: "ready",
        view,
        heldKey,
        heldKeyText: heldKeyText(heldKey),
        rosterHidden: heldKey.kind === "device-key",
        writeBlocked,
        lineActions,
      });
      // S4 / F8 — present from the presenting surface when due; never
      // under a key not confirmed as the identity key (R1).
      if (acq.kind === "acquired" && heldKey.kind === "identity") {
        const p = deps.presentation;
        // An omission repair inside the acquisition was a presentation too:
        // its Retry-After counts (R2, F8).
        if (acq.repair != null && p != null) await p.record(acq.repair, null);
        if (p == null) {
          await roster.present(acq);
        } else if (p.isPresenter() && (await p.due(acq.replica))) {
          await p.record(await roster.present(acq), acq.replica);
        }
      }
    } catch (err) {
      set({ phase: "ready", error: err instanceof Error ? err.message : String(err) });
    }
  };

  const refresh = (): Promise<void> => {
    inFlight ??= load().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const act = async (
    deviceId: string,
    action: "retire" | "enroll",
    run: () => Promise<void>,
  ): Promise<void> => {
    if (state.busy != null) return;
    const blocked = deps.writeBlocked?.() ?? null;
    if (blocked != null) {
      set({ notice: { deviceId, text: blocked, tone: "error" } });
      return;
    }
    set({ busy: { deviceId, action }, notice: null, confirmForce: null });
    try {
      await run();
    } catch (err) {
      set({
        notice: { deviceId, text: err instanceof Error ? err.message : String(err), tone: "error" },
      });
    } finally {
      set({ busy: null });
    }
    await refresh();
  };

  const recordAct = async (presented: PresentReport | undefined): Promise<void> => {
    if (presented != null && deps.presentation != null) {
      await deps.presentation.record(presented, null);
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: () => state,
    refresh,
    retire: (deviceId) =>
      act(deviceId, "retire", async () => {
        const out = await roster.retire(deviceId);
        set({ notice: { deviceId, ...retireNotice(out) } });
        if (out.kind === "retired") await recordAct(out.presented);
      }),
    enroll: (deviceId, opts = {}) => {
      if (refuseOwnEnroll && deviceId === deps.deviceId) {
        set({ notice: { deviceId, text: "This device is not a host.", tone: "error" } });
        return Promise.resolve();
      }
      return act(deviceId, "enroll", async () => {
        const out = await roster.enroll(deviceId, opts.force === true ? { force: true } : {});
        if (out.kind === "needs-force") {
          set({
            confirmForce: {
              deviceId,
              why: out.why,
              text: needsForceText(out.why, deviceId, out.key),
            },
          });
          return;
        }
        set({ notice: { deviceId, ...enrollNotice(out) } });
        if (out.kind === "enrolled") await recordAct(out.presented);
      });
    },
    cancelForce() {
      set({ confirmForce: null });
    },
  };
}
