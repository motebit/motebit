/**
 * @vitest-environment jsdom
 *
 * Settings → Machines render (machine-roster-surfaces-v1 S5): the count
 * only when the view carries one, the held-key class and its remedy, actions
 * only where the section offers them, the needs-force second tap, inline
 * notices, and relay-supplied text never parsed as markup.
 */
import { describe, it, expect, vi } from "vitest";
import type { MachineRosterSectionState, MachineRosterView } from "@motebit/surface-kit";
import { mountMachines, renderMachines } from "../ui/machines-section.js";

const roster = (
  over: Partial<Extract<MachineRosterView, { kind: "roster" }>> = {},
): MachineRosterView => ({
  kind: "roster",
  head: { public_key: "ab".repeat(32), fingerprint: "abababababababab" },
  this_device: "tab-device",
  claim: {
    active: 1,
    superseded: 0,
    unplaced: 0,
    text: "1 machine on the current key abababababababab…",
  },
  empty: null,
  suppressed: [],
  lines: [
    {
      kind: "active",
      device_id: "dev-host",
      this_device: false,
      entries: 1,
      liveness: { state: "unknown" },
      text: "dev-host — active; last seen 2026-09-26T00:00:00Z",
    },
    {
      kind: "retired",
      device_id: "dev-old",
      this_device: false,
      authenticated: true,
      connected: false,
      text: "dev-old — retired under the current key",
    },
  ],
  notes: [{ kind: "ancestry", text: "ancestry proven back to abababababababab…" }],
  relay: null,
  ...over,
});

const state = (over: Partial<MachineRosterSectionState> = {}): MachineRosterSectionState => ({
  phase: "ready",
  view: roster(),
  heldKey: { kind: "identity", basis: "relay" },
  heldKeyText: "identity key per the relay",
  rosterHidden: false,
  writeBlocked: null,
  lineActions: [
    { retire: true, enroll: false },
    { retire: false, enroll: true },
  ],
  busy: null,
  confirmForce: null,
  notice: null,
  error: null,
  ...over,
});

const fakeSection = () => ({
  retire: vi.fn(async () => undefined),
  enroll: vi.fn(async () => undefined),
  cancelForce: vi.fn(),
});

const buttons = (root: HTMLElement) =>
  Array.from(root.querySelectorAll("button")).map((b) => b.textContent);

describe("renderMachines", () => {
  it("identity: the count, the disclosed rung, lines with Retire / Enroll where offered, notes", () => {
    const s = fakeSection();
    const root = renderMachines(state(), s);
    expect(root.textContent).toContain("1 machine on the current key");
    expect(root.textContent).toContain("identity key per the relay");
    expect(root.textContent).toContain("ancestry proven back to");
    expect(buttons(root)).toEqual(["Retire", "Enroll"]);
    (root.querySelectorAll("button")[0] as HTMLButtonElement).click();
    (root.querySelectorAll("button")[1] as HTMLButtonElement).click();
    expect(s.retire).toHaveBeenCalledWith("dev-host");
    expect(s.enroll).toHaveBeenCalledWith("dev-old");
  });

  it("unconfirmed: no count, why, the remedy, and no actions", () => {
    const root = renderMachines(
      state({
        view: roster({ claim: null, suppressed: ["held_key_unconfirmed"] }),
        heldKey: { kind: "unconfirmed", why: "legacy-unproven" },
        heldKeyText:
          "no proven key for this legacy identity — counts need the CLI or a sovereign identity; nothing can be retired or enrolled from here",
        lineActions: [
          { retire: false, enroll: false },
          { retire: false, enroll: false },
        ],
      }),
      fakeSection(),
    );
    expect(root.textContent).not.toMatch(/1 machine/);
    expect(root.textContent).toContain(
      "No count: this device cannot confirm it holds the identity key.",
    );
    expect(root.textContent).toContain("counts need the CLI or a sovereign identity");
    expect(root.textContent).not.toMatch(/linked without/);
    expect(buttons(root)).toEqual([]);
  });

  it("device-key: says the device was linked without the identity key", () => {
    const root = renderMachines(
      state({
        view: roster({ claim: null, suppressed: ["held_key_unconfirmed"] }),
        heldKey: { kind: "device-key" },
        rosterHidden: true,
        heldKeyText:
          "this device was linked without the identity key; the roster needs a device that holds it",
      }),
      fakeSection(),
    );
    expect(root.textContent).toBe(
      "this device was linked without the identity key; the roster needs a device that holds it",
    );
    expect(buttons(root)).toEqual([]);
  });

  it("no roster and no key render the kit's words only", () => {
    const root = renderMachines(
      state({ view: { kind: "no-key", text: "no identity key is available on this device" } }),
      fakeSection(),
    );
    expect(root.textContent).toContain("no identity key is available on this device");
    expect(buttons(root)).toEqual([]);
    const loading = renderMachines(
      state({ view: null, phase: "loading", heldKeyText: null }),
      fakeSection(),
    );
    expect(loading.textContent).toBe("Reading the roster…");
  });

  it("the needs-force second tap, busy disabling, inline notices, write-blocked and errors", () => {
    const s = fakeSection();
    const root = renderMachines(
      state({
        confirmForce: {
          deviceId: "dev-x",
          why: "no-such-line",
          text: "This device sees no line for dev-x.",
        },
        notice: { deviceId: "dev-host", text: "Retired dev-host.", tone: "done" },
        writeBlocked: "this browser can't lock the roster across tabs",
        error: "idb gone",
        view: roster({
          empty: { kind: "none-enrolled", text: "no machine has enrolled yet" },
          lines: [],
        }),
        lineActions: [],
      }),
      s,
    );
    expect(root.textContent).toContain("This device sees no line for dev-x.");
    expect(root.textContent).toContain("Retired dev-host.");
    expect(root.textContent).toContain("can't lock the roster");
    expect(root.textContent).toContain("The roster could not be read: idb gone");
    expect(root.textContent).toContain("no machine has enrolled yet");
    const [anyway, cancel] = Array.from(root.querySelectorAll("button")) as HTMLButtonElement[];
    anyway!.click();
    cancel!.click();
    expect(s.enroll).toHaveBeenCalledWith("dev-x", { force: true });
    expect(s.cancelForce).toHaveBeenCalled();
    const busy = renderMachines(state({ busy: { deviceId: "dev-host", action: "retire" } }), s);
    expect(Array.from(busy.querySelectorAll("button")).every((b) => b.disabled === true)).toBe(
      true,
    );
  });

  it("relay-supplied text is text, never markup", () => {
    const root = renderMachines(
      state({
        view: roster({
          lines: [
            {
              kind: "not-in-roster",
              device_id: "<img src=x onerror=alert(1)>",
              bound_under: "ab".repeat(32),
              sockets_open: 1,
              text: "<img src=x onerror=alert(1)> — socket open, not in the roster",
            },
          ],
        }),
        lineActions: [{ retire: false, enroll: true }],
      }),
      fakeSection(),
    );
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});

describe("mountMachines", () => {
  it("renders the current state and re-renders on every change, until unsubscribed", () => {
    let listener: ((s: MachineRosterSectionState) => void) | null = null;
    let current = state();
    const section = {
      ...fakeSection(),
      getState: () => current,
      refresh: async () => undefined,
      subscribe: (l: (s: MachineRosterSectionState) => void) => {
        listener = l;
        return () => {
          listener = null;
        };
      },
    };
    const card = document.createElement("div");
    const off = mountMachines(card, section);
    expect(card.querySelectorAll(".machines-body")).toHaveLength(1);
    current = state({
      notice: { deviceId: "d", text: "Enrolled d under the current key.", tone: "done" },
    });
    listener!(current);
    expect(card.querySelectorAll(".machines-body")).toHaveLength(1);
    expect(card.textContent).toContain("Enrolled d");
    off();
    expect(listener).toBeNull();
  });
});
