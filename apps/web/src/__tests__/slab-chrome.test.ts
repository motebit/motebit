/**
 * @vitest-environment jsdom
 *
 * Slab-chrome dispatcher — `render(controlState × embodimentMode)`.
 *
 * The matrix is the architectural primitive. PR 1 fills the
 * `* × virtual_browser` column; the dispatcher's signature is the
 * full matrix and deferred cells return null. Tests assert:
 *
 *   - Matrix shape: deferred embodiment columns return null.
 *   - Cell routing: `motebit × virtual_browser` renders the narration
 *     register; other `virtual_browser` cells delegate to the
 *     existing cobrowse chrome (preserves PR 1's surface-functional
 *     baseline).
 *   - Narration content: text appears in the middle slot, the URL
 *     chip tethers it to the page motebit is on, absent narration
 *     leaves the existing cobrowse middle slot intact.
 *
 * Doctrine: `chrome-as-state-render.md` § "PR 1 scope."
 */

import { describe, it, expect } from "vitest";
import type { ControlState } from "@motebit/sdk";
import type { CoBrowseControlMachine } from "@motebit/runtime";

import { renderSlabChrome } from "../ui/slab-chrome";

function makeMockMachine(initial: ControlState = { kind: "user" }): CoBrowseControlMachine {
  const ok = { ok: true as const, state: initial };
  return {
    getState: () => initial,
    subscribe: () => () => {},
    requestControl: () => ok,
    grantControl: () => ok,
    denyControl: () => ok,
    reclaimControl: () => ok,
    releaseControl: () => ok,
    yieldControl: () => ok,
    pause: () => ok,
    resume: () => ok,
    disconnect: () => ok,
  };
}

describe("renderSlabChrome — matrix shape", () => {
  const machine = makeMockMachine();

  it("returns an element for the virtual_browser column on every control state", () => {
    expect(renderSlabChrome({ kind: "user" }, "virtual_browser", machine, {})).toBeInstanceOf(
      HTMLElement,
    );
    expect(renderSlabChrome({ kind: "motebit" }, "virtual_browser", machine, {})).toBeInstanceOf(
      HTMLElement,
    );
    expect(
      renderSlabChrome(
        { kind: "handoff_pending", current: "user", requesting: "motebit" },
        "virtual_browser",
        machine,
        {},
      ),
    ).toBeInstanceOf(HTMLElement);
    expect(
      renderSlabChrome({ kind: "paused", previousDriver: "user" }, "virtual_browser", machine, {}),
    ).toBeInstanceOf(HTMLElement);
  });

  it("returns null for embodiment columns deferred to PR N", () => {
    const state: ControlState = { kind: "motebit" };
    expect(renderSlabChrome(state, "mind", machine, {})).toBeNull();
    expect(renderSlabChrome(state, "tool_result", machine, {})).toBeNull();
    expect(renderSlabChrome(state, "shared_gaze", machine, {})).toBeNull();
    expect(renderSlabChrome(state, "desktop_drive", machine, {})).toBeNull();
    expect(renderSlabChrome(state, "peer_viewport", machine, {})).toBeNull();
  });
});

describe("renderSlabChrome — cell routing", () => {
  const machine = makeMockMachine();

  it("user × virtual_browser delegates to cobrowse chrome (URL input + nav arrows preserved)", () => {
    const el = renderSlabChrome({ kind: "user" }, "virtual_browser", machine, {
      forwardEvent: async () => ({ outcome: "forwarded", audit: { kind: "click" } }) as never,
    });
    expect(el?.querySelector(".cobrowse-chrome-url-input")).not.toBeNull();
    expect(el?.querySelector(".cobrowse-chrome-btn-back")).not.toBeNull();
  });

  it("handoff_pending × virtual_browser delegates to cobrowse chrome (Grant/Deny preserved)", () => {
    const el = renderSlabChrome(
      { kind: "handoff_pending", current: "user", requesting: "motebit" },
      "virtual_browser",
      machine,
      {},
    );
    expect(el?.textContent).toContain("Grant");
    expect(el?.textContent).toContain("Deny");
  });

  it("paused × virtual_browser delegates to cobrowse chrome (Resume preserved)", () => {
    const el = renderSlabChrome(
      { kind: "paused", previousDriver: "user" },
      "virtual_browser",
      machine,
      {},
    );
    expect(el?.textContent).toContain("Resume");
  });
});

describe("renderSlabChrome — motebit × virtual_browser narration register", () => {
  const machine = makeMockMachine();

  it("renders task-step narration in the middle slot when present", () => {
    const el = renderSlabChrome({ kind: "motebit" }, "virtual_browser", machine, {
      taskStepNarration: "Reading the page",
      currentUrl: "https://apple.com",
    });
    const narrationText = el?.querySelector(".slab-chrome-narration-text");
    expect(narrationText?.textContent).toBe("Reading the page");
  });

  it("tethers the URL host as a chip after the narration", () => {
    const el = renderSlabChrome({ kind: "motebit" }, "virtual_browser", machine, {
      taskStepNarration: "Reading the page",
      currentUrl: "https://www.apple.com/iphone",
    });
    const chip = el?.querySelector(".slab-chrome-narration-url-chip");
    // The chip canonicalizes: strip `www.`, expose host only.
    expect(chip?.textContent).toBe("apple.com");
    // The chip is the spatial-natural handoff target — rendered as a
    // button so click semantics + focus-ring + keyboard activation
    // come from the platform.
    expect(chip?.tagName).toBe("BUTTON");
    expect(chip?.getAttribute("aria-label")).toContain("Take the wheel");
  });

  it("chip click dispatches motebit:cobrowse-wheel — single mechanism shared with /wheel slash", () => {
    const el = renderSlabChrome({ kind: "motebit" }, "virtual_browser", machine, {
      taskStepNarration: "Reading the page",
      currentUrl: "https://apple.com",
    });
    const chip = el?.querySelector(".slab-chrome-narration-url-chip") as HTMLButtonElement;
    expect(chip).not.toBeNull();
    let dispatched = false;
    const listener = (): void => {
      dispatched = true;
    };
    document.addEventListener("motebit:cobrowse-wheel", listener);
    try {
      chip.click();
    } finally {
      document.removeEventListener("motebit:cobrowse-wheel", listener);
    }
    expect(dispatched).toBe(true);
  });

  it("recedes to the cobrowse middle slot when narration is absent", () => {
    const el = renderSlabChrome({ kind: "motebit" }, "virtual_browser", machine, {
      currentUrl: "https://apple.com",
    });
    // No narration → no narration-strip class.
    expect(el?.querySelector(".slab-chrome-narration")).toBeNull();
    // The cobrowse motebit-state render's URL display stays the
    // chrome's middle content (calm-default, no fabricated text).
    expect(el?.querySelector(".cobrowse-chrome-url-display")).not.toBeNull();
  });

  it("recedes when narration is an empty / whitespace string (no spurious empty register)", () => {
    const el = renderSlabChrome({ kind: "motebit" }, "virtual_browser", machine, {
      taskStepNarration: "   ",
      currentUrl: "https://apple.com",
    });
    expect(el?.querySelector(".slab-chrome-narration")).toBeNull();
  });

  it("recedes when narration is provided but no currentUrl — chip absent, text still renders", () => {
    const el = renderSlabChrome({ kind: "motebit" }, "virtual_browser", machine, {
      taskStepNarration: "Considering the trade-offs",
    });
    const text = el?.querySelector(".slab-chrome-narration-text");
    expect(text?.textContent).toBe("Considering the trade-offs");
    expect(el?.querySelector(".slab-chrome-narration-url-chip")).toBeNull();
  });

  it("does NOT render narration for non-motebit cells — narration is the motebit register's content", () => {
    const el = renderSlabChrome({ kind: "user" }, "virtual_browser", machine, {
      taskStepNarration: "Reading the page",
      forwardEvent: async () => ({ outcome: "forwarded", audit: { kind: "click" } }) as never,
    });
    expect(el?.querySelector(".slab-chrome-narration")).toBeNull();
  });
});
