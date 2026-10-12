/**
 * Test-only door to a money tool's HANDLER — for tests about what the
 * handler does (settlement, receipts, the paid-intent interlock), not about
 * who may call it.
 *
 * The runtime's registry refuses an R4_MONEY tool without a capability only
 * a gate-decided runtime path mints (see `money-capability.ts`), and never
 * hands a handler out. The code that REGISTERS a tool holds its handler
 * anyway, so this helper records handlers at registration (importing it
 * patches `register`/`replace` before any runtime is built) and calls one
 * directly, routing a carried receipt exactly as `execute` does. It adds no
 * production door: nothing outside a test imports it.
 */
import type { ToolHandler, ToolResult } from "@motebit/sdk";
import { SimpleToolRegistry } from "../../simple-tool-registry.js";
import { OWNER_CALL } from "../../turn-principal.js";
import { takeCarriedReceipt } from "../../turn-delegation-receipts.js";
import type { ToolCall } from "../../turn-principal.js";
import type { ExecutionReceipt } from "@motebit/sdk";

const handlers = new WeakMap<SimpleToolRegistry, Map<string, ToolHandler>>();
const routers = new WeakMap<
  SimpleToolRegistry,
  (destination: symbol, receipt: ExecutionReceipt, trustCredited: boolean) => void
>();

function record(registry: SimpleToolRegistry, name: string, handler: ToolHandler): void {
  let map = handlers.get(registry);
  if (map == null) handlers.set(registry, (map = new Map()));
  map.set(name, handler);
}

const proto = SimpleToolRegistry.prototype;
const register = proto.register;
const replace = proto.replace;
const setRouter = proto.setDelegationReceiptRouter;
proto.register = function (this: SimpleToolRegistry, tool, handler) {
  register.call(this, tool, handler);
  record(this, tool.name, handler);
};
proto.replace = function (this: SimpleToolRegistry, tool, handler) {
  replace.call(this, tool, handler);
  record(this, tool.name, handler);
};
proto.setDelegationReceiptRouter = function (this: SimpleToolRegistry, router) {
  setRouter.call(this, router);
  routers.set(this, router as never);
};

/**
 * Run `name`'s registered handler with `call` (default: an owner call), as
 * `execute` would after a gate allowed it.
 */
export async function runToolHandler(
  registry: SimpleToolRegistry,
  name: string,
  args: Record<string, unknown>,
  call: ToolCall = OWNER_CALL,
): Promise<ToolResult> {
  const handler = handlers.get(registry)?.get(name);
  if (handler == null) return { ok: false, error: `Unknown tool: ${name}` };
  let result: ToolResult;
  try {
    result = await (handler as (a: Record<string, unknown>, c: unknown) => Promise<ToolResult>)(
      args,
      call,
    );
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const carried = takeCarriedReceipt(result);
  if (carried != null) {
    routers.get(registry)?.(call.destination, carried.receipt, carried.trustCredited);
  }
  return result;
}
