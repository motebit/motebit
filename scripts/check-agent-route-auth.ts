#!/usr/bin/env tsx
/**
 * check-agent-route-auth — every `/api/v1/agents/:id/*` route the relay
 * registers must be COVERED by the agent-route auth middleware, never
 * silently open.
 *
 * The 2026-07-07 vulnerability: `registerListingsRoutes` registered
 * `POST /api/v1/agents/:id/listing` BEFORE `registerAgentRoutes`
 * installed the `/api/v1/agents/*` auth middleware. Hono applies
 * `app.use` middleware only to routes registered after it, so the
 * listing routes ran unauthenticated — and a correct-looking
 * caller===:motebitId guard silently no-op'd because the value it reads
 * is only set by the absent middleware. An attacker could overwrite any
 * agent's `pay_to_address` (the settlement destination).
 *
 * The fix hoisted the middleware to register FIRST
 * (registerAgentAuthMiddleware, index.ts, right after
 * registerAuthMiddleware) — so ordering-independence GUARANTEES
 * coverage. This gate is the backstop: it fails if any `registerX`
 * whose file declares an `/api/v1/agents/:...` route is called BEFORE
 * `registerAgentAuthMiddleware` in index.ts (reintroducing the gap), or
 * if the middleware call is missing entirely.
 *
 * Deliberately-public agent routes are the exported PUBLIC_AGENT_ROUTES
 * set in agents.ts — reviewed, not accidental. This gate does not
 * re-derive that list; it enforces the structural invariant (middleware
 * first) that makes the public set the ONLY way a route is exempt.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { failWithRepair } from "./lib/gate-report.js";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const RELAY_SRC = resolve(REPO_ROOT, "services/relay/src");
const INDEX = resolve(RELAY_SRC, "index.ts");

const DOCTRINE =
  "services/relay/CLAUDE.md rule 5 (fail-closed auth); the 2026-07-07 listing-write vuln";

function fail(fix: string, sites?: string[]): never {
  failWithRepair({
    invariant:
      "Every /api/v1/agents/:id/* route must be covered by the hoisted agent-route auth middleware",
    canonical:
      "registerAgentAuthMiddleware in services/relay/src/agents.ts, called early in index.ts",
    fix,
    ...(sites ? { sites } : {}),
    doctrine: DOCTRINE,
  });
}

const index = readFileSync(INDEX, "utf8");

// 1. The middleware must be installed.
const mwCall = index.indexOf("registerAgentAuthMiddleware({");
if (mwCall === -1) {
  fail(
    "index.ts does not call registerAgentAuthMiddleware. Install it right after " +
      "registerAuthMiddleware so it wraps every agent-subpath route.",
  );
}

// 2. Find each route-registration call in index.ts and the file it lives in.
//    A file is "agent-route-declaring" if it registers any app.<verb>(
//    "/api/v1/agents/:...") path.
const FILES = [
  "agents",
  "listings",
  "credentials",
  "trust-graph",
  "budget",
  "migration",
  "key-rotation",
  "state-export",
  "subscriptions",
  "sync-routes",
  "command-route",
];
const AGENT_ROUTE_RE =
  /app\.(get|post|put|delete|patch)\(\s*["'`]\/api\/v1\/agents\/:[A-Za-z]/;

// Map registerX function name -> whether its source file declares agent routes.
const declaringRegisterFns = new Map<string, string>(); // fnName -> file
for (const base of FILES) {
  const src = readFileSync(resolve(RELAY_SRC, `${base}.ts`), "utf8");
  if (!AGENT_ROUTE_RE.test(src)) continue;
  const m = src.match(/export (?:async )?function (register[A-Za-z]+)\(/);
  if (m) declaringRegisterFns.set(m[1]!, `${base}.ts`);
}

// 3. For each declaring registerX (except the middleware installer and the
//    agents-routes file whose routes are registered AFTER the middleware by
//    construction), assert its call in index.ts is AFTER the middleware call.
const violations: string[] = [];
for (const [fn, file] of declaringRegisterFns) {
  const callIdx = index.indexOf(`${fn}(`);
  if (callIdx === -1) continue; // not called from index (registered elsewhere)
  if (callIdx < mwCall) {
    violations.push(
      `${fn} (services/relay/src/${file}) is called at index.ts before ` +
        `registerAgentAuthMiddleware — its /api/v1/agents/:id/* routes run UNAUTHENTICATED.`,
    );
  }
}

if (violations.length > 0) {
  fail(
    "Move the offending registerX call to AFTER registerAgentAuthMiddleware in index.ts " +
      "(the middleware wraps only routes registered after it). Never rely on a route file " +
      "registering late enough — that is the exact ordering bug that shipped the vuln.",
    violations,
  );
}

console.log(
  `Agent-route auth coverage OK — ${declaringRegisterFns.size} agent-route file(s) all register ` +
    `after the hoisted auth middleware; PUBLIC_AGENT_ROUTES is the only exemption path.`,
);
