import type { ToolDefinition, ToolHandler } from "@motebit/sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const shellExecDefinition: ToolDefinition = {
  name: "shell_exec",
  description:
    "Execute a shell command and return stdout/stderr. Requires user approval. Use for running scripts, checking system state, etc.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The command to execute" },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Command arguments",
      },
      cwd: { type: "string", description: "Working directory (optional)" },
    },
    required: ["command"],
  },
  requiresApproval: true,
};

export function createShellExecHandler(): ToolHandler {
  return async (args) => {
    const command = args.command as string;
    if (!command) return { ok: false, error: "Missing required parameter: command" };

    const cmdArgs = (args.args as string[] | undefined) ?? [];
    const cwd = args.cwd as string | undefined;

    try {
      const { stdout, stderr } = await execFileAsync(command, cmdArgs, {
        cwd,
        timeout: 30000,
        maxBuffer: 1024 * 1024,
      });

      const output = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
      return { ok: true, data: output.slice(0, 8000) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Exec error: ${msg}` };
    }
  };
}
