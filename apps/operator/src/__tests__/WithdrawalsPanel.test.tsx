import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { WithdrawalsPanel } from "../components/WithdrawalsPanel";

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

const ONE = {
  withdrawal_id: "wd_abcdef012345",
  motebit_id: "mot_0123456789ab",
  amount: 2_500_000,
  destination: "0xdeadbeefcafef00dbabe",
  requested_at: Date.UTC(2026, 6, 24, 12, 0, 0),
};

describe("WithdrawalsPanel", () => {
  it("renders the pending-withdrawals table when the queue has entries", async () => {
    mockJson({ withdrawals: [ONE] });
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("1 pending withdrawal(s)")).toBeTruthy());
    // Micro-amount formatting + truncated id columns exercised.
    expect(screen.getByText("2.500000")).toBeTruthy();
    expect(screen.getByText("complete")).toBeTruthy();
    expect(screen.getByText("fail")).toBeTruthy();
  });

  it("renders the empty state when the queue is clear", async () => {
    mockJson({ withdrawals: [] });
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("0 pending withdrawal(s)")).toBeTruthy());
    expect(screen.getByText("(queue is empty)")).toBeTruthy();
  });

  it("surfaces a fetch error honestly", async () => {
    mockJson({ error: "boom" }, 500);
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText(/^Error:/)).toBeTruthy());
  });

  it("completes a withdrawal via the action button (prompt → complete → refresh)", async () => {
    mockJson({ withdrawals: [ONE] });
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("rail-tx-123");
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("complete")).toBeTruthy());
    // On complete the panel POSTs then refreshes; make the refresh return empty.
    mockJson({ withdrawals: [] });
    fireEvent.click(screen.getByText("complete"));
    await waitFor(() => expect(screen.getByText("(queue is empty)")).toBeTruthy());
    prompt.mockRestore();
  });

  it("is a no-op when the operator cancels the complete prompt", async () => {
    mockJson({ withdrawals: [ONE] });
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null); // cancelled
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("complete")).toBeTruthy());
    fireEvent.click(screen.getByText("complete"));
    // The row stays; no crash, no state change.
    expect(screen.getByText("1 pending withdrawal(s)")).toBeTruthy();
    prompt.mockRestore();
  });
});
