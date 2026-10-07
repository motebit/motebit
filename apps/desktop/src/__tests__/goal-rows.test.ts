/**
 * The desktop's goal-row writer takes the tier by type and sends it in the
 * same `goals_create` call that inserts the row (the Rust command requires
 * it) — no follow-up UPDATE a missing runtime or a failed call could skip.
 */
import { describe, it, expect, vi } from "vitest";
import { SensitivityLevel } from "@motebit/sdk";
import { createGoalRow } from "../goal-rows";
import type { InvokeFn } from "../tauri-storage";

describe("createGoalRow", () => {
  it("writes the stamp with the row, camelCase as Tauri passes command args", async () => {
    const invoke = vi.fn(async () => undefined) as unknown as InvokeFn & ReturnType<typeof vi.fn>;
    await createGoalRow(invoke, {
      motebitId: "m",
      goalId: "g",
      prompt: "p",
      intervalMs: 1,
      mode: "recurring",
      parentGoalId: "parent",
      sensitivity: SensitivityLevel.Medical,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith("goals_create", {
      motebitId: "m",
      goalId: "g",
      prompt: "p",
      intervalMs: 1,
      mode: "recurring",
      budgetTokens: null,
      parentGoalId: "parent",
      sensitivity: SensitivityLevel.Medical,
    });
  });

  it("refuses at compile time without a tier", async () => {
    const invoke = vi.fn(async () => undefined) as unknown as InvokeFn;
    // @ts-expect-error — `sensitivity` is required on a goal write
    await createGoalRow(invoke, {
      motebitId: "m",
      goalId: "g",
      prompt: "p",
      intervalMs: 1,
      mode: "once",
    });
  });
});
