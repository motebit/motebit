import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineMotebitTest } from "../../vitest.shared.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ajvFormatsStub = path.resolve(__dirname, "src/__tests__/__stubs__/ajv-formats-stub.cjs");

export default defineMotebitTest({
  thresholds: { statements: 73, branches: 80, functions: 81, lines: 73 },
  vite: {
    plugins: [
      {
        name: "stub-ajv-formats",
        enforce: "pre",
        resolveId(id) {
          if (id === "ajv-formats" || id.startsWith("ajv-formats/")) {
            return ajvFormatsStub;
          }
          return null;
        },
      },
    ],
  },
  extra: {
    setupFiles: ["./src/__tests__/__stubs__/patch-ajv.ts"],
    server: {
      deps: {
        // Inline the MCP SDK and its transitive deps so Vite processes them
        // (allowing our plugin to intercept the ajv-formats import).
        inline: ["@modelcontextprotocol/sdk", "ajv-formats", "ajv"],
      },
    },
  },
});
