/**
 * SQLite-migration-runner drift gate (invariant #66).
 *
 * Enforces: schema-version advancement (`PRAGMA user_version = N`) only
 * happens through the canonical runners in `@motebit/sqlite-migrations`,
 * never inline at a call site. The three legitimate sites are:
 *
 *   1. `packages/sqlite-migrations/src/index.ts` — the runner that does
 *      the pragma write itself.
 *   2. `packages/persistence/src/sqljs-driver.ts` — the sql.js driver's
 *      pragma() implementation, which routes "user_version = N" through
 *      the `db.run()` API. Driver-internal, not a call site.
 *   3. `apps/desktop/src/tauri-migrations.ts` — the desktop async driver
 *      shim's `setUserVersion()`, which must inline the literal because
 *      Tauri IPC has no typed pragma command. Driver-internal.
 *
 * Anything else writing `user_version = N` is a regression to the inline-
 * ladder pattern that this infrastructure was built to retire. Each
 * surface that uses SQLite must consume `runMigrations` /
 * `runMigrationsAsync` from `@motebit/sqlite-migrations` and register its
 * schema changes as `Migration` entries — never as inline `if (userVersion
 * < N)` blocks.
 *
 * Why this drift is real: prior to phase 5-prep, three SQLite surfaces
 * (mobile expo-sqlite, desktop Tauri-IPC rusqlite, persistence
 * better-sqlite3 / sql.js) had three independently-evolved migration
 * ladders with three different version lines, three different
 * error-swallow disciplines, and two of the three had no transaction
 * wrapping. That is the canonical drift class this repo exists to
 * prevent. The runner package is the canonical source of truth; this gate
 * locks in the boundary.
 *
 * Allowlist additions require a one-line reason + named follow-up.
 *
 * Test files (`*.test.ts` / `*.test.tsx`) are excluded by the file walker:
 * the runner's own tests legitimately write `user_version` directly to
 * exercise version-pragma reads and pre-seeded states. Excluding tests is
 * not a gate hole — production schema-version writes have nothing to do
 * with the test fixture surface.
 *
 * Exit 1 on violation. Runs in CI via `pnpm check`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [
  {
    path: "packages/sqlite-migrations/src/index.ts",
    reason: "the canonical migration runner",
  },
  {
    path: "packages/persistence/src/sqljs-driver.ts",
    reason: "sql.js driver pragma() implementation",
  },
  {
    path: "apps/desktop/src/tauri-migrations.ts",
    reason: "desktop async driver shim setUserVersion()",
  },
];

const SCAN_ROOTS = ["packages", "apps", "services"];
const PRAGMA_PATTERN = /\buser_version\s*=\s*(?:\$|\?|\d|\$\{|`)/;

interface Violation {
  file: string;
  line: number;
  source: string;
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
    if (
      entry === "node_modules" ||
      entry === "dist" ||
      entry === "__tests__" ||
      entry === ".turbo" ||
      entry === "coverage"
    ) {
      continue;
    }
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

const allowlistSet = new Set(ALLOWLIST.map((a) => a.path));

const violations: Violation[] = [];

for (const root of SCAN_ROOTS) {
  const files = walkTypeScript(join(ROOT, root));
  for (const absPath of files) {
    const rel = relative(ROOT, absPath);
    if (allowlistSet.has(rel)) continue;
    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      // Skip comment-only matches: //, /*, *, or full-line comments.
      const trimmed = line.trimStart();
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        continue;
      }
      if (PRAGMA_PATTERN.test(line)) {
        violations.push({ file: rel, line: i + 1, source: line.trim() });
      }
    }
  }
}

if (violations.length === 0) {
  process.stdout.write(
    `\n✓ check-sqlite-migration-runner: schema-version writes are confined to the ${ALLOWLIST.length} canonical sites.\n`,
  );
  process.exit(0);
}

process.stderr.write(
  `\n✗ check-sqlite-migration-runner: ${violations.length} inline user_version write(s) detected.\n\n`,
);
process.stderr.write(
  `Schema versions must advance through @motebit/sqlite-migrations' runMigrations / runMigrationsAsync, never inline.\n`,
);
process.stderr.write(
  `Register the schema change as a Migration entry in the surface's registry; the runner advances the pragma.\n\n`,
);
for (const v of violations) {
  process.stderr.write(`  ${v.file}:${v.line}\n    ${v.source}\n`);
}
process.stderr.write(
  `\nIf this site is a legitimate driver-internal pragma path (rare), add it to ALLOWLIST in scripts/check-sqlite-migration-runner.ts with a one-line reason.\n`,
);
process.exit(1);
