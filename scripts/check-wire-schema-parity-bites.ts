/**
 * Drift defense — the wire-schema type-parity check (drift invariant #22)
 * must BITE, not just exist.
 *
 * Each `packages/wire-schemas/src/*.ts` carries a `_*_TYPE_PARITY` block that
 * asserts the zod schema and its `@motebit/protocol` type agree on the wire.
 * Each assertion has the form:
 *
 *     type _ForwardCheck = ParityForward<Protocol, z.infer<typeof Schema>>;
 *     export const _X_TYPE_PARITY: { forward: _ForwardCheck; ... } = {
 *       forward: true,        // <- LIVE: `_ForwardCheck` resolves to `true`
 *       ...                   //    only when parity holds, else `never`, and
 *     };                      //    `true` is not assignable to `never` → tsc fails.
 *
 * The original blocks were written `forward: true as _ForwardCheck`. That cast
 * is the bug this gate forbids: `true as never` is a LEGAL assertion (never is
 * a subtype of true), so a check that resolves to `never` on drift is
 * swallowed and `tsc` passes through real drift. The whole parity defense was
 * inert for that reason (see `docs/parity-inventory.md`). The casts were
 * removed once the check was made artifact-free; this gate keeps them gone —
 * re-introducing the idiom anywhere under `packages/wire-schemas/src` silently
 * re-inerts #22 for that schema, exactly the regression class the parity work
 * was meant to close for good.
 *
 * Mechanism, not vigilance: a reviewer cannot be relied on to notice a
 * re-added `as _Check` cast. This gate makes the regression unrepresentable.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIRE_SCHEMA_SRC = resolve(REPO_ROOT, "packages/wire-schemas/src");

// The forbidden idiom: `true as _<Alias>` (or any `<value> as _<Alias>` that
// could swallow a parity `never`). Pinned to the leading-underscore alias
// convention the parity blocks use, so ordinary `x as Foo` casts elsewhere are
// unaffected.
const FORBIDDEN = /\btrue\s+as\s+_\w+/;

interface Violation {
  file: string;
  line: number;
  text: string;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = resolve(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...tsFiles(abs));
    } else if (entry.endsWith(".ts")) {
      out.push(abs);
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const abs of tsFiles(WIRE_SCHEMA_SRC)) {
  const lines = readFileSync(abs, "utf-8").split("\n");
  lines.forEach((text, i) => {
    if (FORBIDDEN.test(text)) {
      violations.push({ file: relative(REPO_ROOT, abs), line: i + 1, text: text.trim() });
    }
  });
}

if (violations.length > 0) {
  console.error(`Wire-schema parity cast violations (${violations.length}):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}`);
    console.error(`    ${v.text}`);
  }
  console.error(
    `\nThe \`true as _Alias\` cast swallows the \`never\` a drifted parity check resolves to,\n` +
      `re-inerting drift invariant #22 for that schema. Drop the cast: a bare \`forward: true\`\n` +
      `keeps the check live (it typechecks only when parity holds). See the gate header and\n` +
      `docs/parity-inventory.md.`,
  );
  process.exit(1);
}

console.log(
  `check-wire-schema-parity-bites: OK — no inert parity casts in packages/wire-schemas/src`,
);
