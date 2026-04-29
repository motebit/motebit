import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { FreezePanel } from "../components/FreezePanel";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function mockFreezeStatus(body: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

describe("FreezePanel", () => {
  it("renders active state with the freeze button when relay is unfrozen", async () => {
    mockFreezeStatus({ frozen: false, reason: null });
    render(React.createElement(FreezePanel));
    await waitFor(() => {
      expect(screen.getByText("✓ active")).toBeTruthy();
    });
    expect(screen.getByText(/freeze \(suspend writes\)/)).toBeTruthy();
  });

  it("renders frozen state with the unfreeze button + reason when relay is frozen", async () => {
    mockFreezeStatus({ frozen: true, reason: "incident-2026-04-28" });
    render(React.createElement(FreezePanel));
    await waitFor(() => {
      expect(screen.getByText("✗ FROZEN")).toBeTruthy();
    });
    expect(screen.getByText("incident-2026-04-28")).toBeTruthy();
    expect(screen.getByText(/unfreeze \(resume writes\)/)).toBeTruthy();
  });

  it("renders error state when fetch fails", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("relay unreachable"));
    render(React.createElement(FreezePanel));
    // Even on fetch failure the panel renders (default frozen=false fallback);
    // the error message surfaces below.
    await waitFor(() => {
      expect(screen.getByText(/Error:/)).toBeTruthy();
    });
  });
});
