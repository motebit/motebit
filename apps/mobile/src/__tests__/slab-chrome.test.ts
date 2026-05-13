/**
 * Mobile slab-chrome dispatcher — `f(controlState × embodimentMode)`.
 *
 * Sibling of `apps/web/src/__tests__/slab-chrome.test.ts`. Mobile's
 * dispatcher returns a pure cell description (not an HTMLElement),
 * so the tests assert the cell-shape rather than DOM queries — but
 * the matrix-shape and cell-routing invariants are the same.
 *
 * Coverage cells, paralleling PR 1's web tests:
 *
 *   - Matrix shape: every `virtual_browser` control state returns
 *     a cell; every deferred embodiment column returns null.
 *   - Cell routing: each control state maps to the right cell kind.
 *   - `motebit-narration` register: narration text appears,
 *     whitespace-only collapses, URL formats as host-only chip,
 *     missing URL leaves the chip out.
 *   - Cross-cell: narration never bleeds into non-`motebit` cells.
 *
 * Doctrine: `chrome-as-state-render.md` § "PR 1 scope" + § "PR 2
 * scope (mobile, this commit)."
 */

import { describe, it, expect } from "vitest";
import type { ControlState } from "@motebit/protocol";
import type { EmbodimentMode } from "@motebit/render-engine/spec";
import { dispatchSlabChrome, formatUrlHostForChip } from "../slab-chrome";

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

  it("returns null for deferred columns regardless of control state", () => {
    // Cobrowse-as-mode reshape: the `user × *` cells collapse for
    // embodiments the user doesn't drive (mind, tool_result,
    // peer_viewport). Mobile inherits the same matrix from web.
    expect(dispatchSlabChrome({ kind: "user" }, "mind")).toBeNull();
    expect(dispatchSlabChrome({ kind: "user" }, "peer_viewport")).toBeNull();
    expect(
      dispatchSlabChrome(
        { kind: "handoff_pending", current: "user", requesting: "motebit" },
        "shared_gaze",
      ),
    ).toBeNull();
    expect(
      dispatchSlabChrome({ kind: "paused", previousDriver: "user" }, "desktop_drive"),
    ).toBeNull();
  });
});

describe("dispatchSlabChrome — cell routing", () => {
  it("motebit × virtual_browser → motebit-narration cell", () => {
    const cell = dispatchSlabChrome({ kind: "motebit" }, "virtual_browser", {
      taskStepNarration: "Reading the page",
      currentUrl: "https://apple.com",
    });
    expect(cell?.kind).toBe("motebit-narration");
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
  it("surfaces task-step narration verbatim when non-empty", () => {
    const cell = dispatchSlabChrome({ kind: "motebit" }, "virtual_browser", {
      taskStepNarration: "Reading the page",
      currentUrl: "https://apple.com",
    });
    if (cell?.kind !== "motebit-narration") throw new Error("wrong cell kind");
    expect(cell.narration).toBe("Reading the page");
    expect(cell.currentUrl).toBe("https://apple.com");
  });

  it("collapses narration to null when missing", () => {
    const cell = dispatchSlabChrome({ kind: "motebit" }, "virtual_browser", {
      currentUrl: "https://apple.com",
    });
    if (cell?.kind !== "motebit-narration") throw new Error("wrong cell kind");
    expect(cell.narration).toBeNull();
    expect(cell.currentUrl).toBe("https://apple.com");
  });

  it("collapses whitespace-only narration to null — no spurious empty register", () => {
    const cell = dispatchSlabChrome({ kind: "motebit" }, "virtual_browser", {
      taskStepNarration: "   ",
      currentUrl: "https://apple.com",
    });
    if (cell?.kind !== "motebit-narration") throw new Error("wrong cell kind");
    expect(cell.narration).toBeNull();
  });

  it("trims surrounding whitespace before surfacing narration", () => {
    const cell = dispatchSlabChrome({ kind: "motebit" }, "virtual_browser", {
      taskStepNarration: "  Reading the page  ",
    });
    if (cell?.kind !== "motebit-narration") throw new Error("wrong cell kind");
    expect(cell.narration).toBe("Reading the page");
  });

  it("renders narration without a URL when currentUrl is missing", () => {
    const cell = dispatchSlabChrome({ kind: "motebit" }, "virtual_browser", {
      taskStepNarration: "Considering the trade-offs",
    });
    if (cell?.kind !== "motebit-narration") throw new Error("wrong cell kind");
    expect(cell.narration).toBe("Considering the trade-offs");
    expect(cell.currentUrl).toBeNull();
  });

  it("does NOT carry narration on non-motebit cells — narration is the motebit register's content", () => {
    const cellUser = dispatchSlabChrome({ kind: "user" }, "virtual_browser", {
      taskStepNarration: "Reading the page",
      currentUrl: "https://apple.com",
    });
    expect(cellUser?.kind).toBe("user-cobrowse");
    // The narration field doesn't exist on the user-cobrowse variant —
    // the cell type forbids it structurally, which is the doctrine's
    // "register is an information shape" line enforced at the type
    // level. Defense in depth: confirm the cell shape carries no
    // narration leak.
    expect(JSON.stringify(cellUser)).not.toContain("Reading the page");
  });
});

describe("formatUrlHostForChip — URL chip canonicalization", () => {
  it("strips scheme + www. prefix", () => {
    expect(formatUrlHostForChip("https://www.apple.com/iphone")).toBe("apple.com");
    expect(formatUrlHostForChip("https://apple.com")).toBe("apple.com");
    expect(formatUrlHostForChip("http://www.example.org/path?q=1")).toBe("example.org");
  });

  it("falls back to scheme-stripped raw URL on parse failure", () => {
    // `new URL()` throws on bare hostnames without scheme — chip
    // still renders a useful string rather than crashing the chrome.
    expect(formatUrlHostForChip("not a url")).toBe("not a url");
    expect(formatUrlHostForChip("apple.com/iphone")).toBe("apple.com/iphone");
  });

  it("never returns empty for a non-empty input", () => {
    // Defensive — the chip's role is "tether the narration to a
    // page motebit is reading." Empty chip text would break that
    // semantic and look like a render bug. Property-style guard.
    const samples = [
      "https://apple.com",
      "https://www.example.org/very/long/path",
      "ftp://example.org",
      "raw.string.no.scheme",
    ];
    for (const url of samples) {
      const out = formatUrlHostForChip(url);
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
