/**
 * `CoBrowseControlMachine` — state machine tests.
 *
 * Slice 0 of the co-browse arc. Pure logic; no I/O, no wire forwarding.
 * The audit emitter is a vi.fn so tests assert both state shape AND
 * audit-event shape (a verifier replaying the log must rebuild the
 * state machine independently — events have to carry full from/to,
 * not just deltas).
 *
 * Eight transitions × per-state legality + the disconnect fail-closed
 * revert. Disconnect from `user` is a no-op AND does not emit an
 * audit event (no state change) — the only "no-op-without-emit"
 * branch in the machine.
 */

import { describe, it, expect, vi } from "vitest";
import type { CoBrowseControlChangedPayload } from "@motebit/sdk";

import { createCoBrowseControlMachine } from "../co-browse-control.js";

function makeMachine() {
  const onTransition = vi.fn<(p: CoBrowseControlChangedPayload) => void>();
  const machine = createCoBrowseControlMachine({
    sessionId: "cs_test",
    motebitId: "mb_test",
    onTransition,
    now: () => 1_700_000_000_000,
  });
  return { machine, onTransition };
}

describe("CoBrowseControlMachine — initial state", () => {
  it("starts in {kind: 'user'} (sessions open with the user holding control)", () => {
    const { machine } = makeMachine();
    expect(machine.getState()).toEqual({ kind: "user" });
  });

  it("does not emit a transition event on construction (no transition has happened yet)", () => {
    const { onTransition } = makeMachine();
    expect(onTransition).not.toHaveBeenCalled();
  });
});

describe("CoBrowseControlMachine — request → grant → reclaim happy path", () => {
  it("user → handoff_pending → motebit → user via the standard cycle", () => {
    const { machine, onTransition } = makeMachine();

    const req = machine.requestControl("motebit");
    expect(req).toEqual({
      ok: true,
      state: { kind: "handoff_pending", current: "user", requesting: "motebit" },
    });
    expect(machine.getState().kind).toBe("handoff_pending");

    const grant = machine.grantControl("user");
    expect(grant).toEqual({ ok: true, state: { kind: "motebit" } });

    const reclaim = machine.reclaimControl();
    expect(reclaim).toEqual({ ok: true, state: { kind: "user" } });

    // Three transition events fired, in order, with full from/to.
    expect(onTransition).toHaveBeenCalledTimes(3);
    expect(onTransition.mock.calls[0]?.[0]).toMatchObject({
      transition_kind: "request_control",
      initiator: "motebit",
      from: { kind: "user" },
      to: { kind: "handoff_pending", current: "user", requesting: "motebit" },
    });
    expect(onTransition.mock.calls[1]?.[0]).toMatchObject({
      transition_kind: "grant_control",
      initiator: "user",
      from: { kind: "handoff_pending", current: "user", requesting: "motebit" },
      to: { kind: "motebit" },
    });
    expect(onTransition.mock.calls[2]?.[0]).toMatchObject({
      transition_kind: "reclaim_control",
      initiator: "user",
      from: { kind: "motebit" },
      to: { kind: "user" },
    });
  });

  it("audit events carry the session_id, motebit_id, and timestamp", () => {
    const { machine, onTransition } = makeMachine();
    machine.requestControl("motebit");
    expect(onTransition.mock.calls[0]?.[0]).toMatchObject({
      session_id: "cs_test",
      motebit_id: "mb_test",
      timestamp: 1_700_000_000_000,
    });
  });
});

describe("CoBrowseControlMachine — deny path", () => {
  it("user denies → reverts to user; the request is lost", () => {
    const { machine, onTransition } = makeMachine();
    machine.requestControl("motebit");
    const deny = machine.denyControl("user");
    expect(deny).toEqual({ ok: true, state: { kind: "user" } });
    expect(machine.getState().kind).toBe("user");
    expect(onTransition.mock.calls[1]?.[0].transition_kind).toBe("deny_control");
  });

  it("denying without a pending request is invalid_from_state", () => {
    const { machine, onTransition } = makeMachine();
    const result = machine.denyControl("user");
    expect(result).toEqual({ ok: false, reason: "invalid_from_state" });
    expect(onTransition).not.toHaveBeenCalled();
  });
});

describe("CoBrowseControlMachine — release vs reclaim", () => {
  it("releaseControl(motebit) yields back to user (no approval needed)", () => {
    const { machine, onTransition } = makeMachine();
    machine.requestControl("motebit");
    machine.grantControl("user");
    expect(machine.getState().kind).toBe("motebit");
    onTransition.mockClear();

    const release = machine.releaseControl("motebit");
    expect(release).toEqual({ ok: true, state: { kind: "user" } });
    expect(onTransition.mock.calls[0]?.[0]).toMatchObject({
      transition_kind: "release_control",
      initiator: "motebit",
    });
  });

  it("releaseControl from non-motebit state is invalid_from_state", () => {
    const { machine } = makeMachine();
    expect(machine.releaseControl("motebit")).toEqual({
      ok: false,
      reason: "invalid_from_state",
    });
  });

  it("reclaimControl from non-motebit state is invalid_from_state (nothing to reclaim)", () => {
    const { machine } = makeMachine();
    expect(machine.reclaimControl()).toEqual({ ok: false, reason: "invalid_from_state" });
    machine.requestControl("motebit");
    // handoff_pending: also nothing to reclaim — user is still current.
    expect(machine.reclaimControl()).toEqual({ ok: false, reason: "invalid_from_state" });
  });
});

describe("CoBrowseControlMachine — pause / resume", () => {
  it("pause from user remembers user as previousDriver; resume restores", () => {
    const { machine } = makeMachine();
    const pause = machine.pause("user");
    expect(pause).toEqual({
      ok: true,
      state: { kind: "paused", previousDriver: "user" },
    });
    const resume = machine.resume("user");
    expect(resume).toEqual({ ok: true, state: { kind: "user" } });
  });

  it("pause from motebit remembers motebit; resume restores", () => {
    const { machine } = makeMachine();
    machine.requestControl("motebit");
    machine.grantControl("user");
    machine.pause("user");
    expect(machine.getState()).toEqual({ kind: "paused", previousDriver: "motebit" });
    machine.resume("user");
    expect(machine.getState()).toEqual({ kind: "motebit" });
  });

  it("pause from handoff_pending collapses to current's role; the request is lost", () => {
    const { machine } = makeMachine();
    machine.requestControl("motebit");
    machine.pause("user");
    // current was "user" at pause time → previousDriver: "user"
    expect(machine.getState()).toEqual({ kind: "paused", previousDriver: "user" });
    machine.resume("user");
    expect(machine.getState()).toEqual({ kind: "user" });
  });

  it("re-pausing a paused state is invalid_from_state", () => {
    const { machine } = makeMachine();
    machine.pause("user");
    expect(machine.pause("user")).toEqual({ ok: false, reason: "invalid_from_state" });
  });

  it("resume from non-paused state is invalid_from_state", () => {
    const { machine } = makeMachine();
    expect(machine.resume("user")).toEqual({ ok: false, reason: "invalid_from_state" });
  });

  it("system-initiated pause/resume is allowed (audit records 'system')", () => {
    const { machine, onTransition } = makeMachine();
    machine.pause("system");
    expect(onTransition.mock.calls[0]?.[0]).toMatchObject({
      transition_kind: "pause",
      initiator: "system",
    });
  });
});

describe("CoBrowseControlMachine — disconnect (fail-closed revert-to-user)", () => {
  it("disconnect from motebit reverts to user", () => {
    const { machine, onTransition } = makeMachine();
    machine.requestControl("motebit");
    machine.grantControl("user");
    expect(machine.getState().kind).toBe("motebit");
    onTransition.mockClear();

    const result = machine.disconnect();
    expect(result).toEqual({ ok: true, state: { kind: "user" } });
    expect(onTransition.mock.calls[0]?.[0]).toMatchObject({
      transition_kind: "disconnect",
      initiator: "system",
      from: { kind: "motebit" },
      to: { kind: "user" },
    });
  });

  it("disconnect from handoff_pending reverts to user (request abandoned)", () => {
    const { machine } = makeMachine();
    machine.requestControl("motebit");
    machine.disconnect();
    expect(machine.getState()).toEqual({ kind: "user" });
  });

  it("disconnect from paused reverts to user regardless of previousDriver", () => {
    const { machine } = makeMachine();
    machine.requestControl("motebit");
    machine.grantControl("user");
    machine.pause("user");
    expect(machine.getState()).toEqual({ kind: "paused", previousDriver: "motebit" });
    machine.disconnect();
    // Fail-closed: previousDriver was motebit, but disconnect always
    // lands at user. The motebit cannot continue on a page the user
    // can no longer observe.
    expect(machine.getState()).toEqual({ kind: "user" });
  });

  it("disconnect from user is a no-op AND does not emit an audit event", () => {
    const { machine, onTransition } = makeMachine();
    expect(machine.getState().kind).toBe("user");
    const result = machine.disconnect();
    expect(result).toEqual({ ok: true, state: { kind: "user" } });
    // No state change → no audit event. The disconnect signal still
    // returned ok:true so the transport-layer caller doesn't have to
    // special-case the user-already-holds case.
    expect(onTransition).not.toHaveBeenCalled();
  });
});

describe("CoBrowseControlMachine — wrong-party rejections", () => {
  it("requestControl by wrong party returns wrong_party", () => {
    const { machine } = makeMachine();
    // Type-coerced to exercise the runtime check (e.g. a federation
    // peer's MCP-imported tool calling with a freeform party value).
    const result = machine.requestControl("user" as never);
    expect(result).toEqual({ ok: false, reason: "wrong_party" });
  });

  it("requestControl by motebit when motebit already holds is invalid_from_state", () => {
    const { machine } = makeMachine();
    machine.requestControl("motebit");
    machine.grantControl("user");
    // Motebit can't request control it already has.
    expect(machine.requestControl("motebit")).toEqual({
      ok: false,
      reason: "invalid_from_state",
    });
  });

  it("requestControl from handoff_pending is invalid_from_state", () => {
    const { machine } = makeMachine();
    machine.requestControl("motebit");
    expect(machine.requestControl("motebit")).toEqual({
      ok: false,
      reason: "invalid_from_state",
    });
  });

  it("grantControl by non-current party returns wrong_party", () => {
    const { machine } = makeMachine();
    machine.requestControl("motebit");
    // current is "user"; granting "by motebit" is the requesting
    // party trying to grant their own request — wrong_party.
    expect(machine.grantControl("motebit" as never)).toEqual({
      ok: false,
      reason: "wrong_party",
    });
  });

  it("releaseControl by user returns wrong_party (only motebit can release)", () => {
    const { machine } = makeMachine();
    machine.requestControl("motebit");
    machine.grantControl("user");
    expect(machine.releaseControl("user" as never)).toEqual({
      ok: false,
      reason: "wrong_party",
    });
  });
});

describe("CoBrowseControlMachine — failed transitions never emit audit events", () => {
  it("any number of rejected transitions leaves the audit log untouched", () => {
    const { machine, onTransition } = makeMachine();
    machine.denyControl("user");
    machine.grantControl("user");
    machine.releaseControl("motebit");
    machine.reclaimControl();
    machine.resume("user");
    expect(onTransition).not.toHaveBeenCalled();
  });
});

describe("CoBrowseControlMachine — subscribe (UI fan-out)", () => {
  it("notifies subscribers with the new state after each successful transition", () => {
    const { machine } = makeMachine();
    const listener = vi.fn<(s: ControlStateForTest) => void>();
    machine.subscribe(listener);

    machine.requestControl("motebit");
    machine.grantControl("user");
    machine.reclaimControl();

    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls[0]?.[0]).toEqual({
      kind: "handoff_pending",
      current: "user",
      requesting: "motebit",
    });
    expect(listener.mock.calls[1]?.[0]).toEqual({ kind: "motebit" });
    expect(listener.mock.calls[2]?.[0]).toEqual({ kind: "user" });
  });

  it("does NOT notify on failed transitions (state didn't change)", () => {
    const { machine } = makeMachine();
    const listener = vi.fn<(s: ControlStateForTest) => void>();
    machine.subscribe(listener);

    // All rejected — wrong state or wrong party.
    machine.denyControl("user");
    machine.grantControl("user");
    machine.releaseControl("motebit");
    machine.reclaimControl();
    machine.resume("user");

    expect(listener).not.toHaveBeenCalled();
  });

  it("does NOT notify on a no-op disconnect from user (no audit emit, no UI emit)", () => {
    const { machine } = makeMachine();
    const listener = vi.fn<(s: ControlStateForTest) => void>();
    machine.subscribe(listener);

    machine.disconnect();

    expect(listener).not.toHaveBeenCalled();
  });

  it("multiple subscribers all receive every transition", () => {
    const { machine } = makeMachine();
    const a = vi.fn<(s: ControlStateForTest) => void>();
    const b = vi.fn<(s: ControlStateForTest) => void>();
    machine.subscribe(a);
    machine.subscribe(b);

    machine.requestControl("motebit");

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a.mock.calls[0]?.[0]).toEqual(b.mock.calls[0]?.[0]);
  });

  it("unsubscribe stops further notifications without affecting other subscribers", () => {
    const { machine } = makeMachine();
    const a = vi.fn<(s: ControlStateForTest) => void>();
    const b = vi.fn<(s: ControlStateForTest) => void>();
    const unsubA = machine.subscribe(a);
    machine.subscribe(b);

    machine.requestControl("motebit");
    unsubA();
    machine.grantControl("user");

    expect(a).toHaveBeenCalledTimes(1); // only the first transition
    expect(b).toHaveBeenCalledTimes(2); // both transitions
  });

  it("a listener that throws does not break audit emission or sibling listeners", () => {
    const { machine, onTransition } = makeMachine();
    const bad = vi.fn<(s: ControlStateForTest) => void>(() => {
      throw new Error("buggy slab renderer");
    });
    const sibling = vi.fn<(s: ControlStateForTest) => void>();
    machine.subscribe(bad);
    machine.subscribe(sibling);

    expect(() => machine.requestControl("motebit")).not.toThrow();
    expect(bad).toHaveBeenCalledTimes(1);
    expect(sibling).toHaveBeenCalledTimes(1);
    expect(onTransition).toHaveBeenCalledTimes(1); // audit still landed
  });

  it("audit fires before UI fan-out (so a listener throwing cannot pre-empt the audit)", () => {
    const { machine, onTransition } = makeMachine();
    const order: string[] = [];
    onTransition.mockImplementation(() => order.push("audit"));
    machine.subscribe(() => order.push("listener"));

    machine.requestControl("motebit");

    expect(order).toEqual(["audit", "listener"]);
  });
});

// Local re-alias so the test file doesn't import ControlState from
// @motebit/sdk directly (the protocol type lives there but tests
// historically rely on structural matching against the runtime
// machine's getState shape).
type ControlStateForTest =
  | { readonly kind: "user" }
  | { readonly kind: "motebit" }
  | { readonly kind: "handoff_pending"; readonly current: string; readonly requesting: string }
  | { readonly kind: "paused"; readonly previousDriver: string };
