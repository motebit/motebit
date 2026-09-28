import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, fireEvent } from "@testing-library/react";
import { WithdrawalsPanel } from "../components/WithdrawalsPanel";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

function response(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as Response;
}

function mockJson(body: unknown, status = 200): void {
  globalThis.fetch = vi.fn().mockResolvedValue(response(body, status));
}

/**
 * Route fetch by method + path suffix. The pending listing is read from a
 * mutable `state.listing` so a test can change what the post-action refresh
 * sees. Every call is recorded.
 */
function routeFetch(
  state: { listing: unknown },
  posts: Record<string, { body: unknown; status?: number }>,
): ReturnType<typeof vi.fn> {
  const fn = vi.fn((url: string, init?: RequestInit) => {
    if ((init?.method ?? "GET") === "GET" && url.endsWith("/api/v1/admin/withdrawals/pending")) {
      return Promise.resolve(response(state.listing));
    }
    for (const [suffix, r] of Object.entries(posts)) {
      if (url.endsWith(suffix)) return Promise.resolve(response(r.body, r.status ?? 200));
    }
    return Promise.resolve(response({ error: "unrouted" }, 500));
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

const ONE = {
  withdrawal_id: "wd_abcdef012345",
  motebit_id: "mot_0123456789ab",
  // Decimal USD: the relay's admin listing converts from micro-units.
  amount: 2.5,
  destination: "0xdeadbeefcafef00dbabe",
  requested_at: Date.UTC(2026, 6, 24, 12, 0, 0),
  status: "pending",
};

const MIN_AGE = 15 * 60 * 1000;

function processing(claimedAgoMs: number): typeof ONE & { claimed_at: number } {
  return {
    ...ONE,
    withdrawal_id: "wd_processing01",
    status: "processing",
    claimed_at: Date.now() - claimedAgoMs,
  };
}

describe("WithdrawalsPanel", () => {
  it("renders the pending-withdrawals table when the queue has entries", async () => {
    mockJson({ withdrawals: [ONE] });
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("1 pending withdrawal(s)")).toBeTruthy());
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
    mockJson({ withdrawals: [] });
    fireEvent.click(screen.getByText("complete"));
    await waitFor(() => expect(screen.getByText("(queue is empty)")).toBeTruthy());
    prompt.mockRestore();
  });

  it("is a no-op when the operator cancels the complete prompt", async () => {
    mockJson({ withdrawals: [ONE] });
    const prompt = vi.spyOn(window, "prompt").mockReturnValue(null);
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("complete")).toBeTruthy());
    fireEvent.click(screen.getByText("complete"));
    expect(screen.getByText("1 pending withdrawal(s)")).toBeTruthy();
    prompt.mockRestore();
  });
});

describe("WithdrawalsPanel — payout in flight (#921)", () => {
  it("shows a processing row as 'payout in flight' with its claim age, and offers no complete/fail", async () => {
    mockJson({ withdrawals: [processing(3 * 60_000)], reconcile_min_age_ms: MIN_AGE });
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("payout in flight")).toBeTruthy());
    expect(screen.getByText("claimed 3m ago")).toBeTruthy();
    expect(screen.getByText(/1 payout\(s\) in flight/)).toBeTruthy();
    expect(screen.queryByText("complete")).toBeNull();
    expect(screen.queryByText("fail")).toBeNull();
  });

  it("keeps reconcile disabled until the claim is older than the relay's window", async () => {
    mockJson({ withdrawals: [processing(3 * 60_000)], reconcile_min_age_ms: MIN_AGE });
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("reconcile")).toBeTruthy());
    const btn = screen.getByText("reconcile") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/Reconcile opens in 1[12]m/);
  });

  it("uses the window the relay reports, not a hard-coded one", async () => {
    mockJson({ withdrawals: [processing(3 * 60_000)], reconcile_min_age_ms: 60_000 });
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("reconcile")).toBeTruthy());
    expect((screen.getByText("reconcile") as HTMLButtonElement).disabled).toBe(false);
  });

  it("reconciles not_paid: attestation required, POSTs the reconcile route, then refreshes", async () => {
    const state: { listing: unknown } = {
      listing: { withdrawals: [processing(20 * 60_000)], reconcile_min_age_ms: MIN_AGE },
    };
    const fetchMock = routeFetch(state, {
      "/api/v1/admin/withdrawals/wd_processing01/reconcile": {
        body: { withdrawal_id: "wd_processing01", status: "failed", refunded: true },
      },
    });
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("reconcile")).toBeTruthy());
    fireEvent.click(screen.getByText("reconcile"));

    const submit = screen.getByText("submit reconcile") as HTMLButtonElement;
    expect(submit.disabled, "no attestation, no submit").toBe(true);
    fireEvent.change(screen.getByLabelText("attestation"), {
      target: { value: "no transfer from treasury to the destination since the claim" },
    });
    expect(submit.disabled).toBe(false);

    state.listing = { withdrawals: [], reconcile_min_age_ms: MIN_AGE };
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText("(queue is empty)")).toBeTruthy());

    const post = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/reconcile"));
    expect(post).toBeDefined();
    const init = post![1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      outcome: "not_paid",
      attestation: "no transfer from treasury to the destination since the claim",
    });
    expect(screen.queryByText("submit reconcile"), "the form closes silently").toBeNull();
  });

  it("reconciles paid only with a payout reference", async () => {
    const state: { listing: unknown } = {
      listing: { withdrawals: [processing(20 * 60_000)], reconcile_min_age_ms: MIN_AGE },
    };
    const fetchMock = routeFetch(state, {
      "/reconcile": { body: { withdrawal_id: "wd_processing01", status: "completed" } },
    });
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("reconcile")).toBeTruthy());
    fireEvent.click(screen.getByText("reconcile"));
    fireEvent.change(screen.getByLabelText("outcome"), { target: { value: "paid" } });
    fireEvent.change(screen.getByLabelText("attestation"), {
      target: { value: "explorer shows it" },
    });
    const submit = screen.getByText("submit reconcile") as HTMLButtonElement;
    expect(submit.disabled, "paid needs a payout reference").toBe(true);
    fireEvent.change(screen.getByLabelText("payout reference"), { target: { value: "sig-1" } });
    expect(submit.disabled).toBe(false);
    state.listing = { withdrawals: [], reconcile_min_age_ms: MIN_AGE };
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByText("(queue is empty)")).toBeTruthy());
    const post = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/reconcile"));
    expect(JSON.parse((post![1] as RequestInit).body as string)).toEqual({
      outcome: "paid",
      attestation: "explorer shows it",
      payout_reference: "sig-1",
    });
  });

  it("a 409 payout-in-flight on fail is a state, not an error: the row re-reads as in flight", async () => {
    const state: { listing: unknown } = {
      listing: { withdrawals: [ONE], reconcile_min_age_ms: MIN_AGE },
    };
    routeFetch(state, {
      "/fail": {
        status: 409,
        body: {
          error: "WITHDRAWAL_PAYOUT_IN_FLIGHT",
          message: "payout in flight — reconcile after the send resolves",
        },
      },
    });
    vi.spyOn(window, "prompt").mockReturnValue("operator gave up");
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("fail")).toBeTruthy());
    // Between the listing and the click, a payout claimed the row.
    state.listing = {
      withdrawals: [{ ...ONE, status: "processing", claimed_at: Date.now() }],
      reconcile_min_age_ms: MIN_AGE,
    };
    fireEvent.click(screen.getByText("fail"));
    await waitFor(() => expect(screen.getByText("payout in flight")).toBeTruthy());
    expect(screen.queryByText(/^Error:/)).toBeNull();
  });

  it("a 409 payout-in-flight on reconcile says inline when the door opens, keeping the form and its attestation", async () => {
    const state: { listing: unknown } = {
      listing: { withdrawals: [processing(20 * 60_000)], reconcile_min_age_ms: MIN_AGE },
    };
    routeFetch(state, {
      "/reconcile": {
        status: 409,
        body: {
          error: "WITHDRAWAL_PAYOUT_IN_FLIGHT",
          reconcile_opens_at: Date.now() + 42 * 60_000 + 30_000,
        },
      },
    });
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("reconcile")).toBeTruthy());
    fireEvent.click(screen.getByText("reconcile"));
    fireEvent.change(screen.getByLabelText("attestation"), { target: { value: "checked sig" } });
    fireEvent.click(screen.getByText("submit reconcile"));
    await waitFor(() =>
      expect(screen.getByText(/payout still in flight — opens in 4[12]m/)).toBeTruthy(),
    );
    expect(screen.queryByText(/^Error:/)).toBeNull();
    expect(screen.getByText("submit reconcile")).toBeTruthy();
    expect((screen.getByLabelText("attestation") as HTMLTextAreaElement).value).toBe("checked sig");
  });

  it("gates on the relay's per-row reconcile_opens_at, not claim + floor", async () => {
    mockJson({
      withdrawals: [
        // Claimed 20 minutes ago — past the 15-minute floor — but an x402
        // authorization that stays submittable for another 45 minutes.
        { ...processing(20 * 60_000), reconcile_opens_at: Date.now() + 45 * 60_000 },
      ],
      reconcile_min_age_ms: MIN_AGE,
    });
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("reconcile")).toBeTruthy());
    const btn = screen.getByText("reconcile") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toMatch(/Reconcile opens in 4[45]m — the payout may still land/);
  });

  it("a payout the relay is still handling is never reconcilable from the panel", async () => {
    mockJson({
      withdrawals: [
        { ...processing(3 * 60 * 60_000), reconcile_opens_at: null, payout_in_flight_here: true },
      ],
      reconcile_min_age_ms: MIN_AGE,
    });
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("reconcile")).toBeTruthy());
    const btn = screen.getByText("reconcile") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe("The relay is still handling this payout");
  });
});

describe("WithdrawalsPanel — rows that predate claim-before-send (#921)", () => {
  it("warns on a pending row whose payout may have been attempted, and in the fail confirmation", async () => {
    mockJson({
      withdrawals: [{ ...ONE, payout_may_have_been_attempted: true }],
      reconcile_min_age_ms: MIN_AGE,
    });
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("reason");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() =>
      expect(
        screen.getByText("a payout may have been attempted — check the chain before failing"),
      ).toBeTruthy(),
    );
    expect(screen.getByText(/1 withdrawal\(s\) predate claim-before-send/)).toBeTruthy();
    fireEvent.click(screen.getByText("fail"));
    expect(prompt).toHaveBeenCalled();
    expect(confirm.mock.calls[0]![0]).toMatch(/check the chain before failing/);
  });

  it("shows no warning on an ordinary pending row", async () => {
    mockJson({ withdrawals: [ONE], reconcile_min_age_ms: MIN_AGE });
    render(React.createElement(WithdrawalsPanel));
    await waitFor(() => expect(screen.getByText("1 pending withdrawal(s)")).toBeTruthy());
    expect(screen.queryByText(/check the chain before failing/)).toBeNull();
  });
});
