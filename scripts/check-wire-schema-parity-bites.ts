/**
 * Drift defense — the wire-schema type-parity check (drift invariant #22)
 * must BITE, not just exist.
 *
 * Each `packages/wire-schemas/src/*.ts` schema carries a `_*_TYPE_PARITY`
 * block that asserts the zod schema and its `@motebit/protocol` type agree on
 * the wire (`ParityForward`/`ParityReverse` over the shared `Relax` normalizer
 * in `src/__parity/check.ts`). The assertion is LIVE: the value lines are bare
 *
 *     forward: true,
 *
 * which typechecks only when the parity alias resolves to `true`; on drift it
 * resolves to `never`, and `true` is not assignable to `never`, so `tsc` fails.
 *
 * This gate forbids the moves that silently re-inert that check — the
 * regression that left the whole defense dead for its entire prior life (the
 * wire-schema-parity-cast-hole, mapped in `docs/parity-inventory.md`):
 *
 *   1. A CAST on the value: `forward: true as _ForwardCheck` (or `as never`,
 *      `(true) as _X`, a line-split `true as\n  _X`, `true as unknown as _X`).
 *      `true as never` is a legal assertion that swallows the drift `never`.
 *   2. A TS SUPPRESSION on the value line: `@ts-expect-error` / `@ts-ignore`.
 *   3. DELETING the block, or adding a new schema with no block — coverage
 *      silently drops. So a schema-defining file MUST carry a parity block.
 *
 * It forbids the cast/suppression IDIOMS and requires a block per schema; it
 * does not (cannot, textually) foreclose every conceivable false-pass (e.g.
 * widening a `_*Check` alias to `boolean`, or an `any` smuggled into the
 * parity type chain). Those remain reviewer-caught. The intentional escape
 * hatch for a genuine zod representational limit is NOT a cast — it is a typed
 * `// parity-divergence:` correction of the schema-inferred type (see the A6
 * waiver at `transparency-declaration.ts`, and `wire-schemas/CLAUDE.md` rule 5).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIRE_SCHEMA_SRC = resolve(REPO_ROOT, "packages/wire-schemas/src");

// `true` (optionally parenthesized) followed by `as` — any cast on the parity
// literal. Tested against whitespace-normalized source so a line-split cast
// (`true as\n  _ForwardCheck`) is caught, and against `(true) as`.
const CAST = /\btrue\b\s*\)?\s+as\b/;
const TS_SUPPRESS = /@ts-(expect-error|ignore)\b/;
// A schema-DEFINING file (not the index barrel, which re-exports via
// `export { …_SCHEMA_ID } from`).
const DEFINES_SCHEMA = /export\s+const\s+\w*_SCHEMA_ID\b/;
const HAS_PARITY = /\bParity(Forward|Reverse)\s*</;

interface Violation {
  file: string;
  kind: string;
  detail: string;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__") continue;
    const abs = resolve(dir, entry);
    if (statSync(abs).isDirectory()) {
      out.push(...tsFiles(abs));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(abs);
    }
  }
  return out;
}

const violations: Violation[] = [];
for (const abs of tsFiles(WIRE_SCHEMA_SRC)) {
  const raw = readFileSync(abs, "utf-8");
  const rel = relative(REPO_ROOT, abs);
  const normalized = raw.replace(/\s+/g, " ");

  if (CAST.test(normalized)) {
    violations.push({
      file: rel,
      kind: "cast-on-parity-true",
      detail:
        "a `true as …` cast (incl. `as never`, parenthesized, or line-split) swallows the drift `never`",
    });
  }
  if (TS_SUPPRESS.test(raw)) {
    violations.push({
      file: rel,
      kind: "ts-suppression",
      detail: "@ts-expect-error / @ts-ignore can suppress a drifted parity error",
    });
  }
  if (DEFINES_SCHEMA.test(raw) && !HAS_PARITY.test(raw)) {
    violations.push({
      file: rel,
      kind: "missing-parity-block",
      detail:
        "schema-defining file (exports a *_SCHEMA_ID) carries no ParityForward/ParityReverse block",
    });
  }
}

if (violations.length > 0) {
  console.error(`Wire-schema parity-bite violations (${violations.length}):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    ${v.kind}: ${v.detail}`);
  }
  console.error(
    `\nDrift invariant #22 must BITE. A parity value line must be a bare \`forward: true\`\n` +
      `(it typechecks only when parity holds); a cast or @ts- suppression swallows the drift\n` +
      `\`never\`, and every schema-defining file must carry a parity block. For a genuine zod\n` +
      `representational limit, use the typed \`// parity-divergence:\` waiver (not a cast) — see\n` +
      `transparency-declaration.ts and docs/parity-inventory.md.`,
  );
  process.exit(1);
}

console.log(
  `check-wire-schema-parity-bites: OK — all schema files carry a live parity block, no inert casts/suppressions`,
);
