import { describe, it, expectTypeOf } from "vitest";
import type { MotebitId, DeviceId, NodeId, GoalId } from "../index.js";

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
