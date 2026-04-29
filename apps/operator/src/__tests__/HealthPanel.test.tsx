import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { HealthPanel } from "../components/HealthPanel";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function mockHealth(body: unknown) {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response);
}

const ZERO_SUMMARY = {
  motebits: { total_registered: 0, active_24h: 0, active_7d: 0, active_30d: 0 },
  federation: {
    peer_count: 0,
    active_peers: 0,
    suspended_peers: 0,
    federation_settlements_7d: 0,
    federation_volume_7d_micro: 0,
  },
  tasks: {
    settlements_7d: 0,
    settlements_30d: 0,
    volume_7d_micro: 0,
    volume_30d_micro: 0,
    fees_7d_micro: 0,
    fees_30d_micro: 0,
  },
  generated_at: Date.now(),
};

describe("HealthPanel", () => {
  it("renders empty-relay state with the partnership-not-code signal", async () => {
    mockHealth(ZERO_SUMMARY);
    render(React.createElement(HealthPanel));
    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "Health" })).toBeTruthy();
    });
    // Headline numbers
    expect(screen.getAllByText("0").length).toBeGreaterThan(5);
    // The signal text — the whole point of the panel
    expect(
      screen.getByText(
        /Signal: zero motebit activity in 30d.*next architectural pick is partnership/,
      ),
    ).toBeTruthy();
  });

  it("renders active-relay state without the partnership signal", async () => {
    mockHealth({
      ...ZERO_SUMMARY,
      motebits: {
        total_registered: 12,
        active_24h: 3,
        active_7d: 7,
        active_30d: 12,
      },
      federation: {
        peer_count: 4,
        active_peers: 3,
        suspended_peers: 1,
        federation_settlements_7d: 5,
        federation_volume_7d_micro: 1_500_000,
      },
      tasks: {
        settlements_7d: 18,
        settlements_30d: 65,
        volume_7d_micro: 4_200_000,
        volume_30d_micro: 15_800_000,
        fees_7d_micro: 210_000,
        fees_30d_micro: 790_000,
      },
    });
    render(React.createElement(HealthPanel));
    await waitFor(() => {
      expect(screen.getByText("3 / 4")).toBeTruthy(); // active_peers / peer_count is unique
    });
    expect(screen.getByText("18 / 65")).toBeTruthy(); // settlements 7d / 30d
    expect(screen.getAllByText("12").length).toBeGreaterThanOrEqual(2); // total + active_30d
    // Partnership signal MUST NOT appear when there's real activity
    expect(screen.queryByText(/Signal: zero motebit activity/)).toBeNull();
  });

  it("renders error state on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("relay unreachable"));
    render(React.createElement(HealthPanel));
    await waitFor(() => {
      expect(screen.getByText(/Error: relay unreachable|\(no data\)/)).toBeTruthy();
    });
  });
});
