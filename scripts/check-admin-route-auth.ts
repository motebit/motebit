/**
 * `/api/v1/admin/*` route ↔ `bearerAuth` registration gate.
 *
 * Every route registered under `/api/v1/admin/...` in `services/relay/src/`
 * MUST be covered by at least one `app.use("/api/v1/admin/...", bearerAuth(...))`
 * registration in `middleware.ts`. The relay's only access control on the
 * admin surface is the master bearer — a route missing its middleware
 * registration ships as a wide-open endpoint.
 *
 * ## Why this gate exists
 *
 * On 2026-04-25 commit `63fa2199` reverted a hardware-attestation publish
 * flow because `/api/v1/agents/:id/credentials/submit` rejected every
 * client-side fetch but the surface only checked `resp.ok`. That
 * incident locked invariant #60 (response-body inspection). The post-
 * mortem on 2026-04-28 surfaced a sibling shape: `GET
 * /api/v1/admin/transparency` had been *registered as a route* in
 * `transparency.ts` since 2026-04-14 with a JSDoc claim that it was
 * "audience-bound at the auth layer (admin:query)" — but no
 * `app.use(...)` for that path existed in `middleware.ts`. The endpoint
 * shipped wide open. Manual audit in commit `2560472b` added the
 * missing `bearerAuth` registration; a parallel manual audit confirmed
 * all 13 other `/api/v1/admin/*` routes had matching middleware
 * coverage at that point. Manual audits expire; gates don't.
 *
 * ## What this gate enforces
 *
 * Discovery side — for every TS file in `services/relay/src/` (excluding
 * tests, `.generated.ts`, dist), find `app.<method>("/api/v1/admin/...")`
 * route registrations. The set of admin route paths is the universe.
 *
 * Coverage side — for every `app.use("/api/v1/admin/...", ...)` line in
 * `middleware.ts` whose middleware function is `bearerAuth(...)` (the
 * static-master-token check that the relay uses for every admin route),
 * record the path pattern. Wildcards (`*` at end) cover any prefix
 * extension; exact paths cover only that literal path; route params
 * (`:withdrawalId`, `:motebitId/:taskId`) are matched as wildcards
 * starting at the colon.
 *
 * Match — every admin route must be covered by at least one bearerAuth
 * pattern. Routes whose middleware pattern uses a non-`bearerAuth`
 * function (per-device `dualAuth`, `addressed audience`, etc.) are NOT
 * covered for the purposes of this gate — admin surface convention is
 * static master bearer, and the gate enforces that convention.
 *
 * Pre-existing routes that legitimately use a different auth model
 * (none today; the convention is uniform) would need an allowlist with
 * a reason. Empty at landing.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, resolve, relative, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const RELAY_SRC = "services/relay/src";
const MIDDLEWARE_FILE = join(RELAY_SRC, "middleware.ts");

const SKIP_DIR_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "__tests__",
  ".turbo",
  "build",
  "generated",
]);
const SKIP_FILE_SUFFIXES = [".d.ts", ".d.ts.map", ".js.map", ".generated.ts"];

const ADMIN_ROUTE_PREFIX = "/api/v1/admin/";

/** Match `app.get|post|put|delete|patch("/api/v1/admin/...", ...)`.
 *  Group 1 = HTTP method, group 2 = full path literal (single or double
 *  quoted). The path may include route params (`:foo`). */
const ROUTE_RE = /\bapp\.(get|post|put|delete|patch)\s*\(\s*['"](\/api\/v1\/admin\/[^'"]+)['"]/g;

/** Match `app.use("/api/v1/admin/...", bearerAuth(...))`. The path may
 *  end in `*` for prefix coverage. */
const MIDDLEWARE_RE = /\bapp\.use\s*\(\s*['"](\/api\/v1\/admin\/[^'"]+)['"]\s*,\s*bearerAuth\s*\(/g;

interface RouteSite {
  file: string;
  line: number;
  method: string;
  path: string;
}

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIR_SEGMENTS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    if (SKIP_FILE_SUFFIXES.some((s) => entry.endsWith(s))) continue;
    out.push(full);
  }
}

function findRouteRegistrations(): RouteSite[] {
  const sites: RouteSite[] = [];
  const files: string[] = [];
  walk(resolve(ROOT, RELAY_SRC), files);

  // The middleware file's `app.use(...)` registrations should not
  // count as route registrations. Skip it entirely on the discovery side.
  const middlewareAbs = resolve(ROOT, MIDDLEWARE_FILE);

  for (const file of files) {
    if (file === middlewareAbs) continue;
    const src = readFileSync(file, "utf-8");
    if (!src.includes(ADMIN_ROUTE_PREFIX)) continue;
    ROUTE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ROUTE_RE.exec(src)) !== null) {
      const line = src.slice(0, match.index).split("\n").length;
      sites.push({
        file: relative(ROOT, file),
        line,
        method: match[1]!.toUpperCase(),
        path: match[2]!,
      });
    }
  }

  return sites;
}

function findBearerAuthPatterns(): string[] {
  const middlewareAbs = resolve(ROOT, MIDDLEWARE_FILE);
  const src = readFileSync(middlewareAbs, "utf-8");
  const patterns: string[] = [];
  MIDDLEWARE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MIDDLEWARE_RE.exec(src)) !== null) {
    patterns.push(match[1]!);
  }
  return patterns;
}

/** Normalize a Hono path pattern for prefix matching:
 *   - `/api/v1/admin/withdrawals/*` → prefix `/api/v1/admin/withdrawals/`
 *   - `/api/v1/admin/receipts/*` → prefix `/api/v1/admin/receipts/`
 *   - `/api/v1/admin/withdrawals/:id/complete` → exact (no wildcard)
 *   - `/api/v1/admin/transparency` → exact
 *
 *  Returns `{ kind: "prefix" | "exact", value: string }`. For prefix
 *  patterns, `value` is the path WITHOUT the trailing `/*`. For exact
 *  patterns with `:param` placeholders, the route's matching params are
 *  checked segment-by-segment. */
function normalizePattern(pattern: string): { kind: "prefix" | "exact"; value: string } {
  if (pattern.endsWith("/*")) {
    return { kind: "prefix", value: pattern.slice(0, -1) }; // keep trailing slash
  }
  return { kind: "exact", value: pattern };
}

/** Does an admin route match a bearerAuth pattern? Two cases:
 *   - prefix: route must start with the pattern's prefix path
 *   - exact: route must equal the pattern after substituting route
 *     params (`:foo`) against pattern segments. We treat `:foo` as a
 *     wildcard for one segment so a route like `/admin/receipts/:m/:t`
 *     matches a middleware pattern like `/admin/receipts/*`. */
function patternMatches(
  routePath: string,
  pattern: { kind: "prefix" | "exact"; value: string },
): boolean {
  if (pattern.kind === "prefix") {
    return routePath.startsWith(pattern.value);
  }
  // Exact match — segment-by-segment with `:foo` placeholders matching
  // any single segment on either side.
  const a = routePath.split("/");
  const b = pattern.value.split("/");
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    if (ai.startsWith(":") || bi.startsWith(":")) continue;
    if (ai !== bi) return false;
  }
  return true;
}

function main(): void {
  const routes = findRouteRegistrations();
  const patterns = findBearerAuthPatterns().map(normalizePattern);

  const unprotected: RouteSite[] = [];
  for (const route of routes) {
    const covered = patterns.some((p) => patternMatches(route.path, p));
    if (!covered) unprotected.push(route);
  }

  if (unprotected.length > 0) {
    process.stderr.write(
      `\nerror: ${unprotected.length} \`/api/v1/admin/*\` route(s) registered without a corresponding ` +
        `\`app.use("...", bearerAuth(...))\` middleware in services/relay/src/middleware.ts:\n\n`,
    );
    for (const u of unprotected) {
      process.stderr.write(`  ${u.file}:${u.line}\n`);
      process.stderr.write(`    ${u.method} ${u.path}\n`);
      process.stderr.write(
        `    ✗ no bearerAuth coverage — route ships wide open. Add ` +
          `\`app.use("${u.path}", bearerAuth({ token: apiToken }));\` to ` +
          `\`registerAuthMiddleware\` in middleware.ts.\n\n`,
      );
    }
    process.stderr.write(
      "Background: the relay's admin surface convention is static master bearer\n" +
        "(`bearerAuth({ token: apiToken })`). A route registered without the matching\n" +
        "middleware ships as a wide-open endpoint — the same shape as the\n" +
        "/api/v1/admin/transparency bug that 2560472b fixed manually.\n",
    );
    process.exit(1);
  }

  process.stderr.write(
    `  ✓ ${routes.length} \`/api/v1/admin/*\` route(s) covered by ${patterns.length} bearerAuth pattern(s) in middleware.ts\n`,
  );
}

main();
