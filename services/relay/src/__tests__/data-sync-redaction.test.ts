/**
 * Unit tests for the conversation/message/plan sync sensitivity floor.
 *
 * The floor is a key-acceptance decision: every free-text field the client
 * adapters encrypt MUST arrive encrypted (carrying ENCRYPTED_FIELD_PREFIX); a
 * plaintext value in those fields is unprotected content and is replaced with
 * [REDACTED] at relay ingress. null/empty pass through; ciphertext passes
 * through byte-identical.
 */
import { describe, it, expect } from "vitest";
import type {
  SyncConversation,
  SyncConversationMessage,
  SyncPlan,
  SyncPlanStep,
} from "@motebit/sdk";
import { ENCRYPTED_FIELD_PREFIX } from "@motebit/encryption";
import {
  floorSyncConversation,
  floorSyncMessage,
  floorSyncPlan,
  floorSyncPlanStep,
} from "../data-sync-redaction.js";

const enc = (s: string): string => ENCRYPTED_FIELD_PREFIX + s;
const REDACTED = "[REDACTED]";

const baseConv = (o: Partial<SyncConversation>): SyncConversation =>
  ({
    conversation_id: "c1",
    motebit_id: "m1",
    started_at: 1,
    last_active_at: 2,
    title: null,
    summary: null,
    message_count: 0,
    ...o,
  }) as SyncConversation;

const baseMsg = (o: Partial<SyncConversationMessage>): SyncConversationMessage =>
  ({
    message_id: "msg1",
    conversation_id: "c1",
    motebit_id: "m1",
    role: "user",
    content: "",
    tool_calls: null,
    tool_call_id: null,
    created_at: 1,
    token_estimate: 0,
    ...o,
  }) as SyncConversationMessage;

const basePlan = (o: Partial<SyncPlan>): SyncPlan =>
  ({
    plan_id: "p1",
    goal_id: "g1",
    motebit_id: "m1",
    title: "",
    status: "active",
    created_at: 1,
    updated_at: 2,
    current_step_index: 0,
    total_steps: 1,
    proposal_id: null,
    collaborative: 0,
    ...o,
  }) as SyncPlan;

const baseStep = (o: Partial<SyncPlanStep>): SyncPlanStep =>
  ({
    step_id: "s1",
    plan_id: "p1",
    motebit_id: "m1",
    ordinal: 0,
    description: "",
    prompt: "",
    depends_on: "[]",
    optional: false,
    status: "pending",
    required_capabilities: null,
    delegation_task_id: null,
    assigned_motebit_id: null,
    result_summary: null,
    error_message: null,
    tool_calls_made: 0,
    started_at: null,
    completed_at: null,
    retry_count: 0,
    updated_at: 2,
    ...o,
  }) as SyncPlanStep;

describe("floorSyncConversation", () => {
  it("redacts plaintext title + summary", () => {
    const out = floorSyncConversation(
      baseConv({ title: "secret title", summary: "secret summary" }),
    );
    expect(out.title).toBe(REDACTED);
    expect(out.summary).toBe(REDACTED);
  });
  it("passes ciphertext through, leaves null/empty", () => {
    const out = floorSyncConversation(baseConv({ title: enc("ct"), summary: null }));
    expect(out.title).toBe(enc("ct"));
    expect(out.summary).toBeNull();
    expect(floorSyncConversation(baseConv({ summary: "" })).summary).toBe("");
  });
  it("does not touch structural fields", () => {
    const out = floorSyncConversation(baseConv({ title: "x", message_count: 7 }));
    expect(out.conversation_id).toBe("c1");
    expect(out.message_count).toBe(7);
  });
  it("is idempotent on ciphertext (re-floor is a no-op)", () => {
    const once = floorSyncConversation(baseConv({ title: enc("ct") }));
    expect(floorSyncConversation(once).title).toBe(enc("ct"));
  });
});

describe("floorSyncMessage", () => {
  it("redacts plaintext content + tool_calls", () => {
    const out = floorSyncMessage(baseMsg({ content: "plaintext body", tool_calls: '{"x":1}' }));
    expect(out.content).toBe(REDACTED);
    expect(out.tool_calls).toBe(REDACTED);
  });
  it("passes ciphertext content through; null tool_calls stays null", () => {
    const out = floorSyncMessage(baseMsg({ content: enc("ct"), tool_calls: null }));
    expect(out.content).toBe(enc("ct"));
    expect(out.tool_calls).toBeNull();
  });
  it("keeps role + ids", () => {
    const out = floorSyncMessage(baseMsg({ content: "x", role: "assistant" }));
    expect(out.role).toBe("assistant");
    expect(out.message_id).toBe("msg1");
  });
});

describe("floorSyncPlan", () => {
  it("redacts plaintext title, passes ciphertext", () => {
    expect(floorSyncPlan(basePlan({ title: "do the thing" })).title).toBe(REDACTED);
    expect(floorSyncPlan(basePlan({ title: enc("ct") })).title).toBe(enc("ct"));
    expect(floorSyncPlan(basePlan({ title: "" })).title).toBe("");
  });
});

describe("floorSyncPlanStep", () => {
  it("redacts all four plaintext free-text fields", () => {
    const out = floorSyncPlanStep(
      baseStep({
        description: "plaintext desc",
        prompt: "plaintext prompt",
        result_summary: "plaintext result",
        error_message: "plaintext error",
      }),
    );
    expect(out.description).toBe(REDACTED);
    expect(out.prompt).toBe(REDACTED);
    expect(out.result_summary).toBe(REDACTED);
    expect(out.error_message).toBe(REDACTED);
  });
  it("passes ciphertext through, leaves null optionals", () => {
    const out = floorSyncPlanStep(
      baseStep({
        description: enc("d"),
        prompt: enc("p"),
        result_summary: null,
        error_message: null,
      }),
    );
    expect(out.description).toBe(enc("d"));
    expect(out.prompt).toBe(enc("p"));
    expect(out.result_summary).toBeNull();
    expect(out.error_message).toBeNull();
  });
  it("does not regress structural fields", () => {
    const out = floorSyncPlanStep(baseStep({ description: "x", ordinal: 3 }));
    expect(out.ordinal).toBe(3);
    expect(out.status).toBe("pending"); // default status preserved
    expect(out.step_id).toBe("s1");
  });
});
