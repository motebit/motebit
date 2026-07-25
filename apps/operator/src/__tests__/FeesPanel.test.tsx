import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { FeesPanel } from "../components/FeesPanel";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function mockJson(body: unknown, status = 200): void {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

describe("FeesPanel", () => {
  it("renders the stat grid + rail/period tables when there is fee history", async () => {
    mockJson({
      total_collected_micro: 12_345_678,
      total_collected_currency: "USDC",
      fee_rate: 0.05,
      sample_window_days: 30,
      by_rail: [{ rail: "solana", collected_micro: 12_345_678 }],
      by_period: [
        {
          period_start: Date.UTC(2026, 6, 1),
          period_end: Date.UTC(2026, 6, 8),
          collected_micro: 5_000_000,
        },
      ],
    });
    render(React.createElement(FeesPanel));
    await waitFor(() => expect(screen.getByText("12.345678 USDC")).toBeTruthy());
    expect(screen.getByText("5.00%")).toBeTruthy(); // fee_rate formatting
    expect(screen.getByText("30d")).toBeTruthy();
    expect(screen.getByText("solana")).toBeTruthy(); // by_rail row
    expect(screen.getByText("2026-07-01 → 2026-07-08")).toBeTruthy(); // formatRange range branch
  });

  it("renders empty-history states when there is no fee data", async () => {
    mockJson({
      total_collected_micro: 0,
      total_collected_currency: "USDC",
      fee_rate: 0.05,
      sample_window_days: 30,
      by_rail: [],
      by_period: [],
    });
    render(React.createElement(FeesPanel));
    await waitFor(() => expect(screen.getByText("(no fee history)")).toBeTruthy());
    expect(screen.getByText("(no period history)")).toBeTruthy();
  });

  it("surfaces a fetch error honestly", async () => {
    mockJson({ error: "boom" }, 500);
    render(React.createElement(FeesPanel));
    await waitFor(() => expect(screen.getByText(/^Error:/)).toBeTruthy());
  });
});
