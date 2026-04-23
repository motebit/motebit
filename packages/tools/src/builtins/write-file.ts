import type { ToolDefinition, ToolHandler } from "@motebit/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPathAllowed } from "./path-sandbox.js";

export interface WriteFileConfig {
  allowedPaths?: string[];
  /** Directory for pre-write backups. Default: ~/.motebit/backups */
  backupDir?: string;
  /** Whether to create backups before overwriting. Default: true */
  enableBackup?: boolean;
}

export const writeFileDefinition: ToolDefinition = {
  name: "write_file",
  mode: "api",
  description:
    "Write content to a local file. Creates directories if needed. Requires user approval.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to write" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["path", "content"],
  },
  requiresApproval: true,
};

export function createWriteFileHandler(config?: WriteFileConfig | string[]): ToolHandler {
  // Backward compat: accept string[] as allowedPaths
  const cfg: WriteFileConfig = Array.isArray(config) ? { allowedPaths: config } : (config ?? {});
  const allowedPaths = cfg.allowedPaths;
  const enableBackup = cfg.enableBackup !== false;
  const backupDir =
    cfg.backupDir ??
    path.join(process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp", ".motebit", "backups");

  return async (args) => {
    const filePath = args.path as string;
    const content = args.content as string;
    if (!filePath || content === undefined)
      return { ok: false, error: "Missing required parameters: path, content" };

    // Sandbox check: resolve symlinks to prevent escape
    if (allowedPaths && allowedPaths.length > 0) {
      const check = isPathAllowed(filePath, allowedPaths);
      if (!check.allowed) {
        return { ok: false, error: check.error ?? "Access denied" };
      }
    }

    const resolved = path.resolve(filePath);

    try {
      // Pre-write backup: save existing content before overwriting
      if (enableBackup) {
        try {
          const existing = await fs.readFile(resolved, "utf-8");
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const uuid = crypto.randomUUID().slice(0, 8);
          const basename = path.basename(resolved);
          const backupPath = path.join(backupDir, `${timestamp}_${uuid}_${basename}`);
          const metaPath = backupPath + ".meta.json";

          await fs.mkdir(backupDir, { recursive: true });
          await fs.writeFile(backupPath, existing, "utf-8");
          await fs.writeFile(
            metaPath,
            JSON.stringify({
              originalPath: resolved,
              timestamp: Date.now(),
              size: existing.length,
            }),
            "utf-8",
          );
        } catch {
          // File doesn't exist yet (new file) — no backup needed. Or backup dir
          // creation failed — not blocking, proceed with write.
        }
      }

      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf-8");
      return { ok: true, data: `Written ${content.length} bytes to ${resolved}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Write error: ${msg}` };
    }
  };
}
