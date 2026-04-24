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

  it("rests web_search + read_file as tool_result (working material, not a browser viewport)", () => {
    // web_search isn't the virtual_browser embodiment (it's a
    // results pane, not a page); it's working material. read_file
    // is the motebit's eye on a local file.
    expect(toolPolicy("web_search").endState).toBe("rest");
    expect(toolPolicy("web_search").mode).toBe("tool_result");
    expect(toolPolicy("read_file").endState).toBe("rest");
    expect(toolPolicy("read_file").mode).toBe("tool_result");
  });

  it("falls back to dissolve + tool_call + tool_result for unknown tools", () => {
    // The safe floor: unknown tools get a generic card that ripples
    // away on completion — no stale plumbing left on the slab.
    const p = toolPolicy("some-tool-not-in-the-registry");
    expect(p.kind).toBe("tool_call");
    expect(p.mode).toBe("tool_result");
    expect(p.endState).toBe("dissolve");
  });
});
