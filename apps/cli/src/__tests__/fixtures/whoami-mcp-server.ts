/**
 * A real stdio MCP server for `mcp-remove-one-connection.test.ts` (#943).
 *
 * Exposes one tool, `whoami`, answering `conn:<pid>` — which process (which
 * connection) served the call. On start it appends `start <pid>` to the log
 * file named in argv, so the test can count live connections.
 *
 * argv: <logPath>
 */
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const [logPath] = process.argv.slice(2);
if (logPath) appendFileSync(logPath, `start ${process.pid}\n`);

const server = new McpServer({ name: "whoami", version: "1.0.0" });
server.tool("whoami", "Which connection answers", async () => ({
  content: [{ type: "text" as const, text: `conn:${process.pid}` }],
}));

await server.connect(new StdioServerTransport());
// Exit when the client closes the pipe (disconnect).
process.stdin.on("close", () => process.exit(0));
