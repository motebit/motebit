/**
 * App-level import boundary check.
 *
 * Surface apps (desktop, mobile, web, spatial, cli, inspector, operator, identity, docs)
 * are
 * the top of the monorepo's 7-layer stack. Like services, they run the
 * protocol — they do not define it. App-level drift has a distinct shape from
 * service drift:
 *
 *   - Services drift toward inline crypto / receipt signing (locked down by
 *     check-service-primitives). Apps rarely do this — they're UI surfaces.
 *   - Apps drift toward importing Layer-0 permissive-floor types directly (@motebit/protocol,
 *     @motebit/crypto) when the product-shaped re-exports live in @motebit/sdk
 *     and @motebit/encryption.
 *
 * The convention this gate encodes: *apps consume the product vocabulary,
 * not the protocol primitives.* @motebit/sdk does `export * from
 * "@motebit/protocol"` — so every protocol type is accessible through the
 * product-shaped entry. Going around sdk to protocol directly is the same
 * shape of drift as services importing @motebit/encryption directly instead
 * of going through mcp-server helpers.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 *
 * Scanned apps: all under apps/*. The inspector, operator and identity apps are included
 * — even though they don't have creature surfaces, they still should use
 * the product vocabulary.
 *
 * Tests are excluded: test files legitimately reach into low-level primitives
 * for setup and assertion (see the service-primitive gate for the same
 * policy).
 *
 * Exit 1 on any violation. Runs in CI after check-deps, before tests.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Scanned apps ─────────────────────────────────────────────────────────
// Apps scanned by this gate. Each app's src/ (or app/ for Next.js) is walked.
// Add a new app here when it joins the monorepo.
const APPS = [
  "cli",
  "desktop",
  "docs",
  "identity",
  "inspector",
  "mobile",
  "operator",
  "spatial",
  "web",
];

// ── Forbidden package imports ────────────────────────────────────────────
// Apps must route protocol-shaped types through the product-layer re-exports.
// Subpath imports match as prefixes (e.g. "@motebit/protocol/foo").
const FORBIDDEN_IMPORTS: Record<string, string> = {
  "@motebit/protocol":
    "use @motebit/sdk — it re-exports every protocol type via `export *`, plus product vocabulary (color presets, approval presets, governance config, etc.). Going direct to protocol skips the product-layer conventions.",
  "@motebit/crypto":
    "use @motebit/encryption — product-level crypto (key wrapping, signed tokens, payload encryption). @motebit/crypto is Layer 0 permissive-floor (Apache-2.0) for protocol implementers; apps are consumers.",
};

// ── Forbidden inline patterns ────────────────────────────────────────────
// Surface apps should not be reinventing protocol plumbing. The CLI is the
// one tricky case: it runs a real motebit daemon and legitimately signs
// receipts — so we exempt it from pattern checks (it still must honor the
// package-level forbids above).
const PATTERN_EXEMPT_APPS = new Set(["cli"]);
const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; msg: string }> = [
  {
    pattern: /\bsignExecutionReceipt\s*\(/,
    msg: "apps should not sign execution receipts directly — that is runtime-layer work",
  },
];

// ── Scanner ──────────────────────────────────────────────────────────────

interface Violation {
  app: string;
  file: string;
  line: number;
  kind: "import" | "pattern";
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

/** Match `import { a, b } from "pkg"` / `import type { a } from "pkg"` / `import X from "pkg"`. */
const IMPORT_RE =
  /^\s*import\s+(?:type\s+)?(?:\*\s+as\s+\w+|\{[^}]+\}|\w+)\s+from\s+["']([^"']+)["']/gm;

function scanFile(app: string, file: string): Violation[] {
  const src = readFileSync(file, "utf-8");
  const violations: Violation[] = [];
  const shortPath = relative(ROOT, file);

  // ── Import scan ────────────────────────────────────────────────────
  let match: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(src)) !== null) {
    const specifier = match[1];
    const line = src.slice(0, match.index).split("\n").length;

    for (const [forbidden, why] of Object.entries(FORBIDDEN_IMPORTS)) {
      if (specifier === forbidden || specifier.startsWith(forbidden + "/")) {
        violations.push({
          app,
          file: shortPath,
          line,
          kind: "import",
          detail: `forbidden: "${specifier}" — ${why}`,
        });
      }
    }
  }

  // ── Pattern scan (skipped for exempt apps) ─────────────────────────
  if (!PATTERN_EXEMPT_APPS.has(app)) {
    for (const { pattern, msg } of FORBIDDEN_PATTERNS) {
      const lines = src.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (pattern.test(lines[i])) {
          violations.push({
            app,
            file: shortPath,
            line: i + 1,
            kind: "pattern",
            detail: msg,
          });
        }
      }
    }
  }

  return violations;
}

function main(): void {
  const all: Violation[] = [];
  for (const app of APPS) {
    // Most apps have src/; Next.js apps (docs) use app/. Scan both if present.
    for (const subdir of ["src", "app"]) {
      const dir = resolve(ROOT, "apps", app, subdir);
      const files = walkTypeScript(dir);
      for (const file of files) {
        all.push(...scanFile(app, file));
      }
    }
  }

  if (all.length === 0) {
    console.log(`App primitive check passed — ${APPS.length} apps clean (${APPS.join(", ")})`);
    return;
  }

  console.error(`App primitive violations (${all.length}):\n`);
  let current = "";
  for (const v of all) {
    if (v.app !== current) {
      current = v.app;
      console.error(`  [${v.app}]`);
    }
    console.error(`    ${v.file}:${v.line} — ${v.detail}`);
  }
  console.error(
    `\nDoctrine: apps consume the product vocabulary (@motebit/sdk, @motebit/encryption), not the protocol primitives (@motebit/protocol, @motebit/crypto).`,
  );
  console.error(
    `Protocol primitives live in Layer 0 permissive-floor packages (Apache-2.0) for independent implementers — apps are top-layer consumers.`,
  );
  process.exit(1);
}

main();
