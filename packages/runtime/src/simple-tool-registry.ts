// === Tool Registry ===
// `SimpleToolRegistry` is inlined here so the runtime doesn't take a value
// dep on `@motebit/tools`. The main `@motebit/tools` entry pulls in
// node:child_process / node:fs via the shell-exec / read-file / write-file
// builtins; the `@motebit/tools/web-safe` subpath excludes those. Browser
// surfaces import the web-safe subpath; rather than make runtime import
// either subpath, we keep this minimal in-memory registry inline so runtime
// stays neutral on which subpath the consumer uses.

import type { ToolRegistry, ToolDefinition, ToolResult, ToolHandler } from "@motebit/sdk";
import { toolModePriority } from "@motebit/sdk";
import type { ExecutionReceipt } from "@motebit/sdk";
import { takeCarriedReceipt } from "./turn-delegation-receipts.js";
import type { ReceiptDestination } from "./turn-delegation-receipts.js";
import { OWNER_CALL } from "./turn-principal.js";
import type { ToolCall } from "./turn-principal.js";

/**
 * A handler registered in the runtime's registry receives the call's
 * context (#943 round 9): whose call it is travels with the call, so an
 * owner-only handler decides from THIS call, never from runtime state.
 */
export type CallAwareToolHandler = (
  args: Record<string, unknown>,
  call: ToolCall,
) => Promise<ToolResult>;

export class SimpleToolRegistry implements ToolRegistry {
  private tools = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();
  /**
   * #943: where a hire's receipt goes. The ONE place a tool result's carried
   * `delegation_receipt` is taken off and recorded — for the destination the
   * caller passed into THIS execute (a turn's key), defaulting to the owner.
   */
  private receiptRouter:
    | ((destination: ReceiptDestination, receipt: ExecutionReceipt, trustCredited: boolean) => void)
    | null = null;

  setDelegationReceiptRouter(
    router: (
      destination: ReceiptDestination,
      receipt: ExecutionReceipt,
      trustCredited: boolean,
    ) => void,
  ): void {
    this.receiptRouter = router;
  }

  register(tool: ToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" already registered`);
    this.tools.set(tool.name, { definition: tool, handler });
  }

  /**
   * List registered tool definitions, sorted by cost tier:
   *   api (0) → ax (1) → pixels (2) → undeclared (3)
   * Within each tier, registration order is preserved (stable sort).
   * Mirrors the sort in `@motebit/tools`'s `InMemoryToolRegistry` —
   * runtime keeps its own implementation so it stays layer-neutral
   * (see file header).
   */
  list(): ToolDefinition[] {
    const entries = [...this.tools.values()].map((t, i) => ({ def: t.definition, i }));
    entries.sort((a, b) => {
      const diff = toolModePriority(a.def.mode) - toolModePriority(b.def.mode);
      return diff !== 0 ? diff : a.i - b.i;
    });
    return entries.map(({ def }) => def);
  }
  has(name: string): boolean {
    return this.tools.has(name);
  }
  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  /**
   * Execute a tool. `call` names who a hire's receipt belongs to (a turn's
   * key, passed by that turn's loop deps, or the owner) and whose call it
   * is; it defaults to `OWNER_CALL` — every caller that names no turn is an
   * owner door. The handler receives the same `call`.
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    call: ToolCall = OWNER_CALL,
  ): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) return { ok: false, error: `Unknown tool: ${name}` };
    let result: ToolResult;
    try {
      result = await (entry.handler as CallAwareToolHandler)(args, call);
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    const carried = takeCarriedReceipt(result);
    if (carried != null) {
      this.receiptRouter?.(call.destination, carried.receipt, carried.trustCredited);
    }
    return result;
  }

  merge(other: ToolRegistry): void {
    for (const def of other.list()) {
      if (!this.tools.has(def.name)) {
        this.tools.set(def.name, {
          definition: def,
          handler: (args, call?: ToolCall) =>
            (
              other as ToolRegistry & {
                execute(n: string, a: Record<string, unknown>, c?: ToolCall): Promise<ToolResult>;
              }
            ).execute(def.name, args, call),
        });
      }
    }
  }

  /** Replace the handler for an existing tool, or register if new. */
  replace(tool: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(tool.name, { definition: tool, handler });
  }

  /**
   * Mark a registered tool `localOnly` (#943), keeping its handler — the
   * owner-connected floor applied to an entry that got here first.
   */
  markLocalOnly(name: string): void {
    const entry = this.tools.get(name);
    if (entry != null && entry.definition.localOnly !== true) {
      this.tools.set(name, { ...entry, definition: { ...entry.definition, localOnly: true } });
    }
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get size(): number {
    return this.tools.size;
  }
}
