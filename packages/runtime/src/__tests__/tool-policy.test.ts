import { describe, it, expect } from "vitest";
import { toolPolicy } from "../tool-policy";

describe("toolPolicy", () => {
  it("routes read_url / fetch_url to virtual_browser embodiment with fetch kind", () => {
    // Doctrine: motebit-computer.md §"Embodiment modes" — browsing an
    // isolated page is the virtual_browser embodiment, rendered as a
    // reader-view iframe (kind: "fetch").
    for (const name of ["read_url", "fetch_url"]) {
      const p = toolPolicy(name);
      expect(p.kind).toBe("fetch");
      expect(p.mode).toBe("virtual_browser");
      expect(p.endState).toBe("rest");
    }
  });

  it("routes memory-recall tools to mind embodiment with memory kind", () => {
    // Doctrine §"Mind": memory surfacing is internal reorganization
    // made visible. Not a tool_result; the motebit is remembering.
    for (const name of ["recall_memories", "search_memories"]) {
      const p = toolPolicy(name);
      expect(p.kind).toBe("memory");
      expect(p.mode).toBe("mind");
      expect(p.endState).toBe("rest");
    }
  });

  it("routes shell-family tools to shell kind with rest end-state", () => {
    // Shell output is working material — the motebit's terminal tab.
    for (const name of ["shell_exec", "bash", "shell", "exec", "run_command"]) {
      const p = toolPolicy(name);
      expect(p.kind).toBe("shell");
      expect(p.mode).toBe("tool_result");
      expect(p.endState).toBe("rest");
    }
  });

  it("projects web_search + read_file to the BAND — no body card for text the reply already carries", () => {
    // Witnessed 2026-09-13: a search opened a resting `tool_call`
    // card that rendered the raw result text under `WEB_SEARCH` and
    // outlived the answer — the third-person-label violation
    // (motebit-computer.md §"Not on the slab"). The band narrates
    // ("Searching …"); the reply carries what was found.
    for (const name of ["web_search", "read_file"]) {
      const p = toolPolicy(name);
      expect(p.projection).toBe("band");
      expect(p.endState).toBe("dissolve");
      expect(p.mode).toBe("tool_result");
    }
  });

  it("body projection is reserved for the eye with a viewport, the hand, the mind, and the peer", () => {
    for (const name of [
      "read_url",
      "fetch_url",
      "read_page",
      "computer",
      "shell_exec",
      "bash",
      "recall_memories",
      "delegate_to_agent",
    ]) {
      expect(toolPolicy(name).projection).toBe("body");
    }
  });

  it("routes delegate_to_agent to delegation kind with peer_viewport mode (detach end-state)", () => {
    // Doctrine: motebit-computer.md §"peer_viewport" — a signed
    // delegation receipt IS the proof; pinches off the slab as a
    // receipt artifact in the scene. The streaming pipeline opens
    // delegation slab items explicitly with the same triple
    // (motebit-runtime.ts:1518); this row is the safe-floor for any
    // future caller reaching the tool through the registry alone.
    const p = toolPolicy("delegate_to_agent");
    expect(p.kind).toBe("delegation");
    expect(p.mode).toBe("peer_viewport");
    expect(p.endState).toBe("detach");
  });

  it("routes computer to fetch kind with tool_result mode (rest end-state)", () => {
    // Doctrine: a computer-use screenshot is the page the motebit is
    // looking at — same fetch slab kind that read_url uses, so a
    // session that mixes navigation + screenshot stays on one card.
    // Mode is `tool_result` (not virtual_browser / desktop_drive)
    // because the policy registry is name-keyed and surface-blind;
    // the per-surface mode upgrade is deferred until a per-item
    // dispatcher hint exists.
    const p = toolPolicy("computer");
    expect(p.kind).toBe("fetch");
    expect(p.mode).toBe("tool_result");
    expect(p.endState).toBe("rest");
  });

  it("falls back to dissolve + tool_call + tool_result for unknown tools", () => {
    // The safe floor: unknown tools get a generic card that ripples
    // away on completion — no stale plumbing left on the slab.
    const p = toolPolicy("some-tool-not-in-the-registry");
    expect(p.kind).toBe("tool_call");
    expect(p.mode).toBe("tool_result");
    // …and never a body card: an unknown (e.g. MCP-imported) tool's
    // result is text the reply carries; a generic card would render
    // raw JSON under the tool's internal name.
    expect(p.projection).toBe("band");
    expect(p.endState).toBe("dissolve");
  });
});
