/**
 * Vitest setup file: patches Node.js CJS module resolution to handle the
 * ajv@6 / ajv-formats@3 incompatibility.
 *
 * ajv-formats@3 requires ajv@8+ but the monorepo pins ajv to 6.12.6.
 * We intercept require('ajv-formats') and require('ajv/dist/compile/codegen')
 * and return no-op stubs.
 */
import Module from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stubPath = path.resolve(__dirname, "ajv-formats-stub.cjs");
const codegenStubPath = path.resolve(__dirname, "ajv-codegen.cjs");

type ResolveFilename = (request: string, ...rest: unknown[]) => string;
const M = Module as unknown as { _resolveFilename: ResolveFilename };
const originalResolveFilename = M._resolveFilename;

// Clear any previously cached ajv-formats modules
const cache = require.cache;
for (const key of Object.keys(cache)) {
  if (key.includes("ajv-formats") || key.includes("ajv/dist/compile/codegen")) {
    delete cache[key];
  }
}

M._resolveFilename = function (request: string, ...rest: unknown[]): string {
  if (request === "ajv-formats" || request.startsWith("ajv-formats/")) {
    return stubPath;
  }
  if (request === "ajv/dist/compile/codegen") {
    return codegenStubPath;
  }
  return originalResolveFilename.call(this, request, ...rest);
};
