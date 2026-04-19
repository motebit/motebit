/**
 * Scene-primitive drift gate (invariant #26).
 *
 * Enforces: any module that declares a SpatialExpression kind (via
 * `registerSpatialDataModule`) AND directly binds Three.js geometry to
 * render it MUST live in `@motebit/render-engine`, not inline in an app.
 *
 * The shape of drift this prevents:
 *
 *   Someone adds a new structural concept to the scene — say, goals-as-
 *   attractors, or peer-agents-as-creatures. Copy the credential-
 *   satellites file into apps/<their-surface>/src/, tweak the geometry,
 *   call `registerSpatialDataModule({kind: "attractor", name: "goals"})`,
 *   ship. Now the scene primitive lives inside an app, other surfaces
 *   can't reuse it, and if the types ever widen, only one surface picks
 *   up the change.
 *
 * The guard: if an app-layer file imports `three` AND calls
 * `registerSpatialDataModule`, it's an inline scene primitive — reject.
 *
 * Allowlist: files actively staged for extraction to @motebit/render-engine.
 * Every entry must name the follow-up pass that removes it. The list
 * shrinks to zero over time; that is the point.
 *
 * Exit 1 on violation. Runs in CI via `pnpm check`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Allowlist ──────────────────────────────────────────────────────────
// Files that legitimately inline a scene primitive *today*, pending
// extraction. Removing an entry means the extraction has landed and the
// file either (a) moved to @motebit/render-engine or (b) no longer
// declares a SpatialExpression inline.
const ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: "apps/spatial/src/receipt-satellites.ts",
    reason:
      "receipts are the second extraction target; CredentialSatelliteRenderer moved to @motebit/render-engine on 2026-04-19, ReceiptSatelliteCoordinator follows in the next pass",
  },
];

// ── Scanner ────────────────────────────────────────────────────────────

interface Violation {
  file: string;
  detail: string;
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
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__") continue;
    const full = join(dir, entry);
    let s;
    try {
      s = statSync(full);
    } catch {
      continue;
    }
    if (s.isDirectory()) {
      out.push(...walkTypeScript(full));
    } else if (
      (entry.endsWith(".ts") || entry.endsWith(".tsx")) &&
      !entry.endsWith(".d.ts") &&
      !entry.endsWith(".test.ts") &&
      !entry.endsWith(".test.tsx")
    ) {
      out.push(full);
    }
  }
  return out;
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  const appsDir = join(ROOT, "apps");
  const allowSet = new Set(ALLOWLIST.map((e) => e.path));

  let apps: string[];
  try {
    apps = readdirSync(appsDir).filter((n) => {
      try {
        return statSync(join(appsDir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return violations;
  }

  for (const app of apps) {
    const srcDir = join(appsDir, app, "src");
    const files = walkTypeScript(srcDir);
    for (const file of files) {
      const rel = relative(ROOT, file);
      if (allowSet.has(rel)) continue;
      const source = readFileSync(file, "utf8");

      // Heuristic: file imports three AND calls registerSpatialDataModule.
      // Both true ⇒ inline scene primitive.
      const importsThree =
        /from ["']three["']/.test(source) || /import\s+\*\s+as\s+THREE\s+from/.test(source);
      const registersKind = /registerSpatialDataModule\s*\(/.test(source);

      if (importsThree && registersKind) {
        violations.push({
          file: rel,
          detail:
            "inline scene primitive — imports `three` and declares a SpatialExpression kind via `registerSpatialDataModule`. Move the renderer + transform into `@motebit/render-engine` and consume it from the app.",
        });
      }
    }
  }
  return violations;
}

// ── Main ───────────────────────────────────────────────────────────────

function main(): void {
  console.log(
    "▸ check-scene-primitives — SpatialExpression renderers live in @motebit/render-engine, not inline in apps (invariant #26, added 2026-04-19 after credential satellites moved from apps/spatial to the render-engine package; extends the protocol-primitive doctrine to scene primitives)",
  );
  const violations = scan();
  if (violations.length === 0) {
    console.log(
      `✓ check-scene-primitives: no inline scene primitives in app source (allowlist: ${ALLOWLIST.length} pending extraction).`,
    );
    process.exit(0);
  }

  console.error(`✗ check-scene-primitives: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    ${v.detail}\n`);
  }
  console.error(
    "Fix: move the renderer + pure data transform into packages/render-engine/src/, export from its index, and import in the app.",
  );
  console.error(
    "If the file is mid-extraction, add it to ALLOWLIST in scripts/check-scene-primitives.ts with the follow-up pass named.",
  );
  process.exit(1);
}

main();
