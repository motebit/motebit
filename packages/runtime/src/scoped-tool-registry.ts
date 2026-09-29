/**
 * Scoped tool registry — a `ToolRegistry` decorator that filters
 * tool visibility and execution by an injected predicate.
 *
 * Used at the AI-loop tool registration point and at the
 * `invokeCapability` dispatch point so that proactive turns (presence
 * = tending or proactive) see only the tools the user has explicitly
 * allowed in proactive mode.
 *
 * The decorator is *not* the source of truth for which tools are
 * permitted — that's the runtime's `ProactiveScope`. This class is the
 * filter that the AI loop reads against. When the predicate returns
 * `true` for every name, the decorator behaves indistinguishably from
 * the inner registry (transparent passthrough). When it returns `false`
 * for a name:
 *
 *   - `list()` omits the tool definition (model never sees it).
 *   - `execute()` returns a `{ ok: false, error }` result with a clear
 *     message instead of running the handler.
 *   - `register()` / `replace()` / `unregister()` proxy through —
 *     scope only filters consumption, not catalog mutation.
 *   - `size` reflects the post-filter count, so the runtime's
 *     `toolRegistry.size > 0` check correctly evaluates to `false`
 *     when the proactive scope is fully restrictive.
 */

import type { ToolDefinition, ToolHandler, ToolRegistry, ToolResult } from "@motebit/sdk";
import type { ToolCall } from "./turn-principal.js";

export interface ScopedToolRegistryOptions {
  /** Returns true iff `toolName` is allowed under the current scope.
   *  Called per tool inside `list()` and once at the top of `execute()`.
   *  The function is allowed to capture mutable presence state by
   *  reference; the decorator does not memoize the predicate. */
  allows: (toolName: string) => boolean;
  /** Optional refusal text for a refused `execute()` — names WHY this
   *  scope refuses (e.g. a foreign principal's turn, #880). Absent or
   *  undefined falls back to the presence-mode message. */
  refusal?: (toolName: string) => string | undefined;
}

/** A registry whose `execute` accepts the #943 call context. */
type RoutableToolRegistry = ToolRegistry & {
  execute(name: string, args: Record<string, unknown>, call?: ToolCall): Promise<ToolResult>;
};

export class ScopedToolRegistry implements ToolRegistry {
  constructor(
    private readonly inner: ToolRegistry,
    private readonly opts: ScopedToolRegistryOptions,
  ) {}

  list(): ToolDefinition[] {
    return this.inner.list().filter((t) => this.opts.allows(t.name));
  }

  /** `call` (#943) is forwarded untouched to the inner registry. */
  async execute(name: string, args: Record<string, unknown>, call?: ToolCall): Promise<ToolResult> {
    if (!this.opts.allows(name)) {
      return {
        ok: false,
        error: this.opts.refusal?.(name) ?? `Tool "${name}" not available in current presence mode`,
      };
    }
    return (this.inner as RoutableToolRegistry).execute(name, args, call);
  }

  register(tool: ToolDefinition, handler: ToolHandler): void {
    this.inner.register(tool, handler);
  }

  replace(tool: ToolDefinition, handler: ToolHandler): void {
    if (this.inner.replace) {
      this.inner.replace(tool, handler);
    } else {
      this.inner.register(tool, handler);
    }
  }

  unregister(name: string): boolean {
    return this.inner.unregister?.(name) ?? false;
  }

  /** Post-filter count. Drives the runtime's "any tools available?" gate. */
  get size(): number {
    return this.list().length;
  }
}
