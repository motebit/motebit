import type { ToolDefinition, ToolHandler } from "@motebit/sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPathAllowed } from "./path-sandbox.js";

/** @internal */
export const readFileDefinition: ToolDefinition = {
  name: "read_file",
  mode: "api",
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
      const check = isPathAllowed(filePath, allowedPaths);
      if (!check.allowed) {
        return { ok: false, error: check.error ?? "Access denied" };
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
