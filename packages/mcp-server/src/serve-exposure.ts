import type { ToolDefinition } from "@motebit/sdk";

/**
 * Whether an MCP server may list or execute this tool, and whether a
 * surface may advertise it as a network capability.
 *
 * A tool marked `localOnly` (protocol `ToolDefinition.localOnly`, #874)
 * acts for the motebit's owner against its own interior — its
 * paid-task ledger, its relay account, its hiring — and is never served
 * to another principal. The attribute travels on the definition, so no
 * per-surface name list can forget it.
 */
export function isServableTool(tool: Pick<ToolDefinition, "localOnly">): boolean {
  return tool.localOnly !== true;
}
