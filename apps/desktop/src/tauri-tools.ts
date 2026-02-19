/**
 * Tauri-privileged tool definitions — read_file, write_file, shell_exec.
 *
 * These tools delegate to Rust invoke handlers (read_file_tool, write_file_tool,
 * shell_exec_tool) which have full OS access. They only work in the Tauri desktop
 * context. Security is handled by the governance/approval flow in the runtime —
 * no redundant checks here.
 */

import type { ToolDefinition, ToolHandler } from "@motebit/sdk";
import { RiskLevel, DataClass, SideEffect } from "@motebit/sdk";
import type { InvokeFn } from "./tauri-storage.js";

// === read_file ===

export const tauriReadFileDefinition: ToolDefinition = {
  name: "read_file",
  description: "Read the contents of a file on the local filesystem.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path to read" },
    },
    required: ["path"],
  },
  riskHint: {
    risk: RiskLevel.R0_READ,
    dataClass: DataClass.PRIVATE,
    sideEffect: SideEffect.NONE,
  },
};

export function createTauriReadFileHandler(invoke: InvokeFn): ToolHandler {
  return async (args) => {
    const filePath = args.path as string;
    if (!filePath) return { ok: false, error: "Missing required parameter: path" };

    try {
      const content = await invoke<string>("read_file_tool", { path: filePath });
      // Truncate to 16KB to avoid blowing up context
      return { ok: true, data: content.slice(0, 16000) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  };
}

// === write_file ===

export const tauriWriteFileDefinition: ToolDefinition = {
  name: "write_file",
  description:
    "Write content to a file on the local filesystem. Creates parent directories if needed. Requires user approval.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute or relative file path to write" },
      content: { type: "string", description: "Content to write to the file" },
    },
    required: ["path", "content"],
  },
  requiresApproval: true,
  riskHint: {
    risk: RiskLevel.R2_WRITE,
    dataClass: DataClass.PRIVATE,
    sideEffect: SideEffect.REVERSIBLE,
  },
};

export function createTauriWriteFileHandler(invoke: InvokeFn): ToolHandler {
  return async (args) => {
    const filePath = args.path as string;
    const content = args.content as string;
    if (!filePath || content === undefined) {
      return { ok: false, error: "Missing required parameters: path, content" };
    }

    try {
      const result = await invoke<string>("write_file_tool", { path: filePath, content });
      return { ok: true, data: result };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  };
}

// === shell_exec ===

interface ShellExecResult {
  stdout: string;
  stderr: string;
  exit_code: number;
}

export const tauriShellExecDefinition: ToolDefinition = {
  name: "shell_exec",
  description:
    "Execute a shell command and return stdout, stderr, and exit code. Requires user approval. Use for running scripts, checking system state, etc.",
  inputSchema: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute (passed to sh -c)" },
      cwd: { type: "string", description: "Working directory (optional)" },
    },
    required: ["command"],
  },
  requiresApproval: true,
  riskHint: {
    risk: RiskLevel.R3_EXECUTE,
    dataClass: DataClass.PRIVATE,
    sideEffect: SideEffect.IRREVERSIBLE,
  },
};

export function createTauriShellExecHandler(invoke: InvokeFn): ToolHandler {
  return async (args) => {
    const command = args.command as string;
    if (!command) return { ok: false, error: "Missing required parameter: command" };

    const cwd = args.cwd as string | undefined;

    try {
      const result = await invoke<ShellExecResult>("shell_exec_tool", {
        command,
        cwd: cwd ?? null,
      });
      return {
        ok: result.exit_code === 0,
        data: {
          stdout: result.stdout.slice(0, 8000),
          stderr: result.stderr.slice(0, 8000),
          exitCode: result.exit_code,
        },
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  };
}
