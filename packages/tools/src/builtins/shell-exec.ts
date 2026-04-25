import type { ToolDefinition, ToolHandler } from "@motebit/sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import { isDirectoryAllowed } from "./path-sandbox.js";

const execFileAsync = promisify(execFile);

// === Destructive Pattern Detection ===

/** Commands that are always destructive regardless of arguments. */
const ALWAYS_DESTRUCTIVE = new Set(["dd", "mkfs", "fdisk", "shred"]);

/**
 * Destructive command+flag combinations. Each entry is a command name
 * mapped to argument patterns that make it destructive.
 * Exported for reuse and testing.
 */
export const DESTRUCTIVE_PATTERNS: Record<string, (args: string[]) => boolean> = {
  rm: (args) => args.some((a) => /^-.*r/i.test(a) || a === "--recursive"),
  git: (args) => {
    const joined = args.join(" ");
    return (
      /reset\s+--hard/.test(joined) ||
      /push\s+--force/.test(joined) ||
      /push\s+--force-with-lease/.test(joined) ||
      /clean\s+-[a-zA-Z]*f/.test(joined) ||
      /branch\s+-D/.test(joined)
    );
  },
  chmod: (args) => args.includes("777") || args.includes("000"),
  chown: (args) => args.some((a) => /^-.*R/.test(a) || a === "--recursive"),
};

function isDestructiveCommand(command: string, args: string[]): boolean {
  const baseName = path.basename(command);
  if (ALWAYS_DESTRUCTIVE.has(baseName)) return true;
  const checker = DESTRUCTIVE_PATTERNS[baseName];
  return checker ? checker(args) : false;
}

// === Configuration ===

export interface ShellExecConfig {
  /** Commands allowed to run. Empty/undefined = deny all (fail-closed). */
  commandAllowList?: string[];
  /** Commands that are always blocked, even if allowlisted. Takes precedence. */
  commandBlockList?: string[];
  /** Paths where cwd is permitted. Uses isDirectoryAllowed(). */
  allowedPaths?: string[];
  /** Block destructive command patterns (rm -rf, git reset --hard, etc.). Default: true. */
  blockDestructive?: boolean;
}

// === Tool Definition ===

/** @internal */
export const shellExecDefinition: ToolDefinition = {
  name: "shell_exec",
  mode: "api",
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

// === Handler ===

export function createShellExecHandler(config?: ShellExecConfig): ToolHandler {
  const cfg = config ?? {};
  const allowList = cfg.commandAllowList;
  const blockList = new Set(cfg.commandBlockList ?? []);
  const allowedPaths = cfg.allowedPaths;
  const blockDestructive = cfg.blockDestructive !== false;

  return async (args) => {
    const command = args.command as string;
    if (!command) return { ok: false, error: "Missing required parameter: command" };

    const cmdArgs = (args.args as string[] | undefined) ?? [];
    const cwd = args.cwd as string | undefined;
    const baseName = path.basename(command);

    // 1. Blocklist check (always takes precedence)
    if (blockList.has(baseName)) {
      return { ok: false, error: `Command "${baseName}" is blocked` };
    }

    // 2. Destructive pattern detection
    if (blockDestructive && isDestructiveCommand(command, cmdArgs)) {
      return {
        ok: false,
        error: `Destructive command detected: "${baseName} ${cmdArgs.join(" ")}". Blocked for safety.`,
      };
    }

    // 3. Allowlist check (fail-closed: no allowlist = deny all)
    if (!allowList || allowList.length === 0) {
      return {
        ok: false,
        error: "shell_exec denied: no commands are allowlisted. Use --allow-commands to configure.",
      };
    }
    if (!allowList.includes(baseName)) {
      return {
        ok: false,
        error: `Command "${baseName}" is not in the allowed commands list: [${allowList.join(", ")}]`,
      };
    }

    // 4. Working directory sandboxing
    let resolvedCwd = cwd;
    if (allowedPaths && allowedPaths.length > 0) {
      if (cwd) {
        const check = isDirectoryAllowed(cwd, allowedPaths);
        if (!check.allowed) {
          return { ok: false, error: check.error ?? "Working directory outside allowed paths" };
        }
        resolvedCwd = check.canonical;
      } else {
        // Default to first allowed path
        resolvedCwd = allowedPaths[0];
      }
    }

    // 5. Execute
    try {
      const { stdout, stderr } = await execFileAsync(command, cmdArgs, {
        cwd: resolvedCwd,
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
