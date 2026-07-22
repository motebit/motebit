#!/usr/bin/env tsx
/**
 * check-security-default-wiring — a security-boundary default must be wired
 * from its canonical constant through the REAL config-construction path, never
 * shadowed by a hard-coded literal at the deployment boundary.
 *
 * The recurring incident class (three times in one week — #357 dormant signing
 * keys, #358 lost transcript threading, and the #346 discover-signature sunset
 * that flipped a constant the shipped `server.ts` never read): a security
 * control is implemented + tested at layer N (a canonical constant, a producer
 * seam) while layer N+1 (the deployment wiring) shadows it with a literal, and
 * the test asserts layer N. CI is green; the running binary is fail-open.
 *
 * The structural fix is single-source-of-truth: the deployment config MUST
 * reference the canonical constant as its fallback, so flipping the constant
 * propagates to the shipped artifact and a test on the constant is a test on
 * production. This gate forbids the shadowing literal for the security-boundary
 * defaults that have bitten us.
 *
 * Extend REGISTRY when a new security-boundary default is added.
 */

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { failWithRepair } from "./lib/gate-report.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

interface Rule {
  /** The env-var name the deployment config reads. */
  envVar: string;
  /** The canonical constant that MUST be its fallback (single source of truth). */
  constant: string;
  /** The deployment-config file that constructs the runtime config. */
  configFile: string;
  /** Human note for the repair text. */
  boundary: string;
}

const REGISTRY: Rule[] = [
  {
    envVar: "MOTEBIT_FEDERATION_REQUIRE_DISCOVER_SIGNATURE",
    constant: "DEFAULT_REQUIRE_DISCOVER_SIGNATURE",
    configFile: "services/relay/src/server.ts",
    boundary: "federation per-hop discover signing (the #188 sunset; cross-org trust boundary)",
  },
];

const violations: string[] = [];
for (const r of REGISTRY) {
  let src: string;
  try {
    src = read(r.configFile);
  } catch {
    violations.push(`${r.configFile}: file not found (config path moved?)`);
    continue;
  }
  // The env read must exist AND its fallback argument must be the canonical
  // constant, not a boolean literal. Match `parseBoolEnv("<env>", <fallback>)`
  // tolerating whitespace/newlines between args.
  const call = new RegExp(
    `parseBoolEnv\\(\\s*["']${r.envVar}["']\\s*,\\s*([A-Za-z_][A-Za-z0-9_]*|true|false)`,
  ).exec(src);
  if (call == null) {
    violations.push(
      `${r.configFile}: no parseBoolEnv("${r.envVar}", …) call found — the ${r.boundary} default is not wired from the deployment config.`,
    );
    continue;
  }
  const fallback = call[1];
  if (fallback !== r.constant) {
    violations.push(
      `${r.configFile}: parseBoolEnv("${r.envVar}", ${fallback}) uses a ${
        fallback === "true" || fallback === "false" ? "hard-coded literal" : "non-canonical symbol"
      } as its fallback — it MUST be the canonical constant ${r.constant} so the sunset/default actually governs the shipped relay (a literal shadows the constant → fail-open in production while the constant-only test stays green).`,
    );
  }
}

if (violations.length > 0) {
  failWithRepair({
    invariant:
      "check-security-default-wiring: a security-boundary default must be wired from its canonical constant through the real deployment config, never shadowed by a literal (the #346/#357/#358 shadow-the-constant incident class).",
    canonical:
      "docs/doctrine/deprecation-lifecycle.md (announced defaults must ship) + services/relay/src/federation.ts DEFAULT_REQUIRE_DISCOVER_SIGNATURE",
    fix: "In services/relay/src/server.ts, pass the canonical constant (e.g. DEFAULT_REQUIRE_DISCOVER_SIGNATURE, imported from ./federation.js) as the parseBoolEnv fallback — never a hard-coded true/false. One source of truth means flipping the constant propagates to production and a test on the constant is a test on the shipped relay.",
    sites: violations,
    doctrine: "docs/doctrine/deprecation-lifecycle.md",
  });
}

console.log(
  `✓ check-security-default-wiring: ${REGISTRY.length} security-boundary default(s) wired from the canonical constant through the deployment config (no shadowing literal).`,
);
