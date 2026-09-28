/**
 * Which tools a surface may offer to OTHER principals — advertised as
 * network capabilities when it serves, or listed by its MCP server.
 *
 * The rule is carried by the tool: `ToolDefinition.localOnly` (#874). A
 * tool that acts for this motebit's owner against its own interior (its
 * paid-task ledger, its relay account, its hiring) declares it, and no
 * surface can advertise it by forgetting a name.
 *
 * `LOCAL_TOOL_NAMES` is the remainder: builtins defined in
 * `@motebit/tools` that are interior by nature but do not yet declare
 * the attribute. It exists so every surface excludes the SAME set (mobile
 * had silently dropped `self_reflect`); it shrinks to empty as those
 * definitions gain `localOnly: true`.
 */

import type { ToolDefinition } from "@motebit/sdk";

export const LOCAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "read_file",
  "recall_memories",
  "list_events",
  "self_reflect",
]);

/** True when this tool may be offered to another principal. */
export function isServedTool(tool: Pick<ToolDefinition, "name" | "localOnly">): boolean {
  return tool.localOnly !== true && !LOCAL_TOOL_NAMES.has(tool.name);
}

/** The capability names a serving surface advertises — every served tool, nothing else. */
export function servedToolNames(
  tools: ReadonlyArray<Pick<ToolDefinition, "name" | "localOnly">>,
): string[] {
  return tools.filter(isServedTool).map((t) => t.name);
}
