/**
 * Runtime-parse tests for AgentTaskSchema. Validates the envelope every
 * executing agent receives — schema rejects bad shapes BEFORE the
 * executor commits to running anything.
 */
import { describe, expect, it } from "vitest";

import { AgentTaskSchema } from "../agent-task.js";

const SAMPLE: Record<string, unknown> = {
  task_id: "01HTV8X9QZ-task-1",
  motebit_id: "019cd9d4-3275-7b24-8265-61ebee41d9d0",
  prompt: "summarize the latest model release notes",
  submitted_at: 1_713_456_000_000,
  submitted_by: "019cd9d4-3275-7b24-8265-61ebee41d9d1",
  status: "pending",
  required_capabilities: ["http_mcp", "background"],
};

describe("AgentTaskSchema", () => {
  it("parses a minimal valid task", () => {
    const t = AgentTaskSchema.parse({
      task_id: "t-1",
      motebit_id: "m-1",
      prompt: "hi",
      submitted_at: 0,
      status: "pending",
    });
    expect(t.task_id).toBe("t-1");
    expect(t.status).toBe("pending");
  });

  it("parses a fully-populated task with all optional fields", () => {
    const t = AgentTaskSchema.parse({
      ...SAMPLE,
      wall_clock_ms: 600_000,
      claimed_by: "019cd9d4-3275-7b24-8265-61ebee41d9d2",
      step_id: "plan-step-3",
      delegated_scope: "web_search,read_url",
      invocation_origin: "user-tap",
    });
    expect(t.invocation_origin).toBe("user-tap");
    expect(t.delegated_scope).toBe("web_search,read_url");
  });

  it("rejects empty prompt (relay rule: prompts must be non-empty)", () => {
    expect(() => AgentTaskSchema.parse({ ...SAMPLE, prompt: "" })).toThrow();
  });

  it("rejects an unknown lifecycle status", () => {
    expect(() => AgentTaskSchema.parse({ ...SAMPLE, status: "in_progress" })).toThrow();
  });

  it("accepts every defined AgentTaskStatus value", () => {
    const all = ["pending", "claimed", "running", "completed", "failed", "denied", "expired"];
    for (const status of all) {
      const t = AgentTaskSchema.parse({ ...SAMPLE, status });
      expect(t.status).toBe(status);
    }
  });

  it("rejects unknown required_capabilities (not in DeviceCapability enum)", () => {
    expect(() =>
      AgentTaskSchema.parse({ ...SAMPLE, required_capabilities: ["mind_reading"] }),
    ).toThrow();
  });

  it("accepts every defined DeviceCapability", () => {
    const caps = [
      "stdio_mcp",
      "http_mcp",
      "file_system",
      "keyring",
      "background",
      "local_llm",
      "push_wake",
    ];
    const t = AgentTaskSchema.parse({ ...SAMPLE, required_capabilities: caps });
    expect(t.required_capabilities).toEqual(caps);
  });

  it("rejects unknown invocation_origin", () => {
    expect(() => AgentTaskSchema.parse({ ...SAMPLE, invocation_origin: "telepathy" })).toThrow();
  });

  it("rejects extra top-level keys (strict mode — drift defense)", () => {
    expect(() => AgentTaskSchema.parse({ ...SAMPLE, sneak: "not allowed" })).toThrow();
  });

  it("rejects empty task_id and motebit_id", () => {
    expect(() => AgentTaskSchema.parse({ ...SAMPLE, task_id: "" })).toThrow();
    expect(() => AgentTaskSchema.parse({ ...SAMPLE, motebit_id: "" })).toThrow();
  });
});
