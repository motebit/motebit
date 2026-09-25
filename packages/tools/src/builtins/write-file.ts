import type { ToolDefinition, ToolHandler } from "@motebit/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPathAllowed, isProtectedStatePath } from "./path-sandbox.js";

export interface WriteFileConfig {
  allowedPaths?: string[];
  /** Directory for pre-write backups. Default: ~/.motebit/backups */
  backupDir?: string;
  /** Whether to create backups before overwriting. Default: true */
  enableBackup?: boolean;
}

/** @internal */
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

/**
 * Keep `resolved`'s current bytes in `backupDir` (created 0700; the copy and
 * its meta file created 0600, exclusively) for `undo_write`. The copy may be
 * of anything the user writes over, so it is never readable by other users.
 * `ok: true` when the file does not exist (nothing to keep) or was kept.
 */
export async function backupExisting(
  resolved: string,
  backupDir: string,
): Promise<{ ok: true; kept: string | null } | { ok: false; error: string }> {
  let existing: Buffer;
  try {
    existing = await fs.readFile(resolved);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, kept: null };
    return {
      ok: false,
      error: `Write refused: "${resolved}" exists but could not be read to back it up (${(err as NodeJS.ErrnoException).code ?? "unreadable"}); nothing was changed`,
    };
  }
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const uuid = crypto.randomUUID().slice(0, 8);
    const backupPath = path.join(backupDir, `${timestamp}_${uuid}_${path.basename(resolved)}`);
    await fs.mkdir(backupDir, { recursive: true, mode: 0o700 });
    await writeOwnerOnly(backupPath, existing);
    await writeOwnerOnly(
      backupPath + ".meta.json",
      Buffer.from(
        JSON.stringify({ originalPath: resolved, timestamp: Date.now(), size: existing.length }),
      ),
    );
    return { ok: true, kept: backupPath };
  } catch (err) {
    return {
      ok: false,
      error: `Write refused: the existing "${resolved}" could not be backed up (${err instanceof Error ? err.message : String(err)}); nothing was changed`,
    };
  }
}

/** A NEW file, 0600 from creation (exclusive), fsync'd. */
async function writeOwnerOnly(file: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export function createWriteFileHandler(config?: WriteFileConfig): ToolHandler {
  const cfg: WriteFileConfig = config ?? {};
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

    // motebit's own state (identity key files) is never a write target.
    if (isProtectedStatePath(filePath)) {
      return {
        ok: false,
        error: `Access denied: "${filePath}" is inside motebit's own state (identity keys); the file tools never write there`,
      };
    }

    const resolved = path.resolve(filePath);

    try {
      // Pre-write backup: the existing bytes are kept BEFORE they are
      // overwritten — or the write does not happen. Only a file that does not
      // exist (ENOENT) needs no backup; one that cannot be read, or a backup
      // that cannot be written, refuses the write.
      if (enableBackup) {
        const kept = await backupExisting(resolved, backupDir);
        if (!kept.ok) return { ok: false, error: kept.error };
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
