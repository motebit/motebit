import { describe, it, expect } from "vitest";
import { renderModeRow } from "../mode-render.js";

// eslint-disable-next-line no-control-regex -- stripping ANSI is the point
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderModeRow", () => {
  it("renders model · provider as one dim rule line", () => {
    const row = plain(renderModeRow({ model: "claude-opus-4-6", provider: "anthropic" }));
    expect(row).toBe("  ── claude-opus-4-6 · anthropic");
  });

  it("attached mode names the coordinator", () => {
    const row = plain(renderModeRow({ attachedPid: 4211 }));
    expect(row).toBe("  ── attached · coordinator pid 4211");
  });

  it("omits missing parts without stray separators", () => {
    const row = plain(renderModeRow({ model: "llama3.2" }));
    expect(row).toBe("  ── llama3.2");
  });
});
