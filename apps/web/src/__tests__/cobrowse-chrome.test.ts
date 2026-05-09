/**
 * @vitest-environment jsdom
 *
 * Co-browse Chrome-1 — unified browser-chrome strip.
 *
 * Migrates the load-bearing assertions from the deleted siblings
 * (`cobrowse-band.test.ts`, `cobrowse-address-bar.test.ts`):
 *
 *   - State-keyed structure (mark + middle + trail).
 *   - Direct typed-capability dispatch from buttons (surface-
 *     determinism — no AI-loop routing).
 *   - URL normalization parity with the server-side regex.
 *   - Address-input event-propagation discipline (typing into the
 *     URL input must NOT reach the document-level keydown that
 *     forwards into Chromium).
 *   - History-button dispatch on click (parameter-less wire events).
 */

import { describe, it, expect } from "vitest";
import type { ControlState, UserInputEvent } from "@motebit/sdk";
import type { CoBrowseControlMachine, UserInputForwardResult } from "@motebit/runtime";

import { renderCoBrowseChrome, normalizeUrl } from "../ui/cobrowse-chrome";

// ── normalizeUrl ────────────────────────────────────────────────────────

describe("normalizeUrl — server-side regex parity", () => {
  it("prepends https:// to bare hostnames", () => {
    expect(normalizeUrl("example.com")).toBe("https://example.com");
    expect(normalizeUrl("tesla.com/about")).toBe("https://tesla.com/about");
    expect(normalizeUrl("news.ycombinator.com")).toBe("https://news.ycombinator.com");
  });

  it("preserves URLs with explicit schemes", () => {
    expect(normalizeUrl("http://example.com")).toBe("http://example.com");
    expect(normalizeUrl("https://example.com")).toBe("https://example.com");
    expect(normalizeUrl("ftp://files.example.com")).toBe("ftp://files.example.com");
    expect(normalizeUrl("file:///etc/hosts")).toBe("file:///etc/hosts");
  });

  it("treats scheme matching as case-insensitive (mirrors server regex flag)", () => {
    expect(normalizeUrl("HTTPS://EXAMPLE.COM")).toBe("HTTPS://EXAMPLE.COM");
    expect(normalizeUrl("Http://Example.com")).toBe("Http://Example.com");
  });

  it("rejects pseudo-schemes — host-shaped strings get https://", () => {
    // No `://` separator, so not actually a scheme.
    expect(normalizeUrl("example:com")).toBe("https://example:com");
  });
});

// ── Test fixtures ──────────────────────────────────────────────────────

interface MachineCalls {
  reclaimControl: number;
  grantControl: Array<"user">;
  denyControl: Array<"user">;
  resume: Array<"user" | "motebit" | "system">;
  requestControl: Array<"motebit">;
  releaseControl: Array<"motebit">;
  pause: Array<"user" | "motebit" | "system">;
  disconnect: number;
}

function makeMockMachine(): { machine: CoBrowseControlMachine; calls: MachineCalls } {
  const calls: MachineCalls = {
    reclaimControl: 0,
    grantControl: [],
    denyControl: [],
    resume: [],
    requestControl: [],
    releaseControl: [],
    pause: [],
    disconnect: 0,
  };
  const userState: ControlState = { kind: "user" };
  const ok = { ok: true as const, state: userState };
  const machine: CoBrowseControlMachine = {
    getState: () => userState,
    subscribe: () => () => {},
    requestControl: (party) => {
      calls.requestControl.push(party);
      return ok;
    },
    grantControl: (party) => {
      calls.grantControl.push(party);
      return ok;
    },
    denyControl: (party) => {
      calls.denyControl.push(party);
      return ok;
    },
    reclaimControl: () => {
      calls.reclaimControl++;
      return ok;
    },
    releaseControl: (party) => {
      calls.releaseControl.push(party);
      return ok;
    },
    pause: (party) => {
      calls.pause.push(party);
      return ok;
    },
    resume: (party) => {
      calls.resume.push(party);
      return ok;
    },
    disconnect: () => {
      calls.disconnect++;
      return ok;
    },
  };
  return { machine, calls };
}

function makeForwardEvent(): {
  fwd: (e: UserInputEvent) => Promise<UserInputForwardResult>;
  events: UserInputEvent[];
} {
  const events: UserInputEvent[] = [];
  return {
    fwd: async (e: UserInputEvent) => {
      events.push(e);
      // The audit shape is irrelevant for these tests — they assert
      // dispatch happened, not the audit fields. Cast through unknown
      // because we don't bother synthesizing a full
      // `UserInputForwardedPayload`.
      return {
        outcome: "forwarded",
        audit: { kind: e.kind },
      } as unknown as UserInputForwardResult;
    },
    events,
  };
}

// ── State-keyed structure ──────────────────────────────────────────────

describe("renderCoBrowseChrome — state structure", () => {
  it("user state: mark + URL input + ← → ⟳ trail", () => {
    const { machine } = makeMockMachine();
    const { fwd } = makeForwardEvent();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, { forwardEvent: fwd });
    expect(el.classList.contains("cobrowse-chrome-user")).toBe(true);
    expect(el.querySelector(".cobrowse-chrome-mark")).not.toBeNull();
    expect(el.querySelector(".cobrowse-chrome-url-input")).not.toBeNull();
    expect(el.querySelector(".cobrowse-chrome-btn-back")).not.toBeNull();
    expect(el.querySelector(".cobrowse-chrome-btn-forward")).not.toBeNull();
    expect(el.querySelector(".cobrowse-chrome-btn-reload")).not.toBeNull();
    // No control-state buttons in user state.
    expect(el.textContent).not.toContain("Take back");
    expect(el.textContent).not.toContain("Grant");
    expect(el.textContent).not.toContain("Resume");
  });

  it("motebit state: mark + empty middle + Take back trail", () => {
    const { machine } = makeMockMachine();
    const el = renderCoBrowseChrome({ kind: "motebit" }, machine, {});
    expect(el.classList.contains("cobrowse-chrome-motebit")).toBe(true);
    expect(el.querySelector(".cobrowse-chrome-mark")).not.toBeNull();
    expect(el.querySelector(".cobrowse-chrome-middle-empty")).not.toBeNull();
    expect(el.textContent).toContain("Take back");
    // No URL input or nav arrows in motebit state — motebit has its
    // own navigate tool.
    expect(el.querySelector(".cobrowse-chrome-url-input")).toBeNull();
    expect(el.querySelector(".cobrowse-chrome-btn-back")).toBeNull();
  });

  it("handoff_pending state: mark + 'asks to drive' caption + Grant/Deny trail", () => {
    const { machine } = makeMockMachine();
    const state: ControlState = {
      kind: "handoff_pending",
      current: "user",
      requesting: "motebit",
    };
    const el = renderCoBrowseChrome(state, machine, {});
    expect(el.classList.contains("cobrowse-chrome-handoff_pending")).toBe(true);
    expect(el.textContent).toContain("asks to drive");
    expect(el.textContent).toContain("Grant");
    expect(el.textContent).toContain("Deny");
    // Doorbell accent — left border.
    expect(el.style.borderLeft).toContain("3px solid");
  });

  it("paused state: mark + 'paused' caption + Resume trail", () => {
    const { machine } = makeMockMachine();
    const state: ControlState = { kind: "paused", previousDriver: "user" };
    const el = renderCoBrowseChrome(state, machine, {});
    expect(el.classList.contains("cobrowse-chrome-paused")).toBe(true);
    expect(el.textContent).toContain("paused");
    expect(el.textContent).toContain("Resume");
  });

  it("strip is always present — no null return on any state", () => {
    const { machine } = makeMockMachine();
    expect(renderCoBrowseChrome({ kind: "user" }, machine, {})).toBeInstanceOf(HTMLElement);
    expect(renderCoBrowseChrome({ kind: "motebit" }, machine, {})).toBeInstanceOf(HTMLElement);
    expect(
      renderCoBrowseChrome(
        { kind: "handoff_pending", current: "user", requesting: "motebit" },
        machine,
        {},
      ),
    ).toBeInstanceOf(HTMLElement);
    expect(
      renderCoBrowseChrome({ kind: "paused", previousDriver: "user" }, machine, {}),
    ).toBeInstanceOf(HTMLElement);
  });
});

// ── Direct typed-capability dispatch ───────────────────────────────────

describe("renderCoBrowseChrome — surface-determinism", () => {
  it("Take back invokes machine.reclaimControl directly", () => {
    const { machine, calls } = makeMockMachine();
    const el = renderCoBrowseChrome({ kind: "motebit" }, machine, {});
    const btn = el.querySelector(".cobrowse-chrome-btn") as HTMLButtonElement;
    btn.click();
    expect(calls.reclaimControl).toBe(1);
  });

  it("Grant invokes machine.grantControl('user') directly", () => {
    const { machine, calls } = makeMockMachine();
    const state: ControlState = {
      kind: "handoff_pending",
      current: "user",
      requesting: "motebit",
    };
    const el = renderCoBrowseChrome(state, machine, {});
    const buttons = el.querySelectorAll(".cobrowse-chrome-btn-primary");
    (buttons[0] as HTMLButtonElement).click();
    expect(calls.grantControl).toEqual(["user"]);
    expect(calls.denyControl).toEqual([]);
  });

  it("Deny invokes machine.denyControl('user') directly", () => {
    const { machine, calls } = makeMockMachine();
    const state: ControlState = {
      kind: "handoff_pending",
      current: "user",
      requesting: "motebit",
    };
    const el = renderCoBrowseChrome(state, machine, {});
    const buttons = el.querySelectorAll(".cobrowse-chrome-btn-secondary");
    (buttons[0] as HTMLButtonElement).click();
    expect(calls.denyControl).toEqual(["user"]);
    expect(calls.grantControl).toEqual([]);
  });

  it("Resume invokes machine.resume('user') directly", () => {
    const { machine, calls } = makeMockMachine();
    const state: ControlState = { kind: "paused", previousDriver: "user" };
    const el = renderCoBrowseChrome(state, machine, {});
    const btn = el.querySelector(".cobrowse-chrome-btn") as HTMLButtonElement;
    btn.click();
    expect(calls.resume).toEqual(["user"]);
  });
});

// ── URL input + history buttons ────────────────────────────────────────

describe("renderCoBrowseChrome — user state input wiring", () => {
  it("Enter on URL input dispatches navigate with normalized URL", async () => {
    const { machine } = makeMockMachine();
    const { fwd, events } = makeForwardEvent();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, { forwardEvent: fwd });
    const input = el.querySelector(".cobrowse-chrome-url-input") as HTMLInputElement;
    input.value = "example.com";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    // Microtask flush — forwardEvent is async.
    await Promise.resolve();
    expect(events).toEqual([{ kind: "navigate", url: "https://example.com" }]);
    // Input clears after submit — calm chrome.
    expect(input.value).toBe("");
  });

  it("empty URL input is a no-op on Enter", async () => {
    const { machine } = makeMockMachine();
    const { fwd, events } = makeForwardEvent();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, { forwardEvent: fwd });
    const input = el.querySelector(".cobrowse-chrome-url-input") as HTMLInputElement;
    input.value = "  ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await Promise.resolve();
    expect(events).toEqual([]);
  });

  it("non-Enter keys do NOT dispatch navigate", async () => {
    const { machine } = makeMockMachine();
    const { fwd, events } = makeForwardEvent();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, { forwardEvent: fwd });
    const input = el.querySelector(".cobrowse-chrome-url-input") as HTMLInputElement;
    input.value = "example.com";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    await Promise.resolve();
    expect(events).toEqual([]);
  });

  it("URL input keydown stops propagation (no leak into Chromium key forwarder)", () => {
    const { machine } = makeMockMachine();
    const { fwd } = makeForwardEvent();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, { forwardEvent: fwd });
    const input = el.querySelector(".cobrowse-chrome-url-input") as HTMLInputElement;
    let documentSawKey = false;
    document.body.appendChild(el);
    document.addEventListener(
      "keydown",
      () => {
        documentSawKey = true;
      },
      { once: true },
    );
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "x", bubbles: true }));
    expect(documentSawKey).toBe(false);
    document.body.removeChild(el);
  });

  it("← button dispatches { kind: 'back' }", async () => {
    const { machine } = makeMockMachine();
    const { fwd, events } = makeForwardEvent();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, { forwardEvent: fwd });
    const btn = el.querySelector(".cobrowse-chrome-btn-back") as HTMLButtonElement;
    btn.click();
    await Promise.resolve();
    expect(events).toEqual([{ kind: "back" }]);
  });

  it("→ button dispatches { kind: 'forward' }", async () => {
    const { machine } = makeMockMachine();
    const { fwd, events } = makeForwardEvent();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, { forwardEvent: fwd });
    const btn = el.querySelector(".cobrowse-chrome-btn-forward") as HTMLButtonElement;
    btn.click();
    await Promise.resolve();
    expect(events).toEqual([{ kind: "forward" }]);
  });

  it("↻ button dispatches { kind: 'reload' }", async () => {
    const { machine } = makeMockMachine();
    const { fwd, events } = makeForwardEvent();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, { forwardEvent: fwd });
    const btn = el.querySelector(".cobrowse-chrome-btn-reload") as HTMLButtonElement;
    btn.click();
    await Promise.resolve();
    expect(events).toEqual([{ kind: "reload" }]);
  });
});

// ── Identity coherence (mark color) ────────────────────────────────────

describe("renderCoBrowseChrome — mark color reads from interiorColor", () => {
  it("uses the user-chosen interior color for the mark gradient", () => {
    const { machine } = makeMockMachine();
    const el = renderCoBrowseChrome({ kind: "motebit" }, machine, {
      interiorColor: { tint: [1.0, 0, 0], glow: [1.0, 0.5, 0.5] },
    });
    const mark = el.querySelector(".cobrowse-chrome-mark") as HTMLElement;
    // tint [255, 0, 0] and glow [255, 128, 128] should appear in the
    // gradient string.
    expect(mark.style.background).toContain("255");
  });

  it("falls back to a neutral cool tone when no color provided", () => {
    const { machine } = makeMockMachine();
    const el = renderCoBrowseChrome({ kind: "motebit" }, machine, {});
    const mark = el.querySelector(".cobrowse-chrome-mark") as HTMLElement;
    expect(mark.style.background).toContain("rgb"); // gradient set; specific neutral tone tested in render
  });
});

// ── Defensive guards ───────────────────────────────────────────────────

describe("renderCoBrowseChrome — defensive guards", () => {
  it("user state without forwardEvent: no URL input, no nav arrows (still renders strip)", () => {
    const { machine } = makeMockMachine();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, {});
    expect(el).toBeInstanceOf(HTMLElement);
    expect(el.querySelector(".cobrowse-chrome-url-input")).toBeNull();
    expect(el.querySelector(".cobrowse-chrome-btn-back")).toBeNull();
    expect(el.querySelector(".cobrowse-chrome-mark")).not.toBeNull();
  });

  it("handoff_pending with current !== 'user': no buttons (defensive against future peer-side requests)", () => {
    const { machine } = makeMockMachine();
    const state: ControlState = {
      kind: "handoff_pending",
      // Future protocol revision: motebit holds, peer requests.
      // Wrong-party for user-side grant; affordances should be absent.
      current: "motebit" as "user",
      requesting: "user" as "motebit",
    };
    const el = renderCoBrowseChrome(state, machine, {});
    expect(el.textContent).not.toContain("Grant");
    expect(el.textContent).not.toContain("Deny");
  });
});
