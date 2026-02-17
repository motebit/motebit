import type { ToolDefinition, ToolHandler } from "@motebit/sdk";
import * as fs from "node:fs/promises";
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

    const resolved = path.resolve(filePath);

    if (allowedPaths && allowedPaths.length > 0) {
      const allowed = allowedPaths.some((p) => resolved.startsWith(path.resolve(p)));
      if (!allowed) {
        return { ok: false, error: `Access denied: "${resolved}" is outside allowed paths` };
      }
    }

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
