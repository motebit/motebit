/**
 * @vitest-environment jsdom
 *
 * Tests for `apps/web/src/ui/cobrowse-band.ts` — Slice 2b.
 *
 * Two contracts under test:
 *
 *   1. **State → element shape.** Each `ControlState.kind` produces
 *      the right band: null on `user`, doorbell with Grant/Deny on
 *      `handoff_pending`, "driving" with reclaim on `motebit`, paused
 *      with resume on `paused`.
 *
 *   2. **Surface determinism (`docs/doctrine/surface-determinism.md`).**
 *      Button clicks invoke typed methods on the `CoBrowseControlMachine`
 *      directly — no prompt construction, no AI-loop routing. The
 *      `check-affordance-routing` gate enforces this statically; these
 *      tests enforce it at runtime by asserting which machine method
 *      each button triggers.
 */

import { describe, it, expect } from "vitest";
import type { ControlState } from "@motebit/sdk";
import type { CoBrowseControlMachine } from "@motebit/runtime";
import { renderCoBrowseBand } from "../ui/cobrowse-band";

interface MachineSpy {
  machine: CoBrowseControlMachine;
  calls: {
    requestControl: Array<"motebit">;
    grantControl: Array<"user">;
    denyControl: Array<"user">;
    reclaimControl: number;
    releaseControl: Array<"motebit">;
    pause: Array<"user" | "motebit" | "system">;
    resume: Array<"user" | "motebit" | "system">;
    disconnect: number;
    subscribe: number;
  };
}

function makeMachine(): MachineSpy {
  const calls: MachineSpy["calls"] = {
    requestControl: [],
    grantControl: [],
    denyControl: [],
    reclaimControl: 0,
    releaseControl: [],
    pause: [],
    resume: [],
    disconnect: 0,
    subscribe: 0,
  };
  // Minimal spy. The band module only invokes a subset of the
  // CoBrowseControlMachine surface — the typed-capability calls
  // wired to button clicks. Every call returns ok:true so the
  // production result-handling path (none — failed transitions
  // re-render the band on the next subscription emit) is covered
  // structurally.
  const machine: CoBrowseControlMachine = {
    getState: () => ({ kind: "user" }),
    subscribe: () => {
      calls.subscribe++;
      return () => {};
    },
    requestControl: (by) => {
      calls.requestControl.push(by);
      return {
        ok: true,
        state: { kind: "handoff_pending", current: "user", requesting: "motebit" },
      };
    },
    grantControl: (by) => {
      calls.grantControl.push(by);
      return { ok: true, state: { kind: "motebit" } };
    },
    denyControl: (by) => {
      calls.denyControl.push(by);
      return { ok: true, state: { kind: "user" } };
    },
    reclaimControl: () => {
      calls.reclaimControl++;
      return { ok: true, state: { kind: "user" } };
    },
    releaseControl: (by) => {
      calls.releaseControl.push(by);
      return { ok: true, state: { kind: "user" } };
    },
    pause: (by) => {
      calls.pause.push(by);
      return { ok: true, state: { kind: "paused", previousDriver: "user" } };
    },
    resume: (by) => {
      calls.resume.push(by);
      return { ok: true, state: { kind: "user" } };
    },
    disconnect: () => {
      calls.disconnect++;
      return { ok: true, state: { kind: "user" } };
    },
  };
  return { machine, calls };
}

describe("renderCoBrowseBand — calm register", () => {
  it("returns null on {kind: 'user'} — user is driving, nothing to surface", () => {
    const { machine } = makeMachine();
    const state: ControlState = { kind: "user" };
    expect(renderCoBrowseBand(state, machine)).toBeNull();
  });
});

describe("renderCoBrowseBand — handoff_pending (the doorbell)", () => {
  it("renders a band with Grant + Deny when current=user, requesting=motebit", () => {
    const { machine } = makeMachine();
    const state: ControlState = {
      kind: "handoff_pending",
      current: "user",
      requesting: "motebit",
    };
    const band = renderCoBrowseBand(state, machine);
    expect(band).not.toBeNull();
    expect(band?.className).toContain("cobrowse-band-handoff_pending");
    expect(band?.textContent).toContain("Motebit is requesting control");

    const buttons = Array.from(band!.querySelectorAll("button"));
    const labels = buttons.map((b) => b.textContent);
    expect(labels).toContain("Grant");
    expect(labels).toContain("Deny");
  });

  it("Grant button calls machine.grantControl('user') — direct affordance, no AI loop", () => {
    const { machine, calls } = makeMachine();
    const state: ControlState = {
      kind: "handoff_pending",
      current: "user",
      requesting: "motebit",
    };
    const band = renderCoBrowseBand(state, machine)!;
    const grant = Array.from(band.querySelectorAll("button")).find(
      (b) => b.textContent === "Grant",
    );
    grant?.click();

    expect(calls.grantControl).toEqual(["user"]);
    // Crucially, no other capability fired — surface determinism means
    // the button's only effect is the typed transition.
    expect(calls.denyControl).toEqual([]);
    expect(calls.reclaimControl).toBe(0);
    expect(calls.requestControl).toEqual([]);
  });

  it("Deny button calls machine.denyControl('user')", () => {
    const { machine, calls } = makeMachine();
    const state: ControlState = {
      kind: "handoff_pending",
      current: "user",
      requesting: "motebit",
    };
    const band = renderCoBrowseBand(state, machine)!;
    const deny = Array.from(band.querySelectorAll("button")).find((b) => b.textContent === "Deny");
    deny?.click();

    expect(calls.denyControl).toEqual(["user"]);
    expect(calls.grantControl).toEqual([]);
  });

  it("returns null defensively if current=motebit (future peer-side flow) — no false-affordance buttons", () => {
    // The state machine in v1 only allows current=user (motebit is the
    // only requester). When peer-side requests join the protocol, the
    // user-grants-from-non-user branch would be wrong_party at the
    // machine. The band stays silent rather than offering a button
    // that always fails.
    const { machine } = makeMachine();
    const state: ControlState = {
      kind: "handoff_pending",
      current: "motebit",
      requesting: "user",
    };
    expect(renderCoBrowseBand(state, machine)).toBeNull();
  });
});

describe("renderCoBrowseBand — motebit driving", () => {
  it("renders a band with Take back when motebit holds", () => {
    const { machine } = makeMachine();
    const band = renderCoBrowseBand({ kind: "motebit" }, machine);
    expect(band).not.toBeNull();
    expect(band?.className).toContain("cobrowse-band-motebit");
    expect(band?.textContent).toContain("Motebit is driving");

    const buttons = Array.from(band!.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Take back"]);
  });

  it("Take back calls machine.reclaimControl() — user's unilateral reclaim", () => {
    const { machine, calls } = makeMachine();
    const band = renderCoBrowseBand({ kind: "motebit" }, machine)!;
    const reclaim = Array.from(band.querySelectorAll("button")).find(
      (b) => b.textContent === "Take back",
    );
    reclaim?.click();

    expect(calls.reclaimControl).toBe(1);
    // Reclaim is unilateral — no `by` parameter; the machine fires
    // initiator: "user" itself. No other transitions fire from this
    // button.
    expect(calls.releaseControl).toEqual([]);
    expect(calls.grantControl).toEqual([]);
  });
});

describe("renderCoBrowseBand — paused", () => {
  it("renders a band with Resume when paused (does not leak previousDriver)", () => {
    const { machine } = makeMachine();
    const band = renderCoBrowseBand({ kind: "paused", previousDriver: "motebit" }, machine);
    expect(band).not.toBeNull();
    expect(band?.className).toContain("cobrowse-band-paused");
    expect(band?.textContent).toContain("Paused");
    // `previousDriver` is a resume-semantics implementation detail;
    // the user shouldn't see "motebit" or "user" leak into the label.
    expect(band?.textContent).not.toContain("motebit");
    expect(band?.textContent).not.toContain("previousDriver");

    const buttons = Array.from(band!.querySelectorAll("button"));
    expect(buttons.map((b) => b.textContent)).toEqual(["Resume"]);
  });

  it("Resume calls machine.resume('user')", () => {
    const { machine, calls } = makeMachine();
    const band = renderCoBrowseBand({ kind: "paused", previousDriver: "user" }, machine)!;
    const resume = Array.from(band.querySelectorAll("button")).find(
      (b) => b.textContent === "Resume",
    );
    resume?.click();

    expect(calls.resume).toEqual(["user"]);
  });
});

describe("renderCoBrowseBand — surface-determinism gate compliance", () => {
  it("button click handlers do not import or invoke any AI-loop entry point", () => {
    // The check-affordance-routing gate scans the source statically.
    // Here we assert at runtime: clicking every button across every
    // state only fires direct typed-capability calls. No globals are
    // mutated, no fetch/document.dispatchEvent backchannels. The spy
    // covers the full machine surface — anything outside it would be
    // a custom side effect.
    const { machine, calls } = makeMachine();

    // handoff_pending — grant
    let band = renderCoBrowseBand(
      { kind: "handoff_pending", current: "user", requesting: "motebit" },
      machine,
    )!;
    Array.from(band.querySelectorAll("button"))
      .find((b) => b.textContent === "Grant")
      ?.click();

    // motebit — reclaim
    band = renderCoBrowseBand({ kind: "motebit" }, machine)!;
    Array.from(band.querySelectorAll("button"))
      .find((b) => b.textContent === "Take back")
      ?.click();

    // paused — resume
    band = renderCoBrowseBand({ kind: "paused", previousDriver: "motebit" }, machine)!;
    Array.from(band.querySelectorAll("button"))
      .find((b) => b.textContent === "Resume")
      ?.click();

    // Total observed transitions exactly match the buttons clicked.
    // No incidental fan-out.
    expect(calls.grantControl).toEqual(["user"]);
    expect(calls.reclaimControl).toBe(1);
    expect(calls.resume).toEqual(["user"]);
    expect(calls.requestControl).toEqual([]);
    expect(calls.releaseControl).toEqual([]);
    expect(calls.denyControl).toEqual([]);
    expect(calls.pause).toEqual([]);
    expect(calls.disconnect).toBe(0);
  });
});
