import { describe, it, expect, expectTypeOf } from "vitest";
import type { MotebitId, DeviceId, NodeId, GoalId } from "../index.js";
import {
  asMotebitId,
  asDeviceId,
  asNodeId,
  asGoalId,
  asEventId,
  asConversationId,
  asPlanId,
  asAllocationId,
  asSettlementId,
  asListingId,
  asProposalId,
} from "../index.js";

describe("Branded ID types", () => {
  it("string is assignable to branded type (backward compat)", () => {
    expectTypeOf<string>().toMatchTypeOf<MotebitId>();
    expectTypeOf<string>().toMatchTypeOf<DeviceId>();
    expectTypeOf<string>().toMatchTypeOf<NodeId>();
    expectTypeOf<string>().toMatchTypeOf<GoalId>();
  });

  it("branded type is assignable to string (for SQL, JSON)", () => {
    expectTypeOf<MotebitId>().toMatchTypeOf<string>();
    expectTypeOf<DeviceId>().toMatchTypeOf<string>();
  });

  it("branded types are NOT cross-assignable (catches the bug)", () => {
    expectTypeOf<MotebitId>().not.toMatchTypeOf<DeviceId>();
    expectTypeOf<DeviceId>().not.toMatchTypeOf<MotebitId>();
    expectTypeOf<NodeId>().not.toMatchTypeOf<GoalId>();
    expectTypeOf<GoalId>().not.toMatchTypeOf<NodeId>();
    expectTypeOf<MotebitId>().not.toMatchTypeOf<NodeId>();
  });
});

describe("Branded ID branding functions", () => {
  it("asMotebitId brands a string as MotebitId", () => {
    const id = asMotebitId("test-motebit-id");
    expect(id).toBe("test-motebit-id");
    // Runtime value is a plain string
    expect(typeof id).toBe("string");
  });

  it("asDeviceId brands a string as DeviceId", () => {
    const id = asDeviceId("dev-001");
    expect(id).toBe("dev-001");
  });

  it("asNodeId brands a string as NodeId", () => {
    const id = asNodeId("node-abc");
    expect(id).toBe("node-abc");
  });

  it("asGoalId brands a string as GoalId", () => {
    const id = asGoalId("goal-xyz");
    expect(id).toBe("goal-xyz");
  });

  it("asEventId brands a string as EventId", () => {
    const id = asEventId("evt-123");
    expect(id).toBe("evt-123");
  });

  it("asConversationId brands a string as ConversationId", () => {
    const id = asConversationId("conv-456");
    expect(id).toBe("conv-456");
  });

  it("asPlanId brands a string as PlanId", () => {
    const id = asPlanId("plan-789");
    expect(id).toBe("plan-789");
  });

  it("asAllocationId brands a string as AllocationId", () => {
    const id = asAllocationId("alloc-001");
    expect(id).toBe("alloc-001");
  });

  it("asSettlementId brands a string as SettlementId", () => {
    const id = asSettlementId("settle-002");
    expect(id).toBe("settle-002");
  });

  it("asListingId brands a string as ListingId", () => {
    const id = asListingId("list-003");
    expect(id).toBe("list-003");
  });

  it("asProposalId brands a string as ProposalId", () => {
    const id = asProposalId("prop-004");
    expect(id).toBe("prop-004");
  });
});
