import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup } from "@testing-library/react";
import { CredentialAnchoringPanel } from "../components/CredentialAnchoringPanel";

const originalFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

function mockAnchoringResponse(overrides: Record<string, unknown> = {}) {
  return {
    stats: {
      total_batches: 2,
      confirmed_batches: 1,
      total_credentials_anchored: 10,
      pending_credentials: 3,
    },
    batches: [
      {
        batch_id: "batch-001-abcdef",
        relay_id: "relay-123",
        merkle_root: "a".repeat(64),
        leaf_count: 5,
        first_issued_at: Date.now() - 3600000,
        last_issued_at: Date.now() - 1800000,
        signature: "sig1",
        anchor: {
          chain: "solana",
          network: "mainnet-beta",
          tx_hash: "tx" + "f".repeat(60),
          anchored_at: Date.now() - 600000,
        },
      },
      {
        batch_id: "batch-002-ghijkl",
        relay_id: "relay-123",
        merkle_root: "b".repeat(64),
        leaf_count: 5,
        first_issued_at: Date.now() - 600000,
        last_issued_at: Date.now() - 300000,
        signature: "sig2",
        anchor: null,
      },
    ],
    anchor_address: "SolanaAddress123456789",
    chain_enabled: true,
    ...overrides,
  };
}

describe("CredentialAnchoringPanel", () => {
  it("shows loading state initially", () => {
    // Never resolve fetch
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    render(React.createElement(CredentialAnchoringPanel));
    expect(screen.getByText("Credential Anchoring")).toBeTruthy();
    expect(screen.getByText(/Loading/)).toBeTruthy();
  });

  it("shows endpoint unreachable on fetch failure", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });

    render(React.createElement(CredentialAnchoringPanel));

    await waitFor(() => {
      expect(screen.getByText("Endpoint unreachable")).toBeTruthy();
    });
  });

  it("shows endpoint unreachable on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    render(React.createElement(CredentialAnchoringPanel));

    await waitFor(() => {
      expect(screen.getByText("Endpoint unreachable")).toBeTruthy();
    });
  });

  it("renders stats and batches on successful fetch", async () => {
    const data = mockAnchoringResponse();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    });

    render(React.createElement(CredentialAnchoringPanel));

    await waitFor(() => {
      expect(screen.getByText(/chain: enabled/)).toBeTruthy();
    });

    expect(screen.getByText(/batches: 2/)).toBeTruthy();
    expect(screen.getByText(/confirmed onchain: 1/)).toBeTruthy();
    expect(screen.getByText(/credentials anchored: 10/)).toBeTruthy();
    expect(screen.getByText(/pending: 3/)).toBeTruthy();
    expect(screen.getByText(/SolanaAddress123456789/)).toBeTruthy();
    expect(screen.getByText("2 batches")).toBeTruthy();
  });

  it("renders confirmed and signed status badges", async () => {
    const data = mockAnchoringResponse();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    });

    render(React.createElement(CredentialAnchoringPanel));

    await waitFor(() => {
      expect(screen.getByText("confirmed")).toBeTruthy();
      expect(screen.getByText("signed")).toBeTruthy();
    });
  });

  it("shows chain disabled when chain_enabled is false", async () => {
    const data = mockAnchoringResponse({ chain_enabled: false, anchor_address: null });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    });

    render(React.createElement(CredentialAnchoringPanel));

    await waitFor(() => {
      expect(screen.getByText(/chain: disabled/)).toBeTruthy();
    });
  });

  it("shows empty state when no batches exist", async () => {
    const data = mockAnchoringResponse({
      batches: [],
      stats: {
        total_batches: 0,
        confirmed_batches: 0,
        total_credentials_anchored: 0,
        pending_credentials: 0,
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    });

    render(React.createElement(CredentialAnchoringPanel));

    await waitFor(() => {
      expect(screen.getByText(/No batches yet/)).toBeTruthy();
    });

    expect(screen.getByText("0 batches")).toBeTruthy();
  });

  it("shows singular 'batch' text for exactly 1 batch", async () => {
    const data = mockAnchoringResponse({
      batches: [mockAnchoringResponse().batches[0]],
      stats: {
        total_batches: 1,
        confirmed_batches: 1,
        total_credentials_anchored: 5,
        pending_credentials: 0,
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    });

    render(React.createElement(CredentialAnchoringPanel));

    await waitFor(() => {
      expect(screen.getByText("1 batch")).toBeTruthy();
    });
  });
});
