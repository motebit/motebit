/**
 * Which tools a surface may offer to OTHER principals — advertised as
 * network capabilities when it serves, or listed by its MCP server.
 *
 * The rule is carried by the tool: `ToolDefinition.localOnly` (#874). A
 * tool that acts for this motebit's owner against its own interior (its
 * filesystem, shell, memory, transcripts, goals, browser session, paid-task
 * ledger, relay account, hiring) declares it, and no surface can advertise
 * it by forgetting a name.
 *
 * There is no name list beside the attribute. #874 left a residual
 * `LOCAL_TOOL_NAMES` for builtins that did not yet declare it; #880 marked
 * every one of them at its definition and deleted the list, so the
 * definition is the one source of truth. (A name list was also how `/serve`
 * came to serve `write_file` — its own list had never named it.)
 */

import type { ToolDefinition } from "@motebit/sdk";

/** True when this tool may be offered to another principal. */
export function isServedTool(tool: Pick<ToolDefinition, "localOnly">): boolean {
  return tool.localOnly !== true;
}

/** The capability names a serving surface advertises — every served tool, nothing else. */
export function servedToolNames(
  tools: ReadonlyArray<Pick<ToolDefinition, "name" | "localOnly">>,
): string[] {
  return tools.filter(isServedTool).map((t) => t.name);
}
