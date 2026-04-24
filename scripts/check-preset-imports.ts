/**
 * Canonical-preset import boundary.
 *
 * `@motebit/sdk` owns the canonical preset vocabulary — the color palettes,
 * approval-preset configs, risk labels, surface options, and every other
 * value in the "Presets" and "Config vocabularies" paragraphs of
 * `packages/sdk/CLAUDE.md`. These values are **public API**: per the SDK's
 * own rule 4, preset changes are semver-governed changes.
 *
 * A surface app that redeclares one of these identifiers locally — even
 * accidentally, even with "the same values" — pins a copy that will drift
 * the moment the SDK value moves. We've seen this shape:
 *
 *   apps/mobile/src/mobile-app.ts redefined APPROVAL_PRESET_CONFIGS with
 *   `balanced: { denyAbove: 4 }` while the SDK's canonical value was
 *   `denyAbove: 3`. The `balanced` preset on mobile silently allowed R4
 *   Money tasks to route through approval; on desktop and web the SDK
 *   denied them outright. Same motebit identity, different governance
 *   posture per surface.
 *
 * This gate makes that drift unrepresentable. Any `const`, `interface`,
 * `type`, or `enum` declaration in `apps/* /src` whose name matches a
 * canonical SDK identifier fails CI. Re-exports (`export { X } from ...`)
 * are not declarations and do not trip the gate — that is the intended
 * trampoline pattern for apps that want a local module path with the
 * canonical value underneath.
 *
 * Doctrine: `packages/sdk/CLAUDE.md` § Rules 3-4.
 * Meta-principle: synchronization invariants — `docs/drift-defenses.md`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Scanned apps ─────────────────────────────────────────────────────────
// Mirrors the APPS list in check-app-primitives. Add a new app here when it
// joins the monorepo.
const APPS = ["admin", "cli", "desktop", "docs", "identity", "mobile", "spatial", "web"];

// ── Canonical SDK identifiers ────────────────────────────────────────────
// Names that are exported from `@motebit/sdk` and must only be declared
// there. Sourced from `packages/sdk/src/index.ts` — adding a new canonical
// preset or config shape means adding it here. Each entry carries the SDK
// source file for the violation message so developers land on the fix
// target immediately.
const CANONICAL: Record<string, string> = {
  // Presets (packages/sdk/CLAUDE.md § "Presets")
  APPROVAL_PRESET_CONFIGS: "packages/sdk/src/approval-presets.ts",
  ApprovalPresetConfig: "packages/sdk/src/approval-presets.ts",
  COLOR_PRESETS: "packages/sdk/src/color-presets.ts",
  RISK_LABELS: "packages/sdk/src/risk-labels.ts",
  // Config vocabularies (packages/sdk/CLAUDE.md § "Config vocabularies")
  DEFAULT_GOVERNANCE_CONFIG: "packages/sdk/src/governance-config.ts",
  DEFAULT_VOICE_CONFIG: "packages/sdk/src/voice-config.ts",
  DEFAULT_APPEARANCE_CONFIG: "packages/sdk/src/appearance-config.ts",
};

// ── Declaration pattern ──────────────────────────────────────────────────
// Matches top-level declarations that would shadow a canonical SDK export.
// Deliberately does NOT match:
//   - `export { X } from "./foo"` — bare re-export trampoline, intentional
//   - `import { X } from "@motebit/sdk"` — consumer
//   - `X.field` references, object keys, string literals — not declarations
//
// Matches:
//   const X = ...
//   let X = ...
//   export const X = ...
//   export interface X { ... }
//   interface X { ... }
//   type X = ...
//   export type X = ...
//   enum X { ... }
//   class X { ... }
//
// Built per-identifier below so the error message can name the shadowed symbol.
function declarationPattern(name: string): RegExp {
  // \b before the name prevents false positives on suffixes (e.g.
  // `COLOR_PRESETS_LEGACY`). The `(?:export\s+)?` prefix handles both bare
  // and exported declarations.
  return new RegExp(
    `^(?:export\\s+)?(?:const|let|var|interface|type|enum|class)\\s+${name}\\b`,
    "m",
  );
}

// ── Re-export probe ──────────────────────────────────────────────────────
// A file is allowed to name a canonical identifier if it also re-exports it
// from `@motebit/sdk` in the same file — that's the trampoline pattern used
// in `apps/mobile/src/mobile-app.ts` so consumers can write
// `import { COLOR_PRESETS } from "./mobile-app"`. The probe accepts any
// order of identifiers in the re-export list.
function hasSdkReExport(src: string, name: string): boolean {
  const re = new RegExp(
    `export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*["']@motebit/sdk["']`,
    "m",
  );
  return re.test(src);
}

// ── Scanner ──────────────────────────────────────────────────────────────

interface Violation {
  app: string;
  file: string;
  line: number;
  name: string;
  canonicalSource: string;
}

function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (
        entry === "__tests__" ||
        entry === "node_modules" ||
        entry === "dist" ||
        entry === ".next" ||
        entry === "build" ||
        entry === "target" ||
        entry === "src-tauri"
      )
        continue;
      out.push(...walkTypeScript(path));
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      out.push(path);
    }
  }
  return out;
}

function scanFile(app: string, file: string): Violation[] {
  const src = readFileSync(file, "utf-8");
  const violations: Violation[] = [];
  const shortPath = relative(ROOT, file);

  for (const [name, canonicalSource] of Object.entries(CANONICAL)) {
    const pattern = declarationPattern(name);
    const match = pattern.exec(src);
    if (!match) continue;

    // A re-export trampoline is the one honorable reason to name this
    // symbol in a declaration-adjacent context — skip those.
    if (hasSdkReExport(src, name)) continue;

    const line = src.slice(0, match.index).split("\n").length;
    violations.push({ app, file: shortPath, line, name, canonicalSource });
  }

  return violations;
}

function main(): void {
  const all: Violation[] = [];
  for (const app of APPS) {
    for (const subdir of ["src", "app"]) {
      const dir = resolve(ROOT, "apps", app, subdir);
      const files = walkTypeScript(dir);
      for (const file of files) {
        all.push(...scanFile(app, file));
      }
    }
  }

  if (all.length === 0) {
    console.log(
      `Canonical-preset check passed — ${APPS.length} apps × ${Object.keys(CANONICAL).length} identifiers clean`,
    );
    return;
  }

  console.error(`Canonical-preset violations (${all.length}):\n`);
  let current = "";
  for (const v of all) {
    if (v.app !== current) {
      current = v.app;
      console.error(`  [${v.app}]`);
    }
    console.error(
      `    ${v.file}:${v.line} — local declaration shadows @motebit/sdk \`${v.name}\` (canonical: ${v.canonicalSource})`,
    );
  }
  console.error(
    `\nDoctrine: @motebit/sdk owns the canonical preset vocabulary (packages/sdk/CLAUDE.md § Rules 3-4).`,
  );
  console.error(
    `Fix: replace the local declaration with \`import { ${all[0].name} } from "@motebit/sdk"\`.`,
  );
  console.error(
    `If you need a local module trampoline, add \`export { ${all[0].name} } from "@motebit/sdk"\` alongside.`,
  );
  process.exit(1);
}

main();
