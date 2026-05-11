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

import {
  renderCoBrowseChrome,
  normalizeUrl,
  pickReceiptAnimation,
  getReceiptAnimation,
  animateMarkForReceipt,
} from "../ui/cobrowse-chrome";

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

// ── Slab-coherent chrome register — one material across all states ─────
//
// Doctrine: motebit-computer.md §"Visual properties" — chrome inherits
// the slab's substrate (one material throughout, no separate object
// floating above the slab). The strip uses heavy backdrop-blur for
// vibrancy (content visible through is blurred unreadable, chrome
// reads as one with the slab beneath). No opaque white pill, no full
// border, no drop shadow — those produced the "card floating above
// the slab" register the Apple-design pass reversed.
//
// Architectural correction (2026-05-11): the prior "always-present
// opaque surround" decision was made to fix a real overlap bug, but
// the fix wasn't right — opaque chrome fractured the slab into two
// objects. Right fix: slab-coherent translucent chrome + content
// inset (motebit-computer.md §"Visual properties" — content inset
// ~16pt). These tests pin the slab-coherent register; the content-
// inset arm lands in the WebGL screen-mesh sizing.
describe("renderCoBrowseChrome — slab-coherent chrome surround", () => {
  it("user state has slab-coherent material — low-alpha tint, heavy backdrop blur, no full border, no shadow", () => {
    const { machine } = makeMockMachine();
    const { fwd } = makeForwardEvent();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, { forwardEvent: fwd });
    // Low-alpha background (slab-coherent) — alpha 0.0X, not 0.8/0.9.
    expect(el.style.background).toMatch(/rgba\(\s*\d+,\s*\d+,\s*\d+\s*,\s*0\.0\d/);
    // Heavy backdrop blur — the vibrancy register that occludes
    // content visually without an opaque background.
    expect(el.style.backdropFilter).toMatch(/blur\(\d+px\)/);
    // No full border — only a hairline bottom separating chrome
    // from content below.
    // No full border — only a hairline bottom. JSDOM clears
    // shorthand `border: none` to empty string; we assert the
    // absence of any solid border declaration on the full shorthand
    // (the bottom hairline is asserted separately).
    expect(el.style.border).not.toContain("solid");
    expect(el.style.borderBottom).toContain("solid");
    // No box shadow — chrome is part of the slab silhouette, not a
    // separate card casting a shadow on the slab body. JSDOM
    // serializes `box-shadow: none` to empty string.
    expect(el.style.boxShadow).not.toMatch(/rgba|\bpx\b/);
    // No doorbell accent in user state.
    expect(el.style.borderLeft).not.toContain("3px solid");
  });

  it("motebit state has slab-coherent material — same shape as user", () => {
    const { machine } = makeMockMachine();
    const el = renderCoBrowseChrome({ kind: "motebit" }, machine, {});
    expect(el.style.background).toMatch(/rgba\(\s*\d+,\s*\d+,\s*\d+\s*,\s*0\.0\d/);
    expect(el.style.backdropFilter).toMatch(/blur\(\d+px\)/);
    expect(el.style.border).not.toContain("solid");
    expect(el.style.borderBottom).toContain("solid");
    expect(el.style.boxShadow).not.toMatch(/rgba|\bpx\b/);
    expect(el.style.borderLeft).not.toContain("3px solid");
  });

  it("handoff_pending has slab-coherent material + doorbell accent", () => {
    const { machine } = makeMockMachine();
    const state: ControlState = { kind: "handoff_pending", current: "user", requesting: "motebit" };
    const el = renderCoBrowseChrome(state, machine, {});
    expect(el.style.background).toMatch(/rgba\(\s*\d+,\s*\d+,\s*\d+\s*,\s*0\.0\d/);
    expect(el.style.backdropFilter).toMatch(/blur\(\d+px\)/);
    expect(el.style.border).not.toContain("solid");
    expect(el.style.borderBottom).toContain("solid");
    expect(el.style.boxShadow).not.toMatch(/rgba|\bpx\b/);
    // Doorbell accent — only fires when the user needs to decide.
    expect(el.style.borderLeft).toContain("3px solid");
  });

  it("paused has slab-coherent material — no doorbell accent", () => {
    const { machine } = makeMockMachine();
    const el = renderCoBrowseChrome({ kind: "paused", previousDriver: "user" }, machine, {});
    expect(el.style.background).toMatch(/rgba\(\s*\d+,\s*\d+,\s*\d+\s*,\s*0\.0\d/);
    expect(el.style.backdropFilter).toMatch(/blur\(\d+px\)/);
    expect(el.style.border).not.toContain("solid");
    expect(el.style.borderBottom).toContain("solid");
    expect(el.style.boxShadow).not.toMatch(/rgba|\bpx\b/);
    expect(el.style.borderLeft).not.toContain("3px solid");
  });

  it("slot composition is identical across states — only the doorbell accent differs", () => {
    // Defense against the slimmer register accidentally dropping
    // structural pieces. Mark + middle + trail must exist in every
    // state regardless of visual register.
    const { machine } = makeMockMachine();
    const { fwd } = makeForwardEvent();
    const states: ControlState[] = [
      { kind: "user" },
      { kind: "motebit" },
      { kind: "handoff_pending", current: "user", requesting: "motebit" },
      { kind: "paused", previousDriver: "user" },
    ];
    for (const state of states) {
      const el = renderCoBrowseChrome(state, machine, { forwardEvent: fwd });
      expect(el.querySelector(".cobrowse-chrome-mark")).not.toBeNull();
      // Middle slot — either an input (user), empty spacer (motebit),
      // or caption (handoff_pending / paused). At least one of the
      // three middle-slot classes must be present.
      const middle =
        el.querySelector(".cobrowse-chrome-middle") ??
        el.querySelector(".cobrowse-chrome-url-input");
      expect(middle).not.toBeNull();
      expect(el.querySelector(".cobrowse-chrome-trail")).not.toBeNull();
    }
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
    // Apple-grade: typed value persists through submission. Clearing
    // synchronously flashed the placeholder between Enter and the
    // async navigate result; blur() ends the edit register without
    // the flash, and the chrome's natural re-render on
    // `_currentBrowserUrl` update refines to the canonical URL.
    expect(input.value).toBe("example.com");
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

// ── chrome-1b: sensitivity ring + pixel-consent eye ───────────────────

describe("renderCoBrowseChrome — chrome-1b sensitivity ring", () => {
  it("renders no ring at sensitivity none (calm baseline)", () => {
    const { machine } = makeMockMachine();
    // SensitivityLevel.None at runtime — value "none".
    const el = renderCoBrowseChrome({ kind: "user" }, machine, {
      sensitivity: "none" as import("@motebit/sdk").SensitivityLevel,
    });
    expect(el.querySelector(".cobrowse-chrome-mark-ring")).toBeNull();
  });

  it("renders no ring at sensitivity personal (too common to mark permanently)", () => {
    const { machine } = makeMockMachine();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, {
      sensitivity: "personal" as import("@motebit/sdk").SensitivityLevel,
    });
    expect(el.querySelector(".cobrowse-chrome-mark-ring")).toBeNull();
  });

  it("renders a warm-coral ring at sensitivity medical", () => {
    const { machine } = makeMockMachine();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, {
      sensitivity: "medical" as import("@motebit/sdk").SensitivityLevel,
    });
    const ring = el.querySelector(".cobrowse-chrome-mark-ring-medical") as HTMLElement;
    expect(ring).not.toBeNull();
    // Coral tones — red-dominant RGB (220, 130, 110).
    expect(ring.style.border).toContain("220");
  });

  it("renders a muted-green ring at sensitivity financial", () => {
    const { machine } = makeMockMachine();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, {
      sensitivity: "financial" as import("@motebit/sdk").SensitivityLevel,
    });
    const ring = el.querySelector(".cobrowse-chrome-mark-ring-financial") as HTMLElement;
    expect(ring).not.toBeNull();
    // Green tones — green-dominant RGB (110, 165, 130).
    expect(ring.style.border).toContain("165");
  });

  it("renders a cool-gray ring at sensitivity secret", () => {
    const { machine } = makeMockMachine();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, {
      sensitivity: "secret" as import("@motebit/sdk").SensitivityLevel,
    });
    const ring = el.querySelector(".cobrowse-chrome-mark-ring-secret") as HTMLElement;
    expect(ring).not.toBeNull();
  });
});

describe("renderCoBrowseChrome — chrome-1b pixel-consent eye", () => {
  it("renders no eye glyph when consent is denied (calm default)", () => {
    const { machine } = makeMockMachine();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, {
      pixelConsent: "denied",
    });
    expect(el.querySelector(".cobrowse-chrome-mark-eye")).toBeNull();
  });

  it("renders the eye glyph when consent is session (granted)", () => {
    const { machine } = makeMockMachine();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, {
      pixelConsent: "session",
    });
    const eye = el.querySelector(".cobrowse-chrome-mark-eye") as HTMLElement;
    expect(eye).not.toBeNull();
    // Eye-glyph is a small inset circle inside the mark wrap.
    expect(eye.style.borderRadius).toBe("50%");
  });

  it("composes ring + eye when both elevated state and granted consent are present", () => {
    const { machine } = makeMockMachine();
    const el = renderCoBrowseChrome({ kind: "user" }, machine, {
      sensitivity: "medical" as import("@motebit/sdk").SensitivityLevel,
      pixelConsent: "session",
    });
    expect(el.querySelector(".cobrowse-chrome-mark-ring-medical")).not.toBeNull();
    expect(el.querySelector(".cobrowse-chrome-mark-eye")).not.toBeNull();
    // Both decorations live inside the same mark-wrap container —
    // single positioning context, no layout collision.
    const wrap = el.querySelector(".cobrowse-chrome-mark-wrap") as HTMLElement;
    expect(
      wrap.querySelectorAll(
        ".cobrowse-chrome-mark, .cobrowse-chrome-mark-ring-medical, .cobrowse-chrome-mark-eye",
      ),
    ).toHaveLength(3);
  });
});

// ── chrome-1c: act-firing animations ───────────────────────────────────

describe("pickReceiptAnimation — tool-name → animation kind", () => {
  it("read_page → 'read' (outward ripple)", () => {
    expect(pickReceiptAnimation("read_page")).toBe("read");
  });

  it("click_element / focus_element → 'click' (inward pulse)", () => {
    expect(pickReceiptAnimation("click_element")).toBe("click");
    expect(pickReceiptAnimation("focus_element")).toBe("click");
  });

  it("type_into → 'type' (keystroke flicker)", () => {
    expect(pickReceiptAnimation("type_into")).toBe("type");
  });

  it("computer + action.kind discriminates into the right sub-animation", () => {
    expect(pickReceiptAnimation("computer", { action: { kind: "screenshot" } })).toBe("look");
    expect(pickReceiptAnimation("computer", { action: { kind: "click" } })).toBe("click");
    expect(pickReceiptAnimation("computer", { action: { kind: "double_click" } })).toBe("click");
    expect(pickReceiptAnimation("computer", { action: { kind: "type" } })).toBe("type");
    expect(pickReceiptAnimation("computer", { action: { kind: "key" } })).toBe("type");
    expect(pickReceiptAnimation("computer", { action: { kind: "navigate" } })).toBe("read");
    expect(pickReceiptAnimation("computer", { action: { kind: "scroll" } })).toBe("generic");
  });

  it("computer without args falls back to 'click' (most computer actions are click-shaped)", () => {
    expect(pickReceiptAnimation("computer")).toBe("click");
  });

  it("unknown tool → 'generic' (soft single beat)", () => {
    expect(pickReceiptAnimation("web_search")).toBe("generic");
    expect(pickReceiptAnimation("recall_memories")).toBe("generic");
    expect(pickReceiptAnimation("custom_mcp_tool")).toBe("generic");
  });
});

describe("getReceiptAnimation — keyframes per kind", () => {
  it("returns distinct keyframes for each kind", () => {
    const read = getReceiptAnimation("read");
    const look = getReceiptAnimation("look");
    const click = getReceiptAnimation("click");
    const type = getReceiptAnimation("type");
    const generic = getReceiptAnimation("generic");
    expect(read.keyframes.length).toBeGreaterThan(0);
    expect(look.keyframes.length).toBeGreaterThan(0);
    expect(click.keyframes.length).toBeGreaterThan(0);
    expect(type.keyframes.length).toBeGreaterThan(0);
    expect(generic.keyframes.length).toBeGreaterThan(0);
  });

  it("sub-second durations across all kinds (calm-software register)", () => {
    for (const kind of ["read", "look", "click", "type", "generic"] as const) {
      const { options } = getReceiptAnimation(kind);
      expect(options.duration).toBeLessThanOrEqual(600);
      expect(options.duration as number).toBeGreaterThan(0);
    }
  });

  it("'read' is the longest (outward ripple takes a beat to fade)", () => {
    const read = getReceiptAnimation("read");
    const click = getReceiptAnimation("click");
    expect(read.options.duration as number).toBeGreaterThan(click.options.duration as number);
  });

  it("'type' uses opacity-flicker (no transform), distinct from scale-based kinds", () => {
    const type = getReceiptAnimation("type");
    expect("transform" in type.keyframes[0]!).toBe(false);
    expect("opacity" in type.keyframes[0]!).toBe(true);
  });
});

describe("animateMarkForReceipt — fires on a mark element", () => {
  it("calls element.animate() when Web Animations API is present", () => {
    const mark = document.createElement("div");
    let called = false;
    let receivedDuration: number | undefined;
    (mark as unknown as { animate: typeof Element.prototype.animate }).animate = ((
      _kf: Keyframe[],
      options: KeyframeAnimationOptions,
    ): Animation => {
      called = true;
      receivedDuration = options.duration as number;
      return { finished: Promise.resolve() } as unknown as Animation;
    }) as typeof Element.prototype.animate;
    animateMarkForReceipt(mark, "read_page");
    expect(called).toBe(true);
    expect(receivedDuration).toBe(520); // 'read' kind
  });

  it("no-ops gracefully when Web Animations API is unavailable (defense-in-depth)", () => {
    const mark = document.createElement("div");
    Object.defineProperty(mark, "animate", { value: undefined, writable: true });
    expect(() => animateMarkForReceipt(mark, "read_page")).not.toThrow();
  });

  it("computer + screenshot dispatches 'look' animation timing", () => {
    const mark = document.createElement("div");
    let receivedDuration: number | undefined;
    (mark as unknown as { animate: typeof Element.prototype.animate }).animate = ((
      _kf: Keyframe[],
      options: KeyframeAnimationOptions,
    ): Animation => {
      receivedDuration = options.duration as number;
      return { finished: Promise.resolve() } as unknown as Animation;
    }) as typeof Element.prototype.animate;
    animateMarkForReceipt(mark, "computer", { action: { kind: "screenshot" } });
    expect(receivedDuration).toBe(320); // 'look' kind
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
