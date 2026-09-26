/**
 * check-surface-controller-adoption — the reference rule (#805).
 *
 * A reference to the imported controller counts only when it is a VALUE use
 * that resolves (through the type checker) to the import binding. The textual
 * visitor it replaced counted any identifier with the same text, so a local
 * fork beside `type _Keep = typeof X` stayed green on every adapter.
 *
 * The tamper matrix runs against the REAL adapter files, read from disk and
 * forked in memory (the tree is never written): each of the four tampers must
 * leave zero value references, and the untouched file must have at least one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { analyzeConsumption } from "../check-surface-controller-adoption.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

const ADAPTERS: ReadonlyArray<[controller: string, path: string]> = [
  ["McpManager", "apps/mobile/src/mcp-manager.ts"],
  ["McpManager", "apps/spatial/src/mcp-manager.ts"],
  ["rotateOrThrow", "apps/web/src/key-rotation.ts"],
  ["rotateOrThrow", "apps/mobile/src/key-rotation.ts"],
  ["rotateOrThrow", "apps/desktop/src/key-rotation.ts"],
  ["performKeyRotation", "apps/cli/src/rotation.ts"],
  ["MachineRoster", "apps/cli/src/machine-roster.ts"],
  ["createMachineRosterSection", "apps/web/src/machine-roster.ts"],
  ["createMachineRosterSection", "apps/mobile/src/machine-roster.ts"],
  ["createMachineRosterSection", "apps/desktop/src/machine-roster.ts"],
];

const TAMPERS: Record<string, (x: string) => string> = {
  "name only in a comment": (x) => `\n// ${x} is only mentioned here now\n`,
  "type _Keep = typeof X": (x) => `\ntype _Keep = typeof ${x};\n`,
  "a property named X": (x) => `\nconst _o = { ${x}: 1 };\nvoid _o;\n`,
  "a used shadowing parameter X": (x) =>
    `\nexport function _shadow(${x}: number): number { return ${x} + 1; }\n`,
};

/**
 * Keep every `@motebit/surface-kit` import untouched and rename every other
 * occurrence of `x` to a local fork — the re-fork an adapter could make while
 * keeping the canonical import as decoration.
 */
function fork(src: string, x: string): string {
  const imports = /import\s*(?:type\s*)?\{[^}]*\}\s*from\s*"@motebit\/surface-kit";/g;
  const word = new RegExp(`\\b${x}\\b`, "g");
  let out = "";
  let last = 0;
  for (const m of src.matchAll(imports)) {
    out += src.slice(last, m.index).replace(word, `Local${x}`) + m[0];
    last = m.index + m[0].length;
  }
  out += src.slice(last).replace(word, `Local${x}`);
  return `${out}\nconst Local${x}: any = null;\n`;
}

function refs(text: string, controller: string): number {
  const [c] = analyzeConsumption([{ path: "probe.ts", text, controller }]);
  return c!.references;
}

describe("check-surface-controller-adoption — value references resolved by the checker", () => {
  const real = ADAPTERS.map(([controller, path]) => ({
    path,
    controller,
    text: readFileSync(resolve(ROOT, path), "utf8"),
  }));

  it("every adapter on the tree imports its controller and uses it as a value", () => {
    const results = analyzeConsumption(real);
    results.forEach((c, i) => {
      expect(c.localName, real[i]!.path).toBe(real[i]!.controller);
      expect(c.references, real[i]!.path).toBeGreaterThan(0);
    });
  });

  for (const { path, controller, text } of real) {
    for (const [name, tamper] of Object.entries(TAMPERS)) {
      it(`${path}: a local fork plus ${name} is not an adoption`, () => {
        const [c] = analyzeConsumption([
          { path, controller, text: fork(text, controller) + tamper(controller) },
        ]);
        expect(c!.localName).toBe(controller);
        expect(c!.references).toBe(0);
      });
    }
  }

  const IMPORT = `import { Ctl } from "@motebit/surface-kit";\n`;

  it.each([
    ["a call", "Ctl();"],
    ["new", "new Ctl();"],
    ["a static member call", "Ctl.gated();"],
    ["a class extends", "export class A extends Ctl {}"],
    ["a shorthand property", "export const o = { Ctl };"],
    ["an argument", "use(Ctl);"],
    ["an instantiation expression", "export const f = Ctl<number>;"],
  ])("counts %s", (_label, body) => {
    expect(refs(IMPORT + body, "Ctl")).toBeGreaterThan(0);
  });

  it("follows an `as` rename to the local binding", () => {
    const text = `import { Ctl as Local } from "@motebit/surface-kit";\nLocal();\nCtl();\n`;
    const [c] = analyzeConsumption([{ path: "p.ts", text, controller: "Ctl" }]);
    expect(c!.localName).toBe("Local");
    expect(c!.references).toBe(1);
  });

  it.each([
    ["implements", "export class A implements Ctl {}"],
    ["an interface extends", "export interface I extends Ctl {}"],
    ["a type annotation", "export const x: Ctl = null as never;"],
    ["an `as typeof` cast", "export const y = null as unknown as typeof Ctl;"],
    ["an ambient declaration", "declare const z: typeof Ctl;"],
    ["a property access name", "declare const o: any;\no.Ctl();"],
    ["a block-scoped shadow", "{ const Ctl = () => 1; Ctl(); }"],
    ["a re-export only", "export { Ctl };"],
    ["a default export only", "export default Ctl;"],
    ["a string", `export const s = "Ctl";`],
  ])("does not count %s", (_label, body) => {
    expect(refs(IMPORT + body, "Ctl")).toBe(0);
  });

  it("ignores a type-only import, and an import from elsewhere", () => {
    for (const text of [
      `import type { Ctl } from "@motebit/surface-kit";\nCtl();\n`,
      `import { type Ctl } from "@motebit/surface-kit";\nCtl();\n`,
      `import { Ctl } from "./local-fork";\nCtl();\n`,
    ]) {
      const [c] = analyzeConsumption([{ path: "p.ts", text, controller: "Ctl" }]);
      expect(c!.localName, text).toBeNull();
    }
  });
});
