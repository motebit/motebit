/**
 * Finding 4 — check-money-authority assertion 5 must see every REFERENCE to
 * the tool-registry execute method (and the registry's handler map), not just
 * the literal `registry.execute(` call text.
 *
 * Plants one production file per aliasing form under packages/runtime/src —
 * as IN-MEMORY virtual files in the gate's own type-aware scan program
 * (`createScanProgram`, the same machinery and planting the gate's built-in
 * self-test uses), never on disk: a real file planted in a scanned tree
 * races every other gate self-test that walks it (the identity-authority
 * census counted the probes), and the repo lock is budgeted for short holds,
 * not a whole-workspace type-aware gate run. Each planted file must yield a
 * reference outside the registry's own body — and no sanctioned site lives
 * in these files, so each is a violation. Every form below executed a tool
 * raw while the regex scan stayed green.
 */
import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createScanProgram, scanFile } from "../lib/registry-execute-refs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");
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
  // The handler map is ECMAScript-private (`#tools`, unreachable by
  // construction); the private-member form is planted on a TS-private one.
  private_member:
    "export function p(r: SimpleToolRegistry) {\n" + '  return r["receiptRouter"];\n}\n',
};

describe("check-money-authority assertion 5 (type-aware)", () => {
  it("flags every aliasing form of a raw registry execute", () => {
    const virtual = new Map<string, string>();
    for (const [k, body] of Object.entries(FORMS)) {
      virtual.set(resolve(ROOT, `${DIR}/${PREFIX}${k}.ts`), HEADER + body);
    }
    const program = createScanProgram(ROOT, [], virtual);
    const missed: string[] = [];
    for (const path of virtual.keys()) {
      const rel = path.slice(ROOT.length + 1);
      const sf = program.getSourceFile(path);
      const refs = sf == null ? [] : scanFile(program, sf, rel);
      if (refs.filter((r) => !r.internal).length === 0) missed.push(rel);
    }
    expect(missed).toEqual([]);
  }, 300_000);
});
