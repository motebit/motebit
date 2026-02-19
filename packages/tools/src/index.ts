import type { ToolDefinition, ToolResult, ToolHandler, ToolRegistry } from "@motebit/sdk";

export type { ToolDefinition, ToolResult, ToolHandler, ToolRegistry } from "@motebit/sdk";

export * from "./builtins/index.js";
export * from "./search-provider.js";
export { BraveSearchProvider } from "./providers/brave-search.js";
export { DuckDuckGoSearchProvider } from "./providers/duckduckgo.js";

// === InMemoryToolRegistry ===

export class InMemoryToolRegistry implements ToolRegistry {
  private tools = new Map<string, { definition: ToolDefinition; handler: ToolHandler }>();

  register(tool: ToolDefinition, handler: ToolHandler): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, { definition: tool, handler });
  }

  list(): ToolDefinition[] {
    return [...this.tools.values()].map((t) => t.definition);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)?.definition;
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const entry = this.tools.get(name);
    if (!entry) {
      return { ok: false, error: `Unknown tool: ${name}` };
    }
    try {
      return await entry.handler(args);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  /** Merge tools from another registry (e.g. MCP-discovered tools). */
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

  get size(): number {
    return this.tools.size;
  }
}
