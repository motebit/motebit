/**
 * Test helpers for #943 round 9 — foreign-ness travels on the CALL PATH.
 *
 * There is no runtime-wide "foreign turn in flight" flag to set any more.
 * A test that wants "what a foreign turn's loop can reach" takes the
 * registry the runtime hands a foreign turn (`toolsForTurn(…, FOREIGN)`
 * over the loop's tools), or executes with an explicit foreign `ToolCall`.
 */
import type { ToolRegistry, ToolResult } from "@motebit/sdk";
import type { MotebitRuntime } from "../../index";
import { OWNER_ACT } from "../../turn-delegation-receipts";
import { TurnPrincipal } from "../../turn-principal";
import type { ToolCall } from "../../turn-principal";

/** A foreign principal's call, outside any turn's receipt collector. */
export const FOREIGN_CALL: ToolCall = { destination: OWNER_ACT, principal: TurnPrincipal.FOREIGN };

/** The tool registry the runtime builds for a FOREIGN turn's loop. */
export function foreignTurnTools(runtime: MotebitRuntime): ToolRegistry {
  const r = runtime as unknown as {
    toolsForTurn(tools: unknown, principal: TurnPrincipal): ToolRegistry;
    loopDeps: { tools?: unknown } | null;
    scopedToolRegistry: ToolRegistry;
  };
  return r.toolsForTurn(r.loopDeps?.tools ?? r.scopedToolRegistry, TurnPrincipal.FOREIGN);
}

/** Execute on the runtime's registry with an explicit call context. */
export function executeWithCall(
  runtime: MotebitRuntime,
  name: string,
  args: Record<string, unknown>,
  call: ToolCall,
): Promise<ToolResult> {
  return (
    runtime.getToolRegistry() as ToolRegistry & {
      execute(n: string, a: Record<string, unknown>, c: ToolCall): Promise<ToolResult>;
    }
  ).execute(name, args, call);
}
