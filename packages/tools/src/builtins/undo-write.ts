import type { ToolDefinition, ToolHandler } from "@motebit/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPathAllowed, isProtectedStatePath } from "./path-sandbox.js";
import { backupExisting } from "./write-file.js";

/** @internal */
export const undoWriteDefinition: ToolDefinition = {
  name: "undo_write",
  mode: "api",
  description:
    "Undo the last write_file operation by restoring from backup. Requires user approval.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to restore" },
    },
    required: ["path"],
  },
  requiresApproval: true,
};

export function createUndoWriteHandler(config?: {
  allowedPaths?: string[];
  backupDir?: string;
}): ToolHandler {
  const allowedPaths = config?.allowedPaths;
  const backupDir =
    config?.backupDir ??
    path.join(process.env["HOME"] ?? process.env["USERPROFILE"] ?? "/tmp", ".motebit", "backups");

  return async (args) => {
    const filePath = args.path as string;
    if (!filePath) return { ok: false, error: "Missing required parameter: path" };

    // Validate target path against sandbox
    if (allowedPaths && allowedPaths.length > 0) {
      const check = isPathAllowed(filePath, allowedPaths);
      if (!check.allowed) {
        return { ok: false, error: check.error ?? "Access denied" };
      }
    }

    // motebit's own state (identity key files) is never restored over: a
    // pre-rotation config "restored" over the current one destroys the key
    // the rotation committed.
    if (isProtectedStatePath(filePath)) {
      return {
        ok: false,
        error: `Access denied: "${filePath}" is inside motebit's own state (identity keys); the file tools never write there`,
      };
    }

    const resolved = path.resolve(filePath);

    try {
      // Find the most recent backup for this path
      const entries = await fs.readdir(backupDir).catch(() => [] as string[]);
      const metaFiles = entries.filter((e) => e.endsWith(".meta.json"));

      let latestBackup: { path: string; timestamp: number } | null = null;

      for (const metaFile of metaFiles) {
        try {
          const metaContent = await fs.readFile(path.join(backupDir, metaFile), "utf-8");
          const meta = JSON.parse(metaContent) as {
            originalPath: string;
            timestamp: number;
            createdBy?: string;
          };
          // A copy undo_write kept of what it overwrote is kept bytes, never an
          // undo target: selecting it would re-apply the undone write.
          if (meta.originalPath === resolved && meta.createdBy !== "undo_write") {
            if (!latestBackup || meta.timestamp > latestBackup.timestamp) {
              latestBackup = {
                path: path.join(backupDir, metaFile.replace(".meta.json", "")),
                timestamp: meta.timestamp,
              };
            }
          }
        } catch {
          // Corrupt or unreadable meta file — skip
        }
      }

      if (!latestBackup) {
        return { ok: false, error: `No backup found for "${resolved}"` };
      }

      // Read backup and restore. The CURRENT bytes are kept first (the undo
      // is itself undoable) — or the restore does not happen.
      const backupContent = await fs.readFile(latestBackup.path, "utf-8");
      const kept = await backupExisting(resolved, backupDir, "undo_write");
      if (!kept.ok) return { ok: false, error: kept.error };
      await fs.writeFile(resolved, backupContent, "utf-8");

      return {
        ok: true,
        data: `Restored "${resolved}" from backup (${backupContent.length} bytes, backed up at ${new Date(latestBackup.timestamp).toISOString()})`,
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Undo error: ${msg}` };
    }
  };
}
