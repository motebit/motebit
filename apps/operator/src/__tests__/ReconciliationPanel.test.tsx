import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { ReconciliationPanel } from "../components/ReconciliationPanel";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function mockReconciliation(body: unknown, status = 200) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

describe("ReconciliationPanel", () => {
  it("renders the consistent state in green when ledger is clean", async () => {
    mockReconciliation({ consistent: true, errors: [] });
    render(React.createElement(ReconciliationPanel));
    await waitFor(() => {
      expect(screen.getByText("✓ consistent")).toBeTruthy();
    });
    expect(screen.getByText("All invariants hold.")).toBeTruthy();
  });

  it("renders the inconsistent state with violations listed", async () => {
    mockReconciliation({
      consistent: false,
      errors: [
        "Balance equation violated: net 100 != balance sum 99",
        "Negative balance: agent abc has balance -50",
      ],
    });
    render(React.createElement(ReconciliationPanel));
    await waitFor(() => {
      expect(screen.getByText("✗ inconsistent")).toBeTruthy();
    });
    expect(screen.getByText(/Balance equation violated/)).toBeTruthy();
    expect(screen.getByText(/Negative balance/)).toBeTruthy();
  });

  it("renders error state on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    render(React.createElement(ReconciliationPanel));
    await waitFor(() => {
      expect(screen.getByText(/Error: network down|\(no data\)/)).toBeTruthy();
    });
  });
});
