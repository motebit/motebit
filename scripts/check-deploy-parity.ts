/**
 * Deployment parity check.
 *
 * Enforces four invariants across services that ship to production:
 *
 *   1. services/<svc>/fly.toml → .github/workflows/deploy-<app>.yml
 *      If a service declares a fly.toml with `app = "motebit-<name>"`, the
 *      matching deploy workflow must exist. Otherwise the service has no
 *      automated deploy path — drift visible only when operators notice
 *      stale production.
 *
 *   2. services/<svc>/fly.toml → services/<svc>/.env.example
 *      If the service is deployed, operators must be able to bring it up
 *      locally. .env.example is the canonical "which env vars does this
 *      service expect" document. Missing it = silent deploy-time bug for
 *      the next person who touches the service.
 *
 *   3. Every var named in .env.example must be read by service source.
 *      Catches stale .env.example files that reference env vars the
 *      service stopped reading (the exact shape of the web-search drift
 *      that motivated this gate: MOTEBIT_IDENTITY_PATH and
 *      MOTEBIT_PRIVATE_KEY_HEX survived in .env.example for months after
 *      the service migrated to bootstrapAndEmitIdentity).
 *
 *   4. Fly-deployed service that depends on @motebit/persistence must
 *      declare better-sqlite3 as a direct dependency.
 *      `@motebit/persistence` lists better-sqlite3 in optionalDependencies
 *      so the CLI scaffold on exotic platforms (Nix, WSL, etc.) can fall
 *      back to sql.js (WASM). `pnpm --filter <svc> deploy --prod` follows
 *      the service's own package.json — transitive optionalDependencies of
 *      workspace packages get dropped. Without a direct declaration, the
 *      native binding never ships and `openMotebitDatabase` silently falls
 *      back to sql.js: WAL becomes a no-op, writes become 1-second-debounced
 *      full-file rewrites, Litestream goes dark. Durability + perf regress
 *      invisibly. Any fly-deployed relay-shaped service consumes this.
 *
 * Services without a fly.toml are not deployed and are skipped entirely
 * (e.g. services/proxy ships via Vercel edge — a different deploy
 * pipeline, not a gap).
 *
 * Exit 1 on any violation.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

interface Violation {
  service: string;
  detail: string;
}

/** Extract the fly app name from a fly.toml. Returns null if absent/malformed. */
function flyAppName(flyTomlPath: string): string | null {
  if (!existsSync(flyTomlPath)) return null;
  const src = readFileSync(flyTomlPath, "utf-8");
  const match = src.match(/^\s*app\s*=\s*["']([^"']+)["']/m);
  return match ? match[1] : null;
}

/** Parse `.env.example` and return the set of env var names declared. */
function parseEnvExample(path: string): Set<string> {
  const src = readFileSync(path, "utf-8");
  const names = new Set<string>();
  for (const line of src.split("\n")) {
    // Skip comments and blanks. Match KEY=value (value may be empty).
    const match = /^([A-Z][A-Z0-9_]*)\s*=/.exec(line.trim());
    if (match) names.add(match[1]);
  }
  return names;
}

/**
 * Return all env var names read in a service's source.
 *
 * Recognizes three shapes:
 *   - process.env.FOO
 *   - process.env["FOO"]
 *   - parseBoolEnv("FOO", ...) / parseIntEnv / parseFloatEnv (services/relay/src/env.ts helpers)
 *
 * If a service introduces a new env-reading helper, extend the regex — the
 * gate's correctness depends on knowing every shape. Better to false-positive
 * (flag a stale var) than false-negative (let a real stale var pass).
 */
function envVarsReadInSource(serviceDir: string): Set<string> {
  const names = new Set<string>();
  const directEnv = /process\.env(?:\.([A-Z][A-Z0-9_]*)|\[["']([A-Z][A-Z0-9_]*)["']\])/g;
  const helperEnv = /\bparse(?:Bool|Int|Float)Env\s*\(\s*["']([A-Z][A-Z0-9_]*)["']/g;

  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry);
      const st = readdirSafe(p);
      if (st === "dir") {
        if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
        walk(p);
      } else if (st === "file" && (entry.endsWith(".ts") || entry.endsWith(".tsx"))) {
        const src = readFileSync(p, "utf-8");
        let m: RegExpExecArray | null;
        directEnv.lastIndex = 0;
        while ((m = directEnv.exec(src)) !== null) {
          names.add(m[1] ?? m[2]);
        }
        helperEnv.lastIndex = 0;
        while ((m = helperEnv.exec(src)) !== null) {
          names.add(m[1]);
        }
      }
    }
  }
  function readdirSafe(p: string): "dir" | "file" | null {
    try {
      return readdirSync(p).length >= 0 ? "dir" : null;
    } catch {
      // Not a directory — probably a file. Cheap existence probe.
      return existsSync(p) ? "file" : null;
    }
  }

  walk(serviceDir);
  return names;
}

function listServices(): string[] {
  const servicesDir = resolve(ROOT, "services");
  return readdirSync(servicesDir).filter((entry) => {
    const p = join(servicesDir, entry);
    try {
      return readdirSync(p).length >= 0;
    } catch {
      return false;
    }
  });
}

function main(): void {
  const violations: Violation[] = [];
  const workflowsDir = resolve(ROOT, ".github/workflows");
  const workflows = new Set(readdirSync(workflowsDir));

  for (const svc of listServices()) {
    const serviceDir = resolve(ROOT, "services", svc);
    const flyToml = join(serviceDir, "fly.toml");
    const appName = flyAppName(flyToml);

    // Service does not deploy to Fly — out of scope (e.g. proxy → Vercel).
    if (!appName) continue;

    // Invariant 1: deploy workflow exists.
    // Convention: workflow name derives from the fly app short-name
    // (fly-app minus the "motebit-" prefix), not the directory. Most
    // services match both (directory "web-search" → app "motebit-web-search"
    // → workflow "deploy-web-search.yml"), but the sync relay is historically
    // deployed as "motebit-sync" from services/relay, and that shape is preserved.
    const shortName = appName.replace(/^motebit-/, "");
    const expectedWorkflow = `deploy-${shortName}.yml`;
    if (!workflows.has(expectedWorkflow)) {
      violations.push({
        service: svc,
        detail: `missing .github/workflows/${expectedWorkflow} — fly.toml declares app "${appName}" but no CI deploy workflow exists`,
      });
    }

    // Invariant 2: .env.example exists.
    const envExample = join(serviceDir, ".env.example");
    if (!existsSync(envExample)) {
      violations.push({
        service: svc,
        detail: `missing ${relative(ROOT, envExample)} — deployed services must document expected env vars for local bootstrap`,
      });
      continue; // Can't check invariant 3 without the file.
    }

    // Invariant 3: every var in .env.example is actually read.
    const declared = parseEnvExample(envExample);
    const read = envVarsReadInSource(join(serviceDir, "src"));
    for (const name of declared) {
      if (!read.has(name)) {
        violations.push({
          service: svc,
          detail: `${relative(ROOT, envExample)} declares "${name}" but nothing in src reads process.env.${name} — stale doc`,
        });
      }
    }

    // Invariant 4: persistence consumers must declare better-sqlite3 directly.
    // `@motebit/persistence` keeps better-sqlite3 in optionalDependencies so
    // the CLI scaffold can fall back to sql.js on exotic platforms. Fly-
    // deployed services are not that audience — they need the native
    // binding to ship. `pnpm deploy --prod` follows the service's direct
    // deps; transitive optional-of-workspace-dep drops. Direct declaration
    // is the single mechanism that guarantees the binding reaches the
    // runtime image.
    const pkgJsonPath = join(serviceDir, "package.json");
    if (existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8")) as {
        dependencies?: Record<string, string>;
      };
      const deps = pkg.dependencies ?? {};
      if ("@motebit/persistence" in deps && !("better-sqlite3" in deps)) {
        violations.push({
          service: svc,
          detail: `${relative(ROOT, pkgJsonPath)} depends on @motebit/persistence but does not declare "better-sqlite3" directly — \`pnpm deploy --prod\` will drop the native binding (it's an optionalDependency of persistence for the CLI scaffold's sql.js fallback path) and the running service will silently degrade to sql.js (WAL disabled, full-file rewrites on a 1s debounce). Add \`"better-sqlite3": "^12.0.0"\` to this service's dependencies`,
        });
      }
    }
  }

  if (violations.length === 0) {
    console.log(
      `Deploy parity check passed — fly.toml ↔ deploy workflow ↔ .env.example ↔ source all aligned`,
    );
    return;
  }

  console.error(`Deploy parity violations (${violations.length}):\n`);
  let current = "";
  for (const v of violations) {
    if (v.service !== current) {
      current = v.service;
      console.error(`  [${v.service}]`);
    }
    console.error(`    ${v.detail}`);
  }
  console.error(
    `\nDoctrine: a service that deploys must be deployable (workflow exists), bootstrappable (.env.example exists), and honestly documented (no stale env vars).`,
  );
  process.exit(1);
}

main();
