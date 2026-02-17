import type { ToolDefinition, ToolHandler } from "@motebit/sdk";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

export const readFileDefinition: ToolDefinition = {
  name: "read_file",
  description: "Read the contents of a local file. Path is relative to the working directory.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path to read" },
    },
    required: ["path"],
  },
};

export function createReadFileHandler(allowedPaths?: string[]): ToolHandler {
  return async (args) => {
    const filePath = args.path as string;
    if (!filePath) return { ok: false, error: "Missing required parameter: path" };

    // Sandbox check: resolve symlinks to prevent escape
    if (allowedPaths && allowedPaths.length > 0) {
      let canonical: string;
      try {
        canonical = fsSync.realpathSync(path.resolve(filePath));
      } catch {
        return { ok: false, error: `Cannot resolve path "${filePath}"` };
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
      const content = await fs.readFile(resolved, "utf-8");
      return { ok: true, data: content.slice(0, 16000) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Read error: ${msg}` };
    }
  };
}
