/**
 * Skills cross-surface boundary check.
 *
 * Skills are a permission-orthogonal procedural-knowledge layer (per
 * `spec/skills-v1.md` §1) that belongs on every surface. The storage
 * adapters landed first (`IdbSkillStorageAdapter` in
 * `@motebit/browser-persistence` for web + desktop dev-mode;
 * `ExpoSqliteSkillStorageAdapter` in `apps/mobile` for mobile;
 * `NodeFsSkillStorageAdapter` in `@motebit/skills` for desktop's Tauri
 * sidecar + the CLI). Surfaces then wire a `SkillRegistry` over their
 * platform's adapter.
 *
 * This gate defends the cross-surface invariant: every shipping surface
 * MUST either construct a `SkillRegistry` directly OR route through the
 * Tauri sidecar bridge. Either shape proves the surface participates in
 * the skills lifecycle. A surface that shipped Skills UI but failed to
 * wire the registry would silently render an empty panel forever — the
 * gate catches that drift in CI rather than at user encounter.
 *
 * Mobile's storage adapter ships dormant ahead of the panel UI; the
 * gate accepts `ExpoSqliteSkillStorageAdapter`'s presence as the
 * surface's commitment, and tightens to require `SkillRegistry`
 * construction once the mobile panel lands (the comment at the surface
 * itself names the trigger).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface SurfaceCheck {
  /** Display name in the failure message. */
  surface: string;
  /** Path under ROOT to the file we read. */
  file: string;
  /** At least one of these patterns must appear in the file. */
  signatures: ReadonlyArray<{
    description: string;
    pattern: RegExp;
  }>;
}

const SURFACE_CHECKS: ReadonlyArray<SurfaceCheck> = [
  {
    surface: "web",
    file: "apps/web/src/web-app.ts",
    signatures: [
      {
        description: "constructs `new SkillRegistry(...)` over `IdbSkillStorageAdapter`",
        pattern: /new\s+SkillRegistry\s*\(/,
      },
    ],
  },
  {
    surface: "desktop",
    file: "apps/desktop/src/ui/skills.ts",
    signatures: [
      {
        description:
          "wires `TauriIpcSkillsPanelAdapter` (production sidecar) or `InRendererSkillsPanelAdapter` (dev-mode IDB fallback)",
        pattern: /(TauriIpcSkillsPanelAdapter|InRendererSkillsPanelAdapter)/,
      },
    ],
  },
  {
    surface: "mobile",
    file: "apps/mobile/src/mobile-app.ts",
    signatures: [
      {
        description:
          "constructs `new SkillRegistry(...)` over `ExpoSqliteSkillStorageAdapter` and exposes it via `getSkillRegistry()`",
        pattern: /new\s+SkillRegistry\s*\(/,
      },
    ],
  },
];

interface Violation {
  surface: string;
  file: string;
  reason: string;
}

function checkSurface(check: SurfaceCheck): Violation | null {
  const path = resolve(ROOT, check.file);
  if (!existsSync(path)) {
    return {
      surface: check.surface,
      file: check.file,
      reason: `file is missing — expected to find Skills wiring here.`,
    };
  }
  const src = readFileSync(path, "utf-8");
  const matched = check.signatures.find((sig) => sig.pattern.test(src));
  if (matched === undefined) {
    return {
      surface: check.surface,
      file: check.file,
      reason: `none of the expected Skills signatures found. Expected: ${check.signatures.map((s) => `"${s.description}"`).join(" or ")}.`,
    };
  }
  return null;
}

function main(): void {
  const violations: Violation[] = [];
  for (const check of SURFACE_CHECKS) {
    const v = checkSurface(check);
    if (v !== null) violations.push(v);
  }

  if (violations.length === 0) {
    process.stderr.write(
      `✓ check-skills-cross-surface: every surface (${SURFACE_CHECKS.map((c) => c.surface).join(", ")}) wires Skills.\n`,
    );
    return;
  }

  process.stderr.write(
    `\n✗ check-skills-cross-surface: ${violations.length} surface(s) missing Skills wiring.\n\n`,
  );
  for (const v of violations) {
    process.stderr.write(`  ${v.file}  (surface: ${v.surface})\n    ${v.reason}\n\n`);
  }
  process.stderr.write(
    `Skills are cross-surface per packages/skills/CLAUDE.md rule 4. Each\n` +
      `surface must construct a SkillRegistry over its platform's storage\n` +
      `adapter (or, for desktop, route through the Tauri sidecar). See the\n` +
      `surface signatures above for the accepted shapes.\n`,
  );
  process.exit(1);
}

main();
