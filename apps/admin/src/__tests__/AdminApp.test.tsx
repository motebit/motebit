import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { AdminApp } from "../AdminApp";
import { TrustMode, BatteryMode } from "@motebit/sdk";

const originalFetch = globalThis.fetch;

const mockState = {
  motebit_id: "default-motebit",
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
  motebit_id: "default-motebit",
  memories: [
    {
      node_id: "n1",
      motebit_id: "default-motebit",
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

const mockGoals = {
  motebit_id: "default-motebit",
  goals: [
    {
      goal_id: "g1",
      motebit_id: "default-motebit",
      prompt: "Check email every hour",
      interval_ms: 3600000,
      last_run_at: Date.now() - 60000,
      enabled: true,
      created_at: Date.now() - 86400000,
      mode: "recurring",
      status: "active",
      parent_goal_id: null,
      max_retries: 3,
      consecutive_failures: 0,
    },
  ],
};

const mockConversations = {
  motebit_id: "default-motebit",
  conversations: [
    {
      conversation_id: "c1",
      motebit_id: "default-motebit",
      started_at: Date.now() - 3600000,
      last_active_at: Date.now() - 60000,
      title: "Test conversation",
      summary: null,
      message_count: 5,
    },
  ],
};

const mockDevices = {
  motebit_id: "default-motebit",
  devices: [
    {
      device_id: "d1-abcdef123456",
      motebit_id: "default-motebit",
      device_name: "MacBook Pro",
      public_key: "abcdef0123456789abcdef0123456789",
      registered_at: Date.now() - 86400000,
      last_seen_at: Date.now() - 300000,
    },
  ],
};

const mockPlans = {
  motebit_id: "default-motebit",
  plans: [
    {
      plan_id: "p1",
      goal_id: "g1",
      motebit_id: "default-motebit",
      title: "Check email plan",
      status: "active",
      created_at: Date.now() - 60000,
      updated_at: Date.now(),
      current_step_index: 1,
      total_steps: 3,
      steps: [
        {
          step_id: "s1",
          plan_id: "p1",
          ordinal: 0,
          description: "Open inbox",
          prompt: "Open the email inbox",
          depends_on: [],
          optional: false,
          status: "completed",
          result_summary: "Inbox opened successfully",
          error_message: null,
          tool_calls_made: 1,
          started_at: Date.now() - 50000,
          completed_at: Date.now() - 40000,
          retry_count: 0,
        },
        {
          step_id: "s2",
          plan_id: "p1",
          ordinal: 1,
          description: "Read unread messages",
          prompt: "Read unread messages",
          depends_on: ["s1"],
          optional: false,
          status: "running",
          result_summary: null,
          error_message: null,
          tool_calls_made: 2,
          started_at: Date.now() - 30000,
          completed_at: null,
          retry_count: 0,
        },
        {
          step_id: "s3",
          plan_id: "p1",
          ordinal: 2,
          description: "Summarize findings",
          prompt: "Summarize the email findings",
          depends_on: ["s2"],
          optional: false,
          status: "pending",
          result_summary: null,
          error_message: null,
          tool_calls_made: 0,
          started_at: null,
          completed_at: null,
          retry_count: 0,
        },
      ],
    },
  ],
};

const mockEvents = {
  motebit_id: "default-motebit",
  events: [
    {
      event_id: "e1",
      motebit_id: "default-motebit",
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
  globalThis.fetch = vi.fn().mockImplementation((url: string): Promise<Partial<Response>> => {
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
    if (url.includes("/api/v1/audit/")) {
      return Promise.resolve({
        ok: true, status: 200, statusText: "OK",
        json: () => Promise.resolve({ motebit_id: "default-motebit", entries: [] }),
        text: () => Promise.resolve(JSON.stringify({ motebit_id: "default-motebit", entries: [] })),
      });
    }
    if (url.includes("/api/v1/goals/")) {
      return Promise.resolve({
        ok: true, status: 200, statusText: "OK",
        json: () => Promise.resolve(mockGoals),
        text: () => Promise.resolve(JSON.stringify(mockGoals)),
      });
    }
    if (url.includes("/api/v1/conversations/") && url.includes("/messages")) {
      return Promise.resolve({
        ok: true, status: 200, statusText: "OK",
        json: () => Promise.resolve({ motebit_id: "default-motebit", conversation_id: "c1", messages: [] }),
        text: () => Promise.resolve(JSON.stringify({ motebit_id: "default-motebit", conversation_id: "c1", messages: [] })),
      });
    }
    if (url.includes("/api/v1/conversations/")) {
      return Promise.resolve({
        ok: true, status: 200, statusText: "OK",
        json: () => Promise.resolve(mockConversations),
        text: () => Promise.resolve(JSON.stringify(mockConversations)),
      });
    }
    if (url.includes("/api/v1/plans/")) {
      return Promise.resolve({
        ok: true, status: 200, statusText: "OK",
        json: () => Promise.resolve(mockPlans),
        text: () => Promise.resolve(JSON.stringify(mockPlans)),
      });
    }
    if (url.includes("/api/v1/devices/")) {
      return Promise.resolve({
        ok: true, status: 200, statusText: "OK",
        json: () => Promise.resolve(mockDevices),
        text: () => Promise.resolve(JSON.stringify(mockDevices)),
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
    expect(screen.getByText("Motebit Admin")).toBeTruthy();
  });

  it("shows all 9 navigation buttons", () => {
    setupFailingFetch();
    render(React.createElement(AdminApp));
    expect(screen.getByText("state")).toBeTruthy();
    expect(screen.getByText("memory")).toBeTruthy();
    expect(screen.getByText("behavior")).toBeTruthy();
    expect(screen.getByText("events")).toBeTruthy();
    expect(screen.getByText("audit")).toBeTruthy();
    expect(screen.getByText("goals")).toBeTruthy();
    expect(screen.getByText("plans")).toBeTruthy();
    expect(screen.getByText("conversations")).toBeTruthy();
    expect(screen.getByText("devices")).toBeTruthy();
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

  it("switches to goals panel on click", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    fireEvent.click(screen.getByText("goals"));

    await waitFor(() => {
      expect(screen.getByText("Goals")).toBeTruthy();
    });
  });

  it("shows goal data in goals panel", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    fireEvent.click(screen.getByText("goals"));

    await waitFor(() => {
      expect(screen.getByText("Check email every hour")).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByText("1 goals total")).toBeTruthy();
    });
  });

  it("switches to conversations panel on click", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    fireEvent.click(screen.getByText("conversations"));

    await waitFor(() => {
      expect(screen.getByText("Conversations")).toBeTruthy();
    });
  });

  it("shows conversation data in conversations panel", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    fireEvent.click(screen.getByText("conversations"));

    await waitFor(() => {
      expect(screen.getByText("Test conversation")).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByText("5 messages")).toBeTruthy();
    });
  });

  it("switches to devices panel on click", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    fireEvent.click(screen.getByText("devices"));

    await waitFor(() => {
      expect(screen.getByText("Devices")).toBeTruthy();
    });
  });

  it("shows device data in devices panel", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    fireEvent.click(screen.getByText("devices"));

    await waitFor(() => {
      expect(screen.getByText("MacBook Pro")).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByText("1 devices registered")).toBeTruthy();
    });
  });

  it("switches to plans panel on click", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    fireEvent.click(screen.getByText("plans"));

    await waitFor(() => {
      expect(screen.getByText("Plans")).toBeTruthy();
    });
  });

  it("shows plan data in plans panel", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    fireEvent.click(screen.getByText("plans"));

    await waitFor(() => {
      expect(screen.getByText("Check email plan")).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByText("1 plans total")).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.getByText("1/3 steps")).toBeTruthy();
    });
  });

  it("expands plan to show steps", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    fireEvent.click(screen.getByText("plans"));

    await waitFor(() => {
      expect(screen.getByText("Check email plan")).toBeTruthy();
    });

    // Click on the plan header to expand
    fireEvent.click(screen.getByText("Check email plan"));

    await waitFor(() => {
      expect(screen.getByText("Open inbox")).toBeTruthy();
      expect(screen.getByText("Read unread messages")).toBeTruthy();
      expect(screen.getByText("Summarize findings")).toBeTruthy();
    });
  });

  it("shows step status badges and metadata", async () => {
    setupFetchMock();
    render(React.createElement(AdminApp));

    fireEvent.click(screen.getByText("plans"));

    await waitFor(() => {
      expect(screen.getByText("Check email plan")).toBeTruthy();
    });

    // Expand the plan
    fireEvent.click(screen.getByText("Check email plan"));

    await waitFor(() => {
      expect(screen.getByText("completed")).toBeTruthy();
      expect(screen.getByText("running")).toBeTruthy();
      expect(screen.getByText("pending")).toBeTruthy();
    });

    // Check result summary from completed step
    await waitFor(() => {
      expect(screen.getByText("Inbox opened successfully")).toBeTruthy();
    });
  });
});
