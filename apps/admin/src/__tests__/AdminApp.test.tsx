import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { AdminApp } from "../AdminApp";
import { TrustMode, BatteryMode } from "@mote/sdk";

const originalFetch = globalThis.fetch;

const mockState = {
  mote_id: "default-mote",
  state: {
    attention: 0.7,
    processing: 0.3,
    confidence: 0.8,
    affect_valence: 0.1,
    affect_arousal: 0.2,
    social_distance: 0.5,
    curiosity: 0.4,
    trust_mode: TrustMode.Guarded,
    battery_mode: BatteryMode.Normal,
  },
};

const mockMemory = {
  mote_id: "default-mote",
  memories: [
    {
      node_id: "n1",
      mote_id: "default-mote",
      content: "Test memory content",
      embedding: [0.1, 0.2],
      confidence: 0.9,
      sensitivity: "none",
      created_at: Date.now(),
      last_accessed: Date.now(),
      half_life: 86400000,
      tombstoned: false,
    },
  ],
  edges: [],
};

const mockEvents = {
  mote_id: "default-mote",
  events: [
    {
      event_id: "e1",
      mote_id: "default-mote",
      timestamp: Date.now(),
      event_type: "state_updated",
      payload: {},
      version_clock: 1,
      tombstoned: false,
    },
  ],
  after_clock: 0,
};

function setupFetchMock() {
  globalThis.fetch = vi.fn().mockImplementation((url: string) => {
    if (url.includes("/api/v1/state/")) {
      return Promise.resolve({
        ok: true, status: 200, statusText: "OK",
        json: () => Promise.resolve(mockState),
        text: () => Promise.resolve(JSON.stringify(mockState)),
      });
    }
    if (url.includes("/api/v1/memory/")) {
      return Promise.resolve({
        ok: true, status: 200, statusText: "OK",
        json: () => Promise.resolve(mockMemory),
        text: () => Promise.resolve(JSON.stringify(mockMemory)),
      });
    }
    if (url.includes("/api/v1/sync/")) {
      return Promise.resolve({
        ok: true, status: 200, statusText: "OK",
        json: () => Promise.resolve(mockEvents),
        text: () => Promise.resolve(JSON.stringify(mockEvents)),
      });
    }
    return Promise.reject(new Error(`Unexpected URL: ${url}`));
  });
}

function setupFailingFetch() {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
});

describe("AdminApp", () => {
  it("renders without crashing", () => {
    setupFailingFetch();
    render(React.createElement(AdminApp));
    expect(screen.getByText("Mote Admin")).toBeTruthy();
  });

  it("shows all 4 navigation buttons", () => {
    setupFailingFetch();
    render(React.createElement(AdminApp));
    expect(screen.getByText("state")).toBeTruthy();
    expect(screen.getByText("memory")).toBeTruthy();
    expect(screen.getByText("behavior")).toBeTruthy();
    expect(screen.getByText("events")).toBeTruthy();
  });

  it("shows state panel by default with fetched values", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    await waitFor(() => {
      expect(screen.getByText("State Vector")).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByText("0.7000")).toBeTruthy(); // attention
    });
  });

  it("shows Connected when fetch succeeds", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    await waitFor(() => {
      expect(screen.getByText("Connected")).toBeTruthy();
    });
  });

  it("shows Disconnected when fetch fails", async () => {
    setupFailingFetch();
    render(React.createElement(AdminApp));

    await waitFor(() => {
      expect(screen.getByText("Disconnected")).toBeTruthy();
    });
  });

  it("switches to memory panel on click", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    fireEvent.click(screen.getByText("memory"));

    await waitFor(() => {
      expect(screen.getByText("Memory Graph")).toBeTruthy();
    });
  });

  it("switches to behavior panel on click", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    fireEvent.click(screen.getByText("behavior"));

    await waitFor(() => {
      expect(screen.getByText("Behavior Cues")).toBeTruthy();
    });
  });

  it("switches to events panel on click", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    fireEvent.click(screen.getByText("events"));

    await waitFor(() => {
      expect(screen.getByText("Event Log")).toBeTruthy();
    });
  });
});
