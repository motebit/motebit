import type { ToolDefinition, ToolHandler } from "@motebit/sdk";
import * as fs from "node:fs/promises";
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

    const resolved = path.resolve(filePath);

    // Sandbox check
    if (allowedPaths && allowedPaths.length > 0) {
      const allowed = allowedPaths.some((p) => resolved.startsWith(path.resolve(p)));
      if (!allowed) {
        return { ok: false, error: `Access denied: "${resolved}" is outside allowed paths` };
      }
    }

    try {
      const content = await fs.readFile(resolved, "utf-8");
      return { ok: true, data: content.slice(0, 16000) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Read error: ${msg}` };
    }
  };
}
