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

export class SimpleToolRegistry implements ToolRegistry {
  private tools = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();

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

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) return { ok: false, error: `Unknown tool: ${name}` };
    try {
      return await entry.handler(args);
    } catch (err: unknown) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  merge(other: ToolRegistry): void {
    for (const def of other.list()) {
      if (!this.tools.has(def.name)) {
        this.tools.set(def.name, {
          definition: def,
          handler: (args) => other.execute(def.name, args),
        });
      }
    }
  }

  /** Replace the handler for an existing tool, or register if new. */
  replace(tool: ToolDefinition, handler: ToolHandler): void {
    this.tools.set(tool.name, { definition: tool, handler });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get size(): number {
    return this.tools.size;
  }
}
