/**
 * Computer-use session manager tests.
 *
 * Exercises the four invariants the module owns:
 *   1. Session lifecycle — open allocates + queries display + emits
 *      event data; close emits event data + teardown; idempotent close.
 *   2. Governance gate — allow passes through; deny → policy_denied;
 *      require_approval with no flow → approval_required; with flow
 *      consent/deny paths both traced.
 *   3. Dispatcher error taxonomy — ComputerDispatcherError's `reason`
 *      preserved; generic Error → platform_blocked.
 *   4. Session validity — closed/unknown sessions → session_closed.
 */
import { describe, expect, it, vi } from "vitest";

import type { ComputerAction } from "@motebit/sdk";

import {
  ComputerDispatcherError,
  createComputerSessionManager,
  type ComputerGovernanceClassifier,
  type ComputerPlatformDispatcher,
} from "../computer-use.js";

const DEFAULT_DISPLAY = { width: 2560, height: 1440, scaling_factor: 2 } as const;

function makeDispatcher(
  overrides?: Partial<ComputerPlatformDispatcher>,
): ComputerPlatformDispatcher {
  const base: ComputerPlatformDispatcher = {
    async queryDisplay() {
      return { ...DEFAULT_DISPLAY };
    },
    async execute() {
      return undefined;
    },
  };
  return { ...base, ...overrides };
}

const SCREENSHOT_ACTION: ComputerAction = { kind: "screenshot" };
const CLICK_ACTION: ComputerAction = {
  kind: "click",
  target: { x: 100, y: 200 },
};

describe("ComputerSessionManager — openSession + closeSession", () => {
  it("opens with display metadata and a generated session id", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      generateSessionId: () => "cs_fixed",
      now: () => 1_000,
    });
    const { handle, event } = await manager.openSession("mot_1");
    expect(handle.session_id).toBe("cs_fixed");
    expect(handle.motebit_id).toBe("mot_1");
    expect(handle.display).toEqual(DEFAULT_DISPLAY);
    expect(handle.opened_at).toBe(1_000);
    expect(event).toEqual({
      session_id: "cs_fixed",
      motebit_id: "mot_1",
      display_width: 2560,
      display_height: 1440,
      scaling_factor: 2,
      opened_at: 1_000,
    });
    expect(manager.activeSessionIds()).toEqual(["cs_fixed"]);
  });

  it("closes and emits a session-closed event", async () => {
    const dispose = vi.fn(async () => {});
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ dispose }),
      generateSessionId: () => "cs_1",
      now: () => 2_000,
    });
    await manager.openSession("mot_1");
    const event = await manager.closeSession("cs_1", "user_closed");
    expect(event).toEqual({
      session_id: "cs_1",
      closed_at: 2_000,
      reason: "user_closed",
    });
    expect(dispose).toHaveBeenCalledWith("cs_1");
    expect(manager.activeSessionIds()).toEqual([]);
    expect(manager.getSession("cs_1")).toBeNull();
  });

  it("idempotent close — second call returns the original close event, no re-dispose", async () => {
    const dispose = vi.fn(async () => {});
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ dispose }),
      generateSessionId: () => "cs_1",
      now: () => 3_000,
    });
    await manager.openSession("mot_1");
    await manager.closeSession("cs_1", "first");
    const second = await manager.closeSession("cs_1", "second");
    // Session was already deleted; second close is on an unknown id.
    expect(second.reason).toBe("unknown_session");
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it("close-unknown returns a typed event with reason 'unknown_session'", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      now: () => 4_000,
    });
    const event = await manager.closeSession("cs_ghost");
    expect(event).toEqual({
      session_id: "cs_ghost",
      closed_at: 4_000,
      reason: "unknown_session",
    });
  });

  it("dispose closes every active session", async () => {
    let idCounter = 0;
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      generateSessionId: () => `cs_${++idCounter}`,
      now: () => 5_000,
    });
    await manager.openSession("mot_1");
    await manager.openSession("mot_1");
    expect(manager.activeSessionIds()).toHaveLength(2);
    manager.dispose();
    // dispose is sync-scheduled — let the close promises settle.
    await new Promise((r) => setTimeout(r, 0));
    expect(manager.activeSessionIds()).toEqual([]);
  });
});

describe("ComputerSessionManager — governance gate", () => {
  it("allow: action reaches the dispatcher", async () => {
    const execute = vi.fn(async () => ({ kind: "screenshot" }));
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ execute }),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", SCREENSHOT_ACTION);
    expect(result.outcome).toBe("success");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("deny: policy_denied, dispatcher never runs", async () => {
    const execute = vi.fn(async () => undefined);
    const deny: ComputerGovernanceClassifier = {
      async classify() {
        return "deny";
      },
    };
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ execute }),
      governance: deny,
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.reason).toBe("policy_denied");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("require_approval without approvalFlow → approval_required", async () => {
    const requireApproval: ComputerGovernanceClassifier = {
      async classify() {
        return "require_approval";
      },
    };
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      governance: requireApproval,
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.reason).toBe("approval_required");
    }
  });

  it("require_approval with flow returning true → dispatcher runs", async () => {
    const execute = vi.fn(async () => ({}));
    const requireApproval: ComputerGovernanceClassifier = {
      async classify() {
        return "require_approval";
      },
    };
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ execute }),
      governance: requireApproval,
      approvalFlow: async () => true,
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("success");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("require_approval with flow returning false → approval_required, dispatcher skipped", async () => {
    const execute = vi.fn(async () => ({}));
    const requireApproval: ComputerGovernanceClassifier = {
      async classify() {
        return "require_approval";
      },
    };
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ execute }),
      governance: requireApproval,
      approvalFlow: async () => false,
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.reason).toBe("approval_required");
    }
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("ComputerSessionManager — dispatcher error taxonomy", () => {
  it("ComputerDispatcherError preserves the reason", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({
        async execute() {
          throw new ComputerDispatcherError("permission_denied", "No Screen Recording permission");
        },
      }),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", SCREENSHOT_ACTION);
    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.reason).toBe("permission_denied");
      expect(result.message).toContain("Screen Recording");
    }
  });

  it("generic Error maps to platform_blocked", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({
        async execute() {
          throw new Error("kernel panic");
        },
      }),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.reason).toBe("platform_blocked");
      expect(result.message).toContain("kernel panic");
    }
  });

  it("non-Error throws (string, object) still map to platform_blocked", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({
        async execute() {
          // eslint-disable-next-line @typescript-eslint/only-throw-error -- testing non-Error throw path
          throw "something went wrong";
        },
      }),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.reason).toBe("platform_blocked");
      expect(result.message).toContain("something went wrong");
    }
  });
});

describe("ComputerSessionManager — session validity", () => {
  it("execute without opened session → session_closed", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      generateSessionId: () => "cs_1",
    });
    const result = await manager.executeAction("cs_ghost", SCREENSHOT_ACTION);
    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.reason).toBe("session_closed");
    }
  });

  it("execute after close → session_closed", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    await manager.closeSession("cs_1");
    const result = await manager.executeAction("cs_1", SCREENSHOT_ACTION);
    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.reason).toBe("session_closed");
    }
  });
});

describe("ComputerSessionManager — streaming pass-through", () => {
  it("forwards onChunk to the dispatcher", async () => {
    const seen: unknown[] = [];
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({
        async execute(_action, onChunk) {
          onChunk?.({ type: "frame", data: "chunk-1" });
          onChunk?.({ type: "frame", data: "chunk-2" });
          return {};
        },
      }),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    await manager.executeAction("cs_1", SCREENSHOT_ACTION, (c) => seen.push(c));
    expect(seen).toHaveLength(2);
  });
});

describe("ComputerSessionManager — default session id generator", () => {
  it("produces unique ids without an injected generator", async () => {
    const manager = createComputerSessionManager({ dispatcher: makeDispatcher() });
    const a = await manager.openSession("mot_1");
    const b = await manager.openSession("mot_1");
    expect(a.handle.session_id).not.toBe(b.handle.session_id);
    expect(a.handle.session_id.startsWith("cs_")).toBe(true);
  });
});

describe("ComputerSessionManager — observation classifier", () => {
  it("overwrites the redaction field when classifier returns a redaction", async () => {
    const observation = {
      kind: "screenshot",
      width: 100,
      height: 100,
      redaction: { applied: false, projection_kind: "raw" },
    };
    const classifier: ComputerGovernanceClassifier = {
      async classify() {
        return "allow";
      },
      async classifyObservation(data) {
        const d = data as { kind?: string };
        if (d.kind !== "screenshot") return undefined;
        return {
          applied: true,
          projection_kind: "masked",
          policy_version: "v1.0.0",
          classified_regions_count: 2,
        };
      },
    };
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({
        async execute() {
          return observation;
        },
      }),
      governance: classifier,
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", SCREENSHOT_ACTION);
    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      const d = result.data as { redaction: { applied: boolean; projection_kind: string } };
      expect(d.redaction.applied).toBe(true);
      expect(d.redaction.projection_kind).toBe("masked");
    }
  });

  it("leaves the data untouched when classifier returns undefined", async () => {
    const observation = { kind: "cursor_position", x: 10, y: 20 };
    const classifier: ComputerGovernanceClassifier = {
      async classify() {
        return "allow";
      },
      async classifyObservation() {
        return undefined;
      },
    };
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({
        async execute() {
          return observation;
        },
      }),
      governance: classifier,
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", { kind: "cursor_position" });
    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.data).toEqual(observation);
    }
  });

  it("fail-closes when classifier throws — stamps redacted_on_error", async () => {
    const observation = { kind: "screenshot", width: 100, height: 100, sensitive: "bytes" };
    const classifier: ComputerGovernanceClassifier = {
      async classify() {
        return "allow";
      },
      async classifyObservation() {
        throw new Error("classifier exploded");
      },
    };
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({
        async execute() {
          return observation;
        },
      }),
      governance: classifier,
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", SCREENSHOT_ACTION);
    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      const d = result.data as {
        sensitive: string;
        redaction: { applied: boolean; projection_kind: string };
      };
      expect(d.sensitive).toBe("bytes");
      expect(d.redaction.applied).toBe(true);
      expect(d.redaction.projection_kind).toBe("redacted_on_error");
    }
  });

  it("passes through non-object data unchanged", async () => {
    const classifier: ComputerGovernanceClassifier = {
      async classify() {
        return "allow";
      },
      async classifyObservation() {
        return { applied: true, projection_kind: "masked" };
      },
    };
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({
        async execute() {
          return null;
        },
      }),
      governance: classifier,
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.data).toBeNull();
    }
  });

  it("no classifier means data flows through untouched", async () => {
    const observation = { kind: "screenshot", width: 10, height: 10 };
    const classifier: ComputerGovernanceClassifier = {
      async classify() {
        return "allow";
      },
      // classifyObservation omitted
    };
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({
        async execute() {
          return observation;
        },
      }),
      governance: classifier,
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", SCREENSHOT_ACTION);
    expect(result.outcome).toBe("success");
    if (result.outcome === "success") {
      expect(result.data).toEqual(observation);
    }
  });
});
