/**
 * Spatial slab-chrome dispatcher — `f(controlState × embodimentMode)`.
 *
 * Sibling of `apps/mobile/src/__tests__/slab-chrome.test.ts` and
 * `apps/web/src/__tests__/slab-chrome.test.ts`. Third surface
 * dispatcher in the matrix-as-primitive cascade; tests assert the
 * same invariants:
 *
 *   - Matrix shape: every `virtual_browser` control state returns
 *     a cell; every deferred embodiment column returns null.
 *   - Cell routing: each control state maps to the right cell kind.
 *   - `motebit-narration` register: narration text appears,
 *     whitespace-only collapses, URL formats as host-only chip.
 *   - Spatial render adapter: cells map to activity-label strings
 *     with the right shape; empty register returns null (calm
 *     default).
 *
 * Doctrine: `chrome-as-state-render.md` § "Spatial-as-endgame
 * validation" + § "PR 3 scope (spatial)".
 */

import { describe, it, expect } from "vitest";
import type { ControlState } from "@motebit/sdk";
import type { EmbodimentMode } from "@motebit/render-engine/spec";
import { dispatchSlabChrome, formatUrlHostForChip, renderCellToActivity } from "../slab-chrome";

describe("dispatchSlabChrome — matrix shape", () => {
  it("returns a cell for every control state on the virtual_browser column", () => {
    expect(dispatchSlabChrome({ kind: "motebit" }, "virtual_browser")).not.toBeNull();
    expect(dispatchSlabChrome({ kind: "user" }, "virtual_browser")).not.toBeNull();
    expect(
      dispatchSlabChrome(
        { kind: "handoff_pending", current: "user", requesting: "motebit" },
        "virtual_browser",
      ),
    ).not.toBeNull();
    expect(
      dispatchSlabChrome({ kind: "paused", previousDriver: "user" }, "virtual_browser"),
    ).not.toBeNull();
  });

  it("returns null for every embodiment column deferred to PR N", () => {
    const state: ControlState = { kind: "motebit" };
    const deferred: EmbodimentMode[] = [
      "mind",
      "tool_result",
      "shared_gaze",
      "desktop_drive",
      "peer_viewport",
    ];
    for (const mode of deferred) {
      expect(dispatchSlabChrome(state, mode)).toBeNull();
    }
  });
});

describe("dispatchSlabChrome — cell routing", () => {
  it("motebit × virtual_browser → motebit-narration cell carrying narration + URL", () => {
    const cell = dispatchSlabChrome({ kind: "motebit" }, "virtual_browser", {
      taskStepNarration: "Reading the page",
      currentUrl: "https://apple.com",
    });
    expect(cell?.kind).toBe("motebit-narration");
    if (cell?.kind === "motebit-narration") {
      expect(cell.narration).toBe("Reading the page");
      expect(cell.currentUrl).toBe("https://apple.com");
    }
  });

  it("user × virtual_browser → user-cobrowse cell", () => {
    const cell = dispatchSlabChrome({ kind: "user" }, "virtual_browser", {
      currentUrl: "https://apple.com",
    });
    expect(cell?.kind).toBe("user-cobrowse");
  });

  it("handoff_pending × virtual_browser → handoff-pending cell carrying both parties", () => {
    const cell = dispatchSlabChrome(
      { kind: "handoff_pending", current: "user", requesting: "motebit" },
      "virtual_browser",
    );
    expect(cell?.kind).toBe("handoff-pending");
    if (cell?.kind === "handoff-pending") {
      expect(cell.current).toBe("user");
      expect(cell.requesting).toBe("motebit");
    }
  });

  it("paused × virtual_browser → paused cell carrying previousDriver", () => {
    const cell = dispatchSlabChrome(
      { kind: "paused", previousDriver: "motebit" },
      "virtual_browser",
    );
    expect(cell?.kind).toBe("paused");
    if (cell?.kind === "paused") {
      expect(cell.previousDriver).toBe("motebit");
    }
  });
});

describe("dispatchSlabChrome — motebit-narration register", () => {
  it("trims surrounding whitespace before surfacing narration", () => {
    const cell = dispatchSlabChrome({ kind: "motebit" }, "virtual_browser", {
      taskStepNarration: "  Reading the page  ",
    });
    if (cell?.kind !== "motebit-narration") throw new Error("wrong cell kind");
    expect(cell.narration).toBe("Reading the page");
  });

  it("collapses whitespace-only narration to null", () => {
    const cell = dispatchSlabChrome({ kind: "motebit" }, "virtual_browser", {
      taskStepNarration: "   ",
      currentUrl: "https://apple.com",
    });
    if (cell?.kind !== "motebit-narration") throw new Error("wrong cell kind");
    expect(cell.narration).toBeNull();
  });

  it("collapses narration to null when missing", () => {
    const cell = dispatchSlabChrome({ kind: "motebit" }, "virtual_browser", {
      currentUrl: "https://apple.com",
    });
    if (cell?.kind !== "motebit-narration") throw new Error("wrong cell kind");
    expect(cell.narration).toBeNull();
  });
});

describe("formatUrlHostForChip", () => {
  it("strips scheme + www. prefix", () => {
    expect(formatUrlHostForChip("https://www.apple.com/iphone")).toBe("apple.com");
    expect(formatUrlHostForChip("https://apple.com")).toBe("apple.com");
    expect(formatUrlHostForChip("http://www.example.org/path?q=1")).toBe("example.org");
  });

  it("falls back to scheme-stripped raw URL on parse failure", () => {
    expect(formatUrlHostForChip("not a url")).toBe("not a url");
    expect(formatUrlHostForChip("apple.com/iphone")).toBe("apple.com/iphone");
  });
});

describe("renderCellToActivity — spatial HUD render adapter", () => {
  it("null cell → null activity (calm default)", () => {
    expect(renderCellToActivity(null)).toBeNull();
  });

  it("motebit-narration with both narration + URL → narration · host", () => {
    expect(
      renderCellToActivity({
        kind: "motebit-narration",
        narration: "Reading the page",
        currentUrl: "https://apple.com",
      }),
    ).toBe("Reading the page · apple.com");
  });

  it("motebit-narration with narration only → narration alone", () => {
    expect(
      renderCellToActivity({
        kind: "motebit-narration",
        narration: "Considering the trade-offs",
        currentUrl: null,
      }),
    ).toBe("Considering the trade-offs");
  });

  it("motebit-narration with URL only → host alone (page presence, no claimed action)", () => {
    expect(
      renderCellToActivity({
        kind: "motebit-narration",
        narration: null,
        currentUrl: "https://www.example.org/path",
      }),
    ).toBe("example.org");
  });

  it("motebit-narration empty (no narration, no URL) → null (register recedes)", () => {
    expect(
      renderCellToActivity({
        kind: "motebit-narration",
        narration: null,
        currentUrl: null,
      }),
    ).toBeNull();
  });

  it("user-cobrowse with URL → watching · host", () => {
    expect(
      renderCellToActivity({
        kind: "user-cobrowse",
        currentUrl: "https://apple.com",
      }),
    ).toBe("watching · apple.com");
  });

  it("user-cobrowse without URL → 'watching' alone", () => {
    expect(
      renderCellToActivity({
        kind: "user-cobrowse",
        currentUrl: null,
      }),
    ).toBe("watching");
  });

  it("handoff-pending → 'asks to drive' (doctrine §Spatial-as-endgame validation)", () => {
    expect(
      renderCellToActivity({
        kind: "handoff-pending",
        current: "user",
        requesting: "motebit",
      }),
    ).toBe("asks to drive");
  });

  it("paused → 'paused' (held register, no movement)", () => {
    expect(
      renderCellToActivity({
        kind: "paused",
        previousDriver: "motebit",
      }),
    ).toBe("paused");
  });
});

describe("dispatchSlabChrome × renderCellToActivity — end-to-end", () => {
  // The dispatcher + the spatial adapter compose into the spatial
  // render. End-to-end tests prove the matrix translates to a
  // chromeless surface (the doctrine's spatial-as-endgame
  // validation) without semantic loss.
  it("motebit × virtual_browser + task_step_narration → activity label = narration · host", () => {
    const cell = dispatchSlabChrome({ kind: "motebit" }, "virtual_browser", {
      taskStepNarration: "Reading the page",
      currentUrl: "https://apple.com",
    });
    expect(renderCellToActivity(cell)).toBe("Reading the page · apple.com");
  });

  it("motebit × mind (deferred column) → cell null → activity null", () => {
    const cell = dispatchSlabChrome({ kind: "motebit" }, "mind", {
      taskStepNarration: "Considering",
    });
    expect(cell).toBeNull();
    expect(renderCellToActivity(cell)).toBeNull();
  });

  it("user × virtual_browser + URL → activity = watching · host", () => {
    const cell = dispatchSlabChrome({ kind: "user" }, "virtual_browser", {
      currentUrl: "https://apple.com",
    });
    expect(renderCellToActivity(cell)).toBe("watching · apple.com");
  });
});
