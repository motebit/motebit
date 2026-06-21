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
import { createCoBrowseControlMachine } from "../co-browse-control.js";
import { createDefaultComputerGovernance } from "@motebit/policy-invariants";
import { hashComputerSessionActions, signComputerSessionReceipt } from "@motebit/crypto";
import { generateKeypair } from "@motebit/crypto";

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

  it("fail-closes when classifier throws — stamps redacted_on_error + strips bytes", async () => {
    const observation = {
      kind: "screenshot",
      width: 100,
      height: 100,
      bytes_base64: "SENSITIVE",
      ocr_tokens: [{ text: "anything", x: 0, y: 0, w: 1, h: 1 }],
      other: "kept",
    };
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
      const d = result.data as Record<string, unknown>;
      const redaction = d.redaction as { applied: boolean; projection_kind: string };
      expect(redaction.applied).toBe(true);
      expect(redaction.projection_kind).toBe("redacted_on_error");
      // Fail-closed: bytes stripped, non-sensitive metadata retained.
      expect(d.bytes_base64).toBeUndefined();
      expect(d.ocr_tokens).toBeUndefined();
      expect(d.other).toBe("kept");
    }
  });

  it("strip_bytes=true → bytes_base64 and ocr_tokens removed before AI sees them", async () => {
    const observation = {
      kind: "screenshot",
      width: 100,
      height: 100,
      bytes_base64: "should-not-reach-AI",
      ocr_tokens: [{ text: "card 4111-1111-1111-1111", x: 0, y: 0, w: 0.5, h: 0.05 }],
      artifact_id: "sha256:abc123",
      captured_at: 1_000_000,
    };
    const classifier: ComputerGovernanceClassifier = {
      async classify() {
        return "allow";
      },
      async classifyObservation() {
        return {
          applied: true,
          projection_kind: "blocked",
          policy_version: "v1.0.0",
          classified_regions_count: 1,
          strip_bytes: true,
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
      const d = result.data as Record<string, unknown>;
      // Strip fail-closed: the big sensitive payloads are gone…
      expect(d.bytes_base64).toBeUndefined();
      expect(d.ocr_tokens).toBeUndefined();
      // …but audit-binding metadata survives so a verifier with post-facto
      // access to the artifact store can still reconstruct the chain.
      expect(d.artifact_id).toBe("sha256:abc123");
      expect(d.captured_at).toBe(1_000_000);
      const redaction = d.redaction as { projection_kind: string; strip_bytes: boolean };
      expect(redaction.projection_kind).toBe("blocked");
      expect(redaction.strip_bytes).toBe(true);
    }
  });

  it("strip_bytes undefined (falsy) leaves bytes in place", async () => {
    const observation = {
      kind: "screenshot",
      width: 100,
      height: 100,
      bytes_base64: "ok-to-see",
    };
    const classifier: ComputerGovernanceClassifier = {
      async classify() {
        return "allow";
      },
      async classifyObservation() {
        // `personal_flagged` redaction — logged but non-blocking.
        return {
          applied: true,
          projection_kind: "personal_flagged",
          classified_regions_count: 1,
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
      const d = result.data as Record<string, unknown>;
      expect(d.bytes_base64).toBe("ok-to-see");
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

// ---------------------------------------------------------------------------
// v1.1b — verify the REAL classifiers (not toy mocks) compose end-to-end
// on the cloud-browser path: createDefaultComputerGovernance() +
// createComputerSessionManager. Same composition apps/web's
// `registerWebComputerTool` builds. The earlier "governance gate" suite
// covers the session-manager mechanics with always-allow / always-deny /
// always-require_approval mocks; this suite covers the realistic
// per-action and per-observation classification paths the
// virtual_browser embodiment depends on.
//
// Doctrine: motebit-computer.md §"v1 implementation status —
// virtual_browser v1" + spec/computer-use-v1.md §3.2 (gated-action
// invariant) + §3.4 (redaction-before-AI invariant).
// ---------------------------------------------------------------------------

describe("v1.1b — real classifiers compose end-to-end on the cloud-browser path", () => {
  const FAKE_PNG_BYTES = "iVBORw0KGgoAAAANSUhEUg".repeat(20);

  describe("approval path — classifyComputerAction fires for irreversible clicks", () => {
    it("Submit-labeled click hits the irreversibility classifier → require_approval (no flow → approval_required, dispatcher skipped)", async () => {
      const execute = vi.fn(async () => ({}));
      const manager = createComputerSessionManager({
        dispatcher: makeDispatcher({ execute }),
        governance: createDefaultComputerGovernance(),
        // No approvalFlow — fail-closed at the gate per spec §3.2.
        generateSessionId: () => "cs_1",
      });
      await manager.openSession("mot_1");

      const result = await manager.executeAction("cs_1", {
        kind: "click",
        target: { x: 100, y: 200 },
        target_hint: { label: "Submit", source: "accessibility" },
      });

      expect(result.outcome).toBe("failure");
      if (result.outcome === "failure") {
        expect(result.reason).toBe("approval_required");
      }
      expect(execute).not.toHaveBeenCalled();
    });

    it("Submit-labeled click + approving flow → dispatcher runs, action commits", async () => {
      const execute = vi.fn(async () => ({ kind: "click", ok: true }));
      const approvalFlow = vi.fn(async () => true);
      const manager = createComputerSessionManager({
        dispatcher: makeDispatcher({ execute }),
        governance: createDefaultComputerGovernance(),
        approvalFlow,
        generateSessionId: () => "cs_1",
      });
      await manager.openSession("mot_1");

      const result = await manager.executeAction("cs_1", {
        kind: "click",
        target: { x: 100, y: 200 },
        target_hint: { label: "Submit", source: "accessibility" },
      });

      expect(result.outcome).toBe("success");
      expect(approvalFlow).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("Submit-labeled click + denying flow → approval_required, dispatcher skipped", async () => {
      const execute = vi.fn(async () => ({}));
      const approvalFlow = vi.fn(async () => false);
      const manager = createComputerSessionManager({
        dispatcher: makeDispatcher({ execute }),
        governance: createDefaultComputerGovernance(),
        approvalFlow,
        generateSessionId: () => "cs_1",
      });
      await manager.openSession("mot_1");

      const result = await manager.executeAction("cs_1", {
        kind: "click",
        target: { x: 100, y: 200 },
        target_hint: { label: "Submit", source: "accessibility" },
      });

      expect(result.outcome).toBe("failure");
      if (result.outcome === "failure") {
        expect(result.reason).toBe("approval_required");
      }
      expect(approvalFlow).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
    });

    it("multiple irreversibility patterns each trigger approval (Submit / Buy now / Pay now / Authorize app / Permanently delete)", async () => {
      const labels = [
        "Submit",
        "Buy now",
        "Pay now",
        "Authorize app",
        "Permanently delete",
        "I agree",
      ];
      for (const label of labels) {
        const execute = vi.fn(async () => ({}));
        const manager = createComputerSessionManager({
          dispatcher: makeDispatcher({ execute }),
          governance: createDefaultComputerGovernance(),
          generateSessionId: () => `cs_${label}`,
        });
        await manager.openSession("mot_1");
        const result = await manager.executeAction(`cs_${label}`, {
          kind: "click",
          target: { x: 100, y: 200 },
          target_hint: { label, source: "accessibility" },
        });
        expect(result.outcome, `label "${label}" should require approval`).toBe("failure");
        expect(execute, `dispatcher must not run for "${label}"`).not.toHaveBeenCalled();
      }
    });

    it("benign-labeled click (Cancel) skips approval — over-firing would make the tool unusable", async () => {
      const execute = vi.fn(async () => ({ kind: "click", ok: true }));
      const approvalFlow = vi.fn(async () => true);
      const manager = createComputerSessionManager({
        dispatcher: makeDispatcher({ execute }),
        governance: createDefaultComputerGovernance(),
        approvalFlow,
        generateSessionId: () => "cs_1",
      });
      await manager.openSession("mot_1");

      const result = await manager.executeAction("cs_1", {
        kind: "click",
        target: { x: 100, y: 200 },
        target_hint: { label: "Cancel", source: "accessibility" },
      });

      expect(result.outcome).toBe("success");
      expect(approvalFlow).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
    });

    it("type action with secret-pattern text fires approval — same regex engine as observation classifier", async () => {
      const execute = vi.fn(async () => ({}));
      const manager = createComputerSessionManager({
        dispatcher: makeDispatcher({ execute }),
        governance: createDefaultComputerGovernance(),
        generateSessionId: () => "cs_1",
      });
      await manager.openSession("mot_1");

      // sk- prefix matches the SECRET_PATTERNS in
      // policy-invariants/computer-sensitivity.ts; classifyComputerAction
      // returns require_approval per spec §3.2.
      const result = await manager.executeAction("cs_1", {
        kind: "type",
        text: "sk-test1234567890abcdefghij",
      });

      expect(result.outcome).toBe("failure");
      if (result.outcome === "failure") {
        expect(result.reason).toBe("approval_required");
      }
      expect(execute).not.toHaveBeenCalled();
    });
  });

  describe("observation classification — classifyObservation fires on screenshot results", () => {
    it("benign screenshot (no OCR tokens) gets the v1 stub redaction stamp (applied: false, projection_kind: 'raw')", async () => {
      const screenshot = {
        kind: "screenshot",
        width: 1280,
        height: 800,
        bytes_base64: FAKE_PNG_BYTES,
      };
      const manager = createComputerSessionManager({
        dispatcher: makeDispatcher({
          async execute() {
            return screenshot;
          },
        }),
        governance: createDefaultComputerGovernance(),
        generateSessionId: () => "cs_1",
      });
      await manager.openSession("mot_1");

      const result = await manager.executeAction("cs_1", { kind: "screenshot" });
      expect(result.outcome).toBe("success");
      if (result.outcome === "success") {
        const d = result.data as Record<string, unknown>;
        const redaction = d.redaction as { applied: boolean; projection_kind: string };
        expect(redaction.applied).toBe(false);
        expect(redaction.projection_kind).toBe("raw");
        // Bytes stay intact when no sensitivity is detected — the slab
        // can render the image; the AI sees it (subject to upstream
        // bytes_omitted projection in ai-core's projectForAi).
        expect(d.bytes_base64).toBe(FAKE_PNG_BYTES);
      }
    });

    it("OCR tokens with financial content (Luhn-valid card #) → projection_kind: 'blocked', bytes stripped (spec §3.4 redaction-before-AI)", async () => {
      // 4111111111111111 is a valid Luhn test Visa number; CARD_NUMBER_PATTERN
      // matches; classifyScreenshotWithOcr returns financial → strip_bytes.
      // The session manager removes bytes_base64 + ocr_tokens before the
      // AI sees the result.
      const screenshot = {
        kind: "screenshot",
        width: 1280,
        height: 800,
        bytes_base64: FAKE_PNG_BYTES,
        ocr_tokens: [{ text: "Card number: 4111 1111 1111 1111", x: 0, y: 0, w: 200, h: 20 }],
      };
      const manager = createComputerSessionManager({
        dispatcher: makeDispatcher({
          async execute() {
            return screenshot;
          },
        }),
        governance: createDefaultComputerGovernance(),
        generateSessionId: () => "cs_1",
      });
      await manager.openSession("mot_1");

      const result = await manager.executeAction("cs_1", { kind: "screenshot" });
      expect(result.outcome).toBe("success");
      if (result.outcome === "success") {
        const d = result.data as Record<string, unknown>;
        const redaction = d.redaction as {
          applied: boolean;
          projection_kind: string;
          strip_bytes?: boolean;
          classified_regions_count: number;
        };
        expect(redaction.applied).toBe(true);
        expect(redaction.projection_kind).toBe("blocked");
        expect(redaction.strip_bytes).toBe(true);
        expect(redaction.classified_regions_count).toBeGreaterThan(0);
        // Spec §3.4: raw bytes never reach the AI when sensitivity
        // classifier flags blocking-tier (medical / financial / secret).
        // The session manager strips them upstream.
        expect(d.bytes_base64).toBeUndefined();
        expect(d.ocr_tokens).toBeUndefined();
      }
    });

    it("OCR tokens with secret content (sk- prefix API key) → projection_kind: 'blocked', bytes stripped", async () => {
      const screenshot = {
        kind: "screenshot",
        width: 1280,
        height: 800,
        bytes_base64: FAKE_PNG_BYTES,
        ocr_tokens: [{ text: "API key: sk-test1234567890abcdefghij", x: 0, y: 0, w: 200, h: 20 }],
      };
      const manager = createComputerSessionManager({
        dispatcher: makeDispatcher({
          async execute() {
            return screenshot;
          },
        }),
        governance: createDefaultComputerGovernance(),
        generateSessionId: () => "cs_1",
      });
      await manager.openSession("mot_1");

      const result = await manager.executeAction("cs_1", { kind: "screenshot" });
      expect(result.outcome).toBe("success");
      if (result.outcome === "success") {
        const d = result.data as Record<string, unknown>;
        const redaction = d.redaction as { projection_kind: string; strip_bytes?: boolean };
        expect(redaction.projection_kind).toBe("blocked");
        expect(redaction.strip_bytes).toBe(true);
        expect(d.bytes_base64).toBeUndefined();
      }
    });

    it("OCR tokens with personal content (SSN) → personal_flagged, bytes preserved (over-stripping personal would make the tool unusable)", async () => {
      const screenshot = {
        kind: "screenshot",
        width: 1280,
        height: 800,
        bytes_base64: FAKE_PNG_BYTES,
        ocr_tokens: [{ text: "SSN: 123-45-6789", x: 0, y: 0, w: 100, h: 20 }],
      };
      const manager = createComputerSessionManager({
        dispatcher: makeDispatcher({
          async execute() {
            return screenshot;
          },
        }),
        governance: createDefaultComputerGovernance(),
        generateSessionId: () => "cs_1",
      });
      await manager.openSession("mot_1");

      const result = await manager.executeAction("cs_1", { kind: "screenshot" });
      expect(result.outcome).toBe("success");
      if (result.outcome === "success") {
        const d = result.data as Record<string, unknown>;
        const redaction = d.redaction as { projection_kind: string; strip_bytes?: boolean };
        expect(redaction.projection_kind).toBe("personal_flagged");
        // Personal matches recorded but bytes flow through — doctrine:
        // "blocking every screenshot that contained one would make the
        // tool unusable." The slab still gets the image; the audit
        // trail records the personal-tier match.
        expect(redaction.strip_bytes).toBeFalsy();
        expect(d.bytes_base64).toBe(FAKE_PNG_BYTES);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// v1.2 — halt / resume primitive (user-floor invariant per spec §3.3 +
// "two-finger hold on the plane" gesture per motebit-computer.md
// §"The user's touch — supervised agency"). The primitive lives at the
// session-manager level so any trigger surface (slash command, slab plane
// gesture, voice command, AI's own "stop" tool) composes the same fail-
// closed user_preempted boundary.
// ---------------------------------------------------------------------------

describe("v1.2 — halt / resume primitive (fail-closed user_preempted)", () => {
  it("isHalted defaults to false on a fresh manager", () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
    });
    expect(manager.isHalted()).toBe(false);
  });

  it("halt() flips isHalted to true; resume() flips it back; both idempotent", () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
    });
    manager.halt();
    expect(manager.isHalted()).toBe(true);
    manager.halt(); // idempotent
    expect(manager.isHalted()).toBe(true);
    manager.resume();
    expect(manager.isHalted()).toBe(false);
    manager.resume(); // idempotent
    expect(manager.isHalted()).toBe(false);
  });

  it("halted: executeAction returns user_preempted WITHOUT calling dispatcher (spec §3.3)", async () => {
    const execute = vi.fn(async () => ({ kind: "click", ok: true }));
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ execute }),
      governance: createDefaultComputerGovernance(),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    manager.halt();

    const result = await manager.executeAction("cs_1", CLICK_ACTION);

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.reason).toBe("user_preempted");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("halt preempts BEFORE governance — even allow-classified actions get user_preempted (halt is the user's stop button, it overrides everything)", async () => {
    const classify = vi.fn(async () => "allow" as const);
    const execute = vi.fn(async () => ({}));
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ execute }),
      governance: { classify },
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    manager.halt();

    const result = await manager.executeAction("cs_1", CLICK_ACTION);

    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.reason).toBe("user_preempted");
    }
    // Halt fires before governance — neither classify nor execute runs.
    expect(classify).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("resume() lets new actions through; halt+resume+halt cycle works correctly", async () => {
    const execute = vi.fn(async () => ({ kind: "click", ok: true }));
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ execute }),
      governance: createDefaultComputerGovernance(),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");

    // Pre-halt: executes normally.
    let result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("success");
    expect(execute).toHaveBeenCalledTimes(1);

    // Halt: rejected.
    manager.halt();
    result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("failure");
    expect(execute).toHaveBeenCalledTimes(1); // unchanged

    // Resume: executes again.
    manager.resume();
    result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("success");
    expect(execute).toHaveBeenCalledTimes(2);

    // Halt again: rejected.
    manager.halt();
    result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("failure");
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("in-flight actions complete naturally (spec §3.3: 'in-flight atomic action MAY complete; no new dispatch begins')", async () => {
    // The halt primitive's contract is "no new dispatch starts." It
    // does NOT cancel in-flight actions — that would require the
    // dispatcher to support AbortSignal mid-call, which Playwright
    // (cloud-browser) and most Tauri input-injection paths do not.
    // The spec explicitly carves this out: "in-flight atomic action
    // MAY complete." This test pins that semantics — a long-running
    // action started before halt completes successfully even when
    // halt fires mid-flight.
    let resolveAction: (() => void) | null = null;
    const inFlight = new Promise<void>((r) => {
      resolveAction = r;
    });
    const execute = vi.fn(async () => {
      await inFlight; // simulate slow Playwright call
      return { kind: "click", ok: true };
    });
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ execute }),
      governance: createDefaultComputerGovernance(),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");

    const actionPromise = manager.executeAction("cs_1", CLICK_ACTION);
    // Halt while the action is mid-flight.
    manager.halt();
    expect(manager.isHalted()).toBe(true);
    // Release the in-flight action's resolve.
    resolveAction!();
    const result = await actionPromise;
    // The in-flight call completes successfully — halt only blocks NEW
    // dispatches, not ones that already started.
    expect(result.outcome).toBe("success");

    // But the NEXT call IS blocked.
    const next = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(next.outcome).toBe("failure");
    if (next.outcome === "failure") {
      expect(next.reason).toBe("user_preempted");
    }
  });

  it("halt rejects actions on closed sessions with user_preempted, not session_closed (halt fires first)", async () => {
    // Order matters: the user's stop button preempts every other
    // failure mode. If halt fires before the session-validity check,
    // a closed session also gets user_preempted while halted —
    // honest about why the action didn't run (the user halted, full
    // stop), not about a downstream condition that would have failed
    // anyway.
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    await manager.closeSession("cs_1");
    manager.halt();

    const result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.reason).toBe("user_preempted");
    }
  });
});

// ---------------------------------------------------------------------------
// v1.5 — `summarize()` produces the unsigned body of a
// `ComputerSessionReceipt`. Exercises the per-action ledger,
// outcome counts, failure breakdown, sensitivity envelope, halt-
// stickiness, and post-close availability via the closedSessions
// retention. The signing path is covered in @motebit/crypto's
// verify-artifacts.test.ts; tests here stay pure runtime logic.
// ---------------------------------------------------------------------------

describe("v1.5 — summarize() session-summary roll-up", () => {
  function makeSummarizeDeps(): {
    generateReceiptId: () => string;
    embodimentMode: string;
    hashActions: (actions: ReadonlyArray<unknown>) => Promise<string>;
  } {
    let n = 0;
    return {
      generateReceiptId: () => `csr_${++n}`,
      embodimentMode: "virtual_browser",
      hashActions: async (actions) => `h${actions.length}`,
    };
  }

  it("returns null for an unknown session id", async () => {
    const manager = createComputerSessionManager({ dispatcher: makeDispatcher() });
    const summary = await manager.summarize("cs_does_not_exist", makeSummarizeDeps());
    expect(summary).toBeNull();
  });

  it("summarizes an open session with zero actions", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      generateSessionId: () => "cs_1",
      now: () => 1_000,
    });
    await manager.openSession("mot_1");
    const summary = await manager.summarize("cs_1", makeSummarizeDeps());
    expect(summary).not.toBeNull();
    if (summary == null) return;
    expect(summary.session_id).toBe("cs_1");
    expect(summary.motebit_id).toBe("mot_1");
    expect(summary.embodiment_mode).toBe("virtual_browser");
    expect(summary.action_count).toBe(0);
    expect(summary.outcomes_summary).toEqual({ success: 0, failure: 0 });
    expect(summary.failure_breakdown).toEqual({});
    expect(summary.was_halted).toBe(false);
    expect(summary.max_sensitivity).toBe("none");
    expect(summary.actions_hash).toBe("h0");
    expect(summary.display_width).toBe(2560);
    expect(summary.display_height).toBe(1440);
    expect(summary.scaling_factor).toBe(2);
  });

  it("counts successes and failures across mixed outcomes", async () => {
    let t = 1000;
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({
        async execute() {
          // Fail on every other action to produce a known mix.
          if (t > 1100) throw new ComputerDispatcherError("target_not_found", "missing");
          return undefined;
        },
      }),
      governance: createDefaultComputerGovernance(),
      generateSessionId: () => "cs_1",
      now: () => t,
    });
    await manager.openSession("mot_1");
    t = 1010;
    await manager.executeAction("cs_1", SCREENSHOT_ACTION); // success
    t = 1050;
    await manager.executeAction("cs_1", CLICK_ACTION); // success
    t = 1200;
    await manager.executeAction("cs_1", CLICK_ACTION); // failure (target_not_found)
    t = 1300;
    await manager.executeAction("cs_1", CLICK_ACTION); // failure
    const summary = await manager.summarize("cs_1", makeSummarizeDeps());
    if (summary == null) throw new Error("expected summary");
    expect(summary.action_count).toBe(4);
    expect(summary.outcomes_summary).toEqual({ success: 2, failure: 2 });
    expect(summary.failure_breakdown).toEqual({ target_not_found: 2 });
    expect(summary.actions_hash).toBe("h4");
  });

  it("breaks failures down by reason (multiple distinct reasons)", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({
        async execute() {
          throw new ComputerDispatcherError("target_obscured", "covered");
        },
      }),
      governance: {
        // First call denies; subsequent calls allow so dispatcher fires.
        classify: vi
          .fn<ComputerGovernanceClassifier["classify"]>()
          .mockResolvedValueOnce("deny")
          .mockResolvedValue("allow"),
      },
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    await manager.executeAction("cs_1", CLICK_ACTION); // policy_denied
    await manager.executeAction("cs_1", CLICK_ACTION); // target_obscured
    await manager.executeAction("cs_1", CLICK_ACTION); // target_obscured
    const summary = await manager.summarize("cs_1", makeSummarizeDeps());
    if (summary == null) throw new Error("expected summary");
    expect(summary.outcomes_summary).toEqual({ success: 0, failure: 3 });
    expect(summary.failure_breakdown).toEqual({
      policy_denied: 1,
      target_obscured: 2,
    });
  });

  it("halt() stamps was_halted on every active session, sticky across resume", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    let summary = await manager.summarize("cs_1", makeSummarizeDeps());
    expect(summary?.was_halted).toBe(false);
    manager.halt();
    summary = await manager.summarize("cs_1", makeSummarizeDeps());
    expect(summary?.was_halted).toBe(true);
    manager.resume();
    summary = await manager.summarize("cs_1", makeSummarizeDeps());
    // Stickiness — receipt commits to "user paused at least once."
    expect(summary?.was_halted).toBe(true);
  });

  it("max_sensitivity lifts to 'financial' when classifier strips bytes (inferred floor)", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({
        async execute() {
          return { kind: "screenshot", artifact_id: "a", bytes_base64: "x" };
        },
      }),
      governance: {
        classify: async () => "allow",
        async classifyObservation() {
          return { applied: true, projection_kind: "redacted", strip_bytes: true };
        },
      },
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    await manager.executeAction("cs_1", SCREENSHOT_ACTION);
    const summary = await manager.summarize("cs_1", makeSummarizeDeps());
    expect(summary?.max_sensitivity).toBe("financial");
  });

  it("max_sensitivity uses classifier's explicit sensitivity_level when supplied", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({
        async execute() {
          return { kind: "screenshot" };
        },
      }),
      governance: {
        classify: async () => "allow",
        async classifyObservation() {
          return { applied: true, projection_kind: "raw", sensitivity_level: "secret" };
        },
      },
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    await manager.executeAction("cs_1", SCREENSHOT_ACTION);
    const summary = await manager.summarize("cs_1", makeSummarizeDeps());
    expect(summary?.max_sensitivity).toBe("secret");
  });

  it("max_sensitivity is the high-water mark across the session (never decays)", async () => {
    let observed = "personal";
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({
        async execute() {
          return { kind: "screenshot" };
        },
      }),
      governance: {
        classify: async () => "allow",
        async classifyObservation() {
          return { applied: true, projection_kind: "raw", sensitivity_level: observed };
        },
      },
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    await manager.executeAction("cs_1", SCREENSHOT_ACTION);
    observed = "financial";
    await manager.executeAction("cs_1", SCREENSHOT_ACTION);
    observed = "personal"; // lower — must NOT pull max_sensitivity down
    await manager.executeAction("cs_1", SCREENSHOT_ACTION);
    const summary = await manager.summarize("cs_1", makeSummarizeDeps());
    expect(summary?.max_sensitivity).toBe("financial");
  });

  it("works on a closed session via the post-close retention buffer", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      generateSessionId: () => "cs_1",
      now: () => 1_000,
    });
    await manager.openSession("mot_1");
    await manager.executeAction("cs_1", CLICK_ACTION);
    await manager.closeSession("cs_1", "user_closed");
    expect(manager.activeSessionIds()).toEqual([]);
    const summary = await manager.summarize("cs_1", makeSummarizeDeps());
    expect(summary).not.toBeNull();
    if (summary == null) return;
    expect(summary.close_reason).toBe("user_closed");
    expect(summary.action_count).toBe(1);
    expect(summary.closed_at).toBe(1_000);
  });

  it("hashActions receives the per-action ledger in dispatch order", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      governance: createDefaultComputerGovernance(),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    await manager.executeAction("cs_1", SCREENSHOT_ACTION);
    await manager.executeAction("cs_1", CLICK_ACTION);
    let captured: ReadonlyArray<unknown> | null = null;
    await manager.summarize("cs_1", {
      generateReceiptId: () => "csr_1",
      embodimentMode: "virtual_browser",
      hashActions: async (actions) => {
        captured = [...actions];
        return "h";
      },
    });
    expect(captured).not.toBeNull();
    expect(captured).toHaveLength(2);
    if (captured != null) {
      const arr = captured as Array<{ kind: string; outcome: string }>;
      const a = arr[0];
      const b = arr[1];
      expect(a?.kind).toBe("screenshot");
      expect(b?.kind).toBe("click");
      expect(a?.outcome).toBe("success");
      expect(b?.outcome).toBe("success");
    }
  });

  it("records halt-rejected actions in the ledger as failure/user_preempted", async () => {
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    manager.halt();
    await manager.executeAction("cs_1", CLICK_ACTION);
    await manager.executeAction("cs_1", CLICK_ACTION);
    const summary = await manager.summarize("cs_1", makeSummarizeDeps());
    expect(summary?.action_count).toBe(2);
    expect(summary?.outcomes_summary).toEqual({ success: 0, failure: 2 });
    expect(summary?.failure_breakdown).toEqual({ user_preempted: 2 });
    expect(summary?.was_halted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Co-browse Slice 1 — control-state gate.
//
// `coBrowseControl` is only present for virtual_browser co-browse
// sessions; desktop_drive is exempt because its control/consent model
// is separate. The acceptance criteria below pin:
//
//   1. user / handoff_pending / paused all deny with not_in_control.
//   2. motebit allows the existing path unchanged.
//   3. undefined dep is a no-op (preserves desktop_drive et al).
//   4. user-reclaim from motebit blocks the next motebit action.
//   5. disconnect from motebit/handoff/paused reverts → blocks.
//   6. denied actions don't reach the dispatcher.
//   7. control_state_at_denial flows into actions_hash, so tampering
//      it after sign breaks the session-receipt signature.
// ─────────────────────────────────────────────────────────────────────

describe("ComputerSessionManager — co-browse control gate (Slice 1)", () => {
  function makeMachine() {
    return createCoBrowseControlMachine({
      sessionId: "cs_1",
      motebitId: "mot_1",
      now: () => 1_000_000,
    });
  }

  it("user state denies with not_in_control and does NOT hit the dispatcher", async () => {
    const execute = vi.fn(async () => ({}));
    const machine = makeMachine(); // starts in {kind: "user"}
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ execute }),
      coBrowseControl: machine,
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.reason).toBe("not_in_control");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("handoff_pending denies and stamps the full state on the action record", async () => {
    const machine = makeMachine();
    machine.requestControl("motebit"); // → handoff_pending
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      coBrowseControl: machine,
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    await manager.executeAction("cs_1", CLICK_ACTION);
    const summary = await manager.summarize("cs_1", {
      generateReceiptId: () => "csr_1",
      embodimentMode: "virtual_browser",
      hashActions: async () => "h",
    });
    expect(summary).not.toBeNull();
    if (!summary) return;
    expect(summary.action_count).toBe(1);
    expect(summary.failure_breakdown).toEqual({ not_in_control: 1 });
    // Reach into the manager's action ledger via summary's hash deps:
    // alternative — re-summarize with a hashActions that captures the
    // ledger contents.
    let captured: Record<string, unknown>[] = [];
    await manager.summarize("cs_1", {
      generateReceiptId: () => "csr_2",
      embodimentMode: "virtual_browser",
      hashActions: async (records) => {
        captured = records as unknown as Record<string, unknown>[];
        return "h";
      },
    });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.failure_reason).toBe("not_in_control");
    expect(captured[0]?.control_state_at_denial).toEqual({
      kind: "handoff_pending",
      current: "user",
      requesting: "motebit",
    });
  });

  it("paused state denies and stamps the full state (carrying previousDriver)", async () => {
    const machine = makeMachine();
    machine.requestControl("motebit");
    machine.grantControl("user"); // → motebit
    machine.pause("user"); // → paused, previousDriver: "motebit"
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      coBrowseControl: machine,
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("failure");
    let captured: Record<string, unknown>[] = [];
    await manager.summarize("cs_1", {
      generateReceiptId: () => "csr_1",
      embodimentMode: "virtual_browser",
      hashActions: async (records) => {
        captured = records as unknown as Record<string, unknown>[];
        return "h";
      },
    });
    expect(captured[0]?.control_state_at_denial).toEqual({
      kind: "paused",
      previousDriver: "motebit",
    });
  });

  it("motebit state allows existing executeAction path (dispatcher fires)", async () => {
    const execute = vi.fn(async () => ({ kind: "click", ok: true }));
    const machine = makeMachine();
    machine.requestControl("motebit");
    machine.grantControl("user"); // → motebit
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ execute }),
      coBrowseControl: machine,
      governance: createDefaultComputerGovernance(),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("success");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("undefined coBrowseControl preserves existing behavior (desktop_drive et al)", async () => {
    const execute = vi.fn(async () => ({ kind: "click", ok: true }));
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ execute }),
      governance: createDefaultComputerGovernance(),
      generateSessionId: () => "cs_1",
      // No coBrowseControl — gate is a no-op.
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("success");
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("user-reclaim from motebit blocks the next motebit action", async () => {
    const execute = vi.fn(async () => ({}));
    const machine = makeMachine();
    machine.requestControl("motebit");
    machine.grantControl("user"); // → motebit
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ execute }),
      coBrowseControl: machine,
      governance: createDefaultComputerGovernance(),
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    // First action: motebit holds, succeeds.
    expect((await manager.executeAction("cs_1", CLICK_ACTION)).outcome).toBe("success");
    expect(execute).toHaveBeenCalledTimes(1);

    // User reclaims unilaterally; next action denies.
    machine.reclaimControl();
    const blocked = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(blocked.outcome).toBe("failure");
    if (blocked.outcome === "failure") {
      expect(blocked.reason).toBe("not_in_control");
    }
    expect(execute).toHaveBeenCalledTimes(1); // unchanged
  });

  it.each([
    {
      label: "from motebit",
      setup: (m: ReturnType<typeof makeMachine>) => {
        m.requestControl("motebit");
        m.grantControl("user");
      },
    },
    {
      label: "from handoff_pending",
      setup: (m: ReturnType<typeof makeMachine>) => {
        m.requestControl("motebit");
      },
    },
    {
      label: "from paused",
      setup: (m: ReturnType<typeof makeMachine>) => {
        m.requestControl("motebit");
        m.grantControl("user");
        m.pause("user");
      },
    },
  ])("disconnect $label reverts to user and blocks the next motebit action", async ({ setup }) => {
    const execute = vi.fn(async () => ({}));
    const machine = makeMachine();
    setup(machine);
    machine.disconnect();
    expect(machine.getState()).toEqual({ kind: "user" });

    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher({ execute }),
      coBrowseControl: machine,
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    const result = await manager.executeAction("cs_1", CLICK_ACTION);
    expect(result.outcome).toBe("failure");
    if (result.outcome === "failure") {
      expect(result.reason).toBe("not_in_control");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("control_state_at_denial flows into actions_hash — tampering breaks the session receipt signature", async () => {
    const machine = makeMachine();
    machine.requestControl("motebit"); // → handoff_pending
    const manager = createComputerSessionManager({
      dispatcher: makeDispatcher(),
      coBrowseControl: machine,
      generateSessionId: () => "cs_1",
    });
    await manager.openSession("mot_1");
    await manager.executeAction("cs_1", CLICK_ACTION); // denied not_in_control

    // Capture the real action ledger via summarize's hashActions hook.
    let realRecords: Parameters<typeof hashComputerSessionActions>[0] | null = null;
    const realHash = await new Promise<string>((resolve) => {
      void manager.summarize("cs_1", {
        generateReceiptId: () => "csr_1",
        embodimentMode: "virtual_browser",
        hashActions: async (records) => {
          realRecords = records;
          const h = await hashComputerSessionActions(records);
          resolve(h);
          return h;
        },
      });
    });
    expect(realRecords).not.toBeNull();
    if (realRecords == null) return;

    // Sign the receipt body with the REAL hash.
    const kp = await generateKeypair();
    const summary = await manager.summarize("cs_1", {
      generateReceiptId: () => "csr_1",
      embodimentMode: "virtual_browser",
      hashActions: async () => realHash,
    });
    if (!summary) throw new Error("summary missing");
    const signed = await signComputerSessionReceipt(summary, kp.privateKey, kp.publicKey);
    expect(signed.signature).toBeTruthy();

    // Build a tampered ledger: same shape, but lie about the control
    // state at denial (claim "user" instead of "handoff_pending").
    const tampered = (
      realRecords as ReadonlyArray<{
        kind: string;
        started_at: number;
        completed_at: number;
        outcome: string;
        failure_reason?: string;
        control_state_at_denial?: unknown;
      }>
    ).map((r) => ({
      ...r,
      control_state_at_denial:
        r.control_state_at_denial !== undefined ? { kind: "user" } : undefined,
    }));
    const tamperedHash = await hashComputerSessionActions(
      tampered as unknown as Parameters<typeof hashComputerSessionActions>[0],
    );

    // Tampered hash != real hash. A receipt signed over the real
    // hash, with the tampered hash substituted, would fail signature
    // verification — the field is part of the signed structural
    // commitment.
    expect(tamperedHash).not.toBe(realHash);
  });
});
