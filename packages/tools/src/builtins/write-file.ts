import type { ToolDefinition, ToolHandler } from "@motebit/sdk";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

export const writeFileDefinition: ToolDefinition = {
  name: "write_file",
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

export function createWriteFileHandler(allowedPaths?: string[]): ToolHandler {
  return async (args) => {
    const filePath = args.path as string;
    const content = args.content as string;
    if (!filePath || content === undefined)
      return { ok: false, error: "Missing required parameters: path, content" };

    // Sandbox check: resolve symlinks to prevent escape (handle ENOENT for new files)
    if (allowedPaths && allowedPaths.length > 0) {
      let canonical: string;
      try {
        canonical = fsSync.realpathSync(path.resolve(filePath));
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          try {
            const parentCanonical = fsSync.realpathSync(path.dirname(path.resolve(filePath)));
            canonical = path.join(parentCanonical, path.basename(filePath));
          } catch {
            return { ok: false, error: `Cannot resolve parent directory for "${filePath}"` };
          }
        } else {
          return { ok: false, error: `Cannot resolve path "${filePath}"` };
        }
      }
      const allowed = allowedPaths.some((p) => {
        try {
          const resolvedAllow = fsSync.realpathSync(path.resolve(p));
          if (canonical === resolvedAllow) return true;
          const prefix = resolvedAllow.endsWith("/") ? resolvedAllow : resolvedAllow + "/";
          return canonical.startsWith(prefix);
        } catch { return false; }
      });
      if (!allowed) {
        return { ok: false, error: `Access denied: "${canonical}" is outside allowed paths` };
      }
    }

    const resolved = path.resolve(filePath);

    try {
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, content, "utf-8");
      return { ok: true, data: `Written ${content.length} bytes to ${resolved}` };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Write error: ${msg}` };
    }
  };
}
