/**
 * Service-level protocol primitive blindness check.
 *
 * Downstream motebit services (code-review, read-url, summarize, web-search,
 * research) run the protocol — they are not the protocol. All signing,
 * identity bootstrap, canonical JSON, receipt construction, and MCP server
 * plumbing must flow through `@motebit/mcp-server` and its extracted helpers
 * (wireServerDeps, startServiceServer, buildServiceReceipt,
 * bootstrapAndEmitIdentity).
 *
 * This script enforces the doctrine from CLAUDE.md:
 *
 *   > Before writing any protocol-shaped plumbing (signing, token minting,
 *   > MCP transport, receipt construction, relay task submission, crypto
 *   > verification, delegation) inside a service, audit the package layer.
 *   > ... Never ship protocol plumbing inline — it becomes "the convention"
 *   > by the time the third sibling service copies it.
 *
 * The clean state this script locks in was established by three refactors:
 *   - buildServiceReceipt extraction (commit 543e0bab)
 *   - wireServerDeps defaults verifySignedToken (this session)
 *   - bootstrapAndEmitIdentity extraction (this session)
 *
 * Exit 1 on any violation. Runs in CI after check-deps, before tests.
 *
 * ── Scope ───────────────────────────────────────────────────────────────
 *
 * Only scans motebit-shaped services (those that implement the protocol).
 * services/embed and services/proxy are glucose (stateless adapters),
 * not motebit participants — they're excluded.
 *
 * services/api is the relay — it IS the protocol's canonical implementation
 * and is explicitly allowed to use crypto primitives directly. Not scanned.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Scanned services ─────────────────────────────────────────────────────
// Motebit-shaped services that MUST route protocol plumbing through helpers.
// Add a new service here when it adopts the mcp-server scaffold.
const SERVICES = ["code-review", "read-url", "summarize", "web-search", "research"];

// ── Forbidden package imports ────────────────────────────────────────────
// Map of @motebit/* import specifier → "why it's forbidden + what to use".
// Subpath imports ("@motebit/core-identity/node") match as prefixes.
const FORBIDDEN_IMPORTS: Record<string, string> = {
  "@motebit/encryption":
    "services must not import crypto directly — use buildServiceReceipt / bootstrapAndEmitIdentity / wireServerDeps from @motebit/mcp-server",
  "@motebit/crypto":
    "services must not import @motebit/crypto directly — helpers in @motebit/mcp-server expose the needed primitives",
  "@motebit/core-identity":
    "use bootstrapAndEmitIdentity from @motebit/mcp-server (composes bootstrapServiceIdentity + motebit.md emission)",
  "@motebit/protocol":
    "use @motebit/sdk for type re-exports — @motebit/protocol is for protocol implementers only",
  "@motebit/policy":
    "policy configuration belongs in runtime construction, not service-level imports",
  "@motebit/semiring": "semiring is judgment-layer BSL — services don't score routes",
  "@motebit/market": "market mechanics live at the relay, not in downstream services",
};

// ── Restricted exports from allowed packages ─────────────────────────────
// Allowed package, but only a whitelisted subset of exports.
const ALLOWED_EXPORTS_FROM: Record<string, { allowed: ReadonlySet<string>; why: string }> = {
  "@motebit/identity-file": {
    allowed: new Set(["parseRiskLevel"]),
    why: "use bootstrapAndEmitIdentity from @motebit/mcp-server for identity file generation (generate is forbidden direct)",
  },
};

// ── Forbidden inline patterns ────────────────────────────────────────────
// Regexes matched against non-test source. Crypto primitives and inline
// hex helpers signal that the service is reinventing protocol plumbing.
const FORBIDDEN_PATTERNS: ReadonlyArray<{ pattern: RegExp; msg: string }> = [
  {
    pattern: /\bcanonicalJson\s*\(/,
    msg: "canonical JSON belongs behind protocol primitives — use buildServiceReceipt",
  },
  {
    pattern: /\bsignExecutionReceipt\s*\(/,
    msg: "use buildServiceReceipt from @motebit/mcp-server",
  },
  {
    pattern: /^\s*(?:export\s+)?function\s+fromHex\s*\(/m,
    msg: "inline fromHex — use identity.publicKey / identity.privateKey from bootstrapAndEmitIdentity, don't hand-roll hex decode",
  },
];

// ── Scanner ──────────────────────────────────────────────────────────────

interface Violation {
  service: string;
  file: string;
  line: number;
  kind: "import" | "export" | "pattern";
  detail: string;
}

function walkTypeScript(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (entry === "__tests__" || entry === "node_modules" || entry === "dist") continue;
      out.push(...walkTypeScript(path));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

/** Match `import { a, b } from "pkg"` and `import type { a } from "pkg"`. */
const IMPORT_RE =
  /^\s*import\s+(?:type\s+)?(?:\*\s+as\s+\w+|\{([^}]+)\}|(\w+))\s+from\s+["']([^"']+)["']/gm;

function scanFile(service: string, file: string): Violation[] {
  const src = readFileSync(file, "utf-8");
  const violations: Violation[] = [];
  const shortPath = relative(ROOT, file);

  // ── Import scan ────────────────────────────────────────────────────
  let match: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((match = IMPORT_RE.exec(src)) !== null) {
    const rawNamed = match[1];
    const defaultName = match[2];
    const specifier = match[3];
    const line = src.slice(0, match.index).split("\n").length;

    // Forbidden package (exact or subpath).
    for (const [forbidden, why] of Object.entries(FORBIDDEN_IMPORTS)) {
      if (specifier === forbidden || specifier.startsWith(forbidden + "/")) {
        violations.push({
          service,
          file: shortPath,
          line,
          kind: "import",
          detail: `forbidden: "${specifier}" — ${why}`,
        });
      }
    }

    // Restricted export set.
    const restricted = ALLOWED_EXPORTS_FROM[specifier];
    if (restricted && rawNamed) {
      const names = rawNamed
        .split(",")
        .map((n) =>
          n
            .trim()
            .replace(/^type\s+/, "")
            .split(/\s+as\s+/)[0]
            .trim(),
        )
        .filter(Boolean);
      for (const name of names) {
        if (!restricted.allowed.has(name)) {
          violations.push({
            service,
            file: shortPath,
            line,
            kind: "export",
            detail: `forbidden: "${name}" from "${specifier}" — ${restricted.why}`,
          });
        }
      }
    }
    if (restricted && defaultName) {
      violations.push({
        service,
        file: shortPath,
        line,
        kind: "export",
        detail: `default import from "${specifier}" not allowed — ${restricted.why}`,
      });
    }
  }

  // ── Pattern scan ───────────────────────────────────────────────────
  for (const { pattern, msg } of FORBIDDEN_PATTERNS) {
    const lines = src.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        violations.push({
          service,
          file: shortPath,
          line: i + 1,
          kind: "pattern",
          detail: msg,
        });
      }
    }
  }

  return violations;
}

function main(): void {
  const all: Violation[] = [];
  for (const svc of SERVICES) {
    const dir = resolve(ROOT, "services", svc, "src");
    const files = walkTypeScript(dir);
    for (const file of files) {
      all.push(...scanFile(svc, file));
    }
  }

  if (all.length === 0) {
    console.log(
      `Service primitive check passed — ${SERVICES.length} services clean (${SERVICES.join(", ")})`,
    );
    return;
  }

  console.error(`Service primitive violations (${all.length}):\n`);
  let current = "";
  for (const v of all) {
    if (v.service !== current) {
      current = v.service;
      console.error(`  [${v.service}]`);
    }
    console.error(`    ${v.file}:${v.line} — ${v.detail}`);
  }
  console.error(
    `\nDoctrine: protocol plumbing belongs in @motebit/mcp-server, never inline in services.`,
  );
  console.error(
    `See CLAUDE.md § "Protocol primitives belong in packages, never inline in services".`,
  );
  process.exit(1);
}

main();
