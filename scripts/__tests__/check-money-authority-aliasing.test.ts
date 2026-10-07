/**
 * Finding 4 — check-money-authority assertion 5 must see every REFERENCE to
 * the tool-registry execute method (and the registry's handler map), not just
 * the literal `registry.execute(` call text.
 *
 * Plants one production file per aliasing form under packages/runtime/src,
 * runs the real gate once, and requires each planted file to be named in a
 * red result. Every form below executed a tool raw while the regex scan
 * stayed green.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "check-money-authority.ts");
const DIR = "packages/runtime/src";
const PREFIX = "__money_alias_probe__";

const HEADER =
  'import type { ToolRegistry } from "@motebit/protocol";\n' +
  'import { SimpleToolRegistry } from "./simple-tool-registry.js";\n' +
  "void SimpleToolRegistry;\n";

const FORMS: Record<string, string> = {
  alias: 'export function p(r: ToolRegistry) {\n  const e = r.execute;\n  return e("t", {});\n}\n',
  destructure:
    'export function p(r: ToolRegistry) {\n  const { execute } = r;\n  return execute("t", {});\n}\n',
  bracket: 'export function p(r: ToolRegistry) {\n  return r["execute"]("t", {});\n}\n',
  call_apply_bind:
    'export function p(r: ToolRegistry) {\n  return r.execute.call(r, "t", {});\n}\n',
  callback:
    'function run(f: (n: string, a: Record<string, unknown>) => unknown) {\n  return f("t", {});\n}\n' +
    "export function p(r: ToolRegistry) {\n  return run(r.execute.bind(r));\n}\n",
  cast:
    "export function p(r: unknown) {\n" +
    '  return (r as SimpleToolRegistry as unknown as { execute(n: string, a: object): unknown }).execute("t", {});\n}\n',
  handler_map:
    "export function p(r: SimpleToolRegistry) {\n" +
    '  return r["tools"].get("t")?.handler({});\n}\n',
};

describe("check-money-authority assertion 5 (type-aware)", () => {
  it("flags every aliasing form of a raw registry execute", () => {
    const files = Object.keys(FORMS).map((k) => `${DIR}/${PREFIX}${k}.ts`);
    try {
      for (const [k, body] of Object.entries(FORMS)) {
        writeFileSync(resolve(ROOT, `${DIR}/${PREFIX}${k}.ts`), HEADER + body);
      }
      const result = spawnSync("npx", ["tsx", SCRIPT], { encoding: "utf-8", cwd: ROOT });
      const out = `${result.stdout}\n${result.stderr}`;
      expect(result.status).toBe(1);
      const missed = files.filter((f) => !out.includes(f));
      expect(missed).toEqual([]);
    } finally {
      for (const f of files) rmSync(resolve(ROOT, f), { force: true });
    }
  }, 300_000);
});
