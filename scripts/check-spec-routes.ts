#!/usr/bin/env tsx
/**
 * check-spec-routes — protocol-faithfulness gate for the HTTP route surface.
 *
 * Companion to check-spec-tools (#47). Same three-layer pattern (spec
 * convention + impl annotation + narrow gate); same three rules; same
 * @experimental temporal-sanity contract.
 *
 * Three rules, derived live from spec + annotation + impl tree:
 *
 *   (a) promise-not-served — a spec declares a `METHOD /path` in a
 *       "#### Routes (foundation law)" block but no implementation
 *       annotates a matching route with @spec <that-spec-id>.
 *   (b) orphan-annotation — an implementation annotates a route with
 *       @spec X but spec X does not declare that METHOD/path in any
 *       "#### Routes (foundation law)" block.
 *   (c) unclassified — a public route construct (a `app.<method>("path", ...)`
 *       call inside services/relay/src/) carries none of @spec / @internal /
 *       @experimental.
 *
 * Plus the @experimental temporal-sanity rule (mirrors
 * check-deprecation-discipline #39 and check-spec-tools #47):
 *
 *   (d) experimental-incomplete — an @experimental annotation is missing
 *       any of @since, @stabilizes_by, @replacement, @reason.
 *   (e) experimental-past-due — @stabilizes_by has elapsed.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const SPEC_DIR = join(REPO_ROOT, "spec");
const RELAY_SRC_DIR = join(REPO_ROOT, "services", "relay", "src");

const ROUTES_HEADER = /^####\s+Routes\s*\(foundation law\)\s*$/i;
const SPEC_TITLE = /^#\s+(motebit\/[a-z0-9-]+@\d+\.\d+)/;
const ANY_HEADER = /^#{1,6}\s+/;
// Bullet entry: `- \`METHOD /path\` — description`. The route key is
// `METHOD path` (uppercased METHOD). Path tokens may include `:param`.
const BULLET_ROUTE = /^\s*[-*]\s+`(GET|POST|PUT|PATCH|DELETE)\s+(\/\S*)`/i;

interface SpecRouteDecl {
  specId: string;
  method: string;
  path: string;
  file: string;
  line: number;
}

function parseSpecId(content: string): string | null {
  const lines = content.split("\n");
  for (const line of lines) {
    const m = line.match(SPEC_TITLE);
    if (m) return m[1]!;
    if (line.startsWith("#")) break;
  }
  return null;
}

function collectSpecRoutes(): SpecRouteDecl[] {
  const out: SpecRouteDecl[] = [];
  const files = readdirSync(SPEC_DIR).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const file = join(SPEC_DIR, f);
    const content = readFileSync(file, "utf-8");
    const specId = parseSpecId(content);
    if (!specId) continue;
    const lines = content.split("\n");
    let inRoutesBlock = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (ROUTES_HEADER.test(line)) {
        inRoutesBlock = true;
        continue;
      }
      if (inRoutesBlock && ANY_HEADER.test(line)) {
        inRoutesBlock = false;
        continue;
      }
      if (inRoutesBlock) {
        const m = line.match(BULLET_ROUTE);
        if (m) {
          out.push({
            specId,
            method: m[1]!.toUpperCase(),
            path: m[2]!,
            file: f,
            line: i + 1,
          });
        }
      }
    }
  }
  return out;
}

interface PendingAnnotation {
  type: "spec" | "internal" | "experimental";
  specId?: string;
  experimental?: {
    since?: string;
    stabilizesBy?: string;
    replacement?: string;
    reason?: string;
  };
  line: number;
}

interface ImplRouteAnnotation {
  method: string;
  path: string;
  classification: "spec" | "internal" | "experimental";
  specId?: string;
  experimental?: PendingAnnotation["experimental"];
  file: string;
  annotationLine: number;
  declarationLine: number;
}

interface ImplRouteUnclassified {
  method: string;
  path: string;
  file: string;
  line: number;
}

const SINGLE_LINE_ANN = /^\s*\/\*\*\s*@(spec|internal|experimental)(?:\s+([^\s*]+))?\s*\*\/\s*$/;
const JSDOC_OPEN = /^\s*\/\*\*\s*$/;
const JSDOC_CLOSE = /\*\/\s*$/;

const ROUTE_DECL =
  /^\s*(?:app|router|api|hono)\.(get|post|put|patch|delete|all)\(\s*["']([^"']+)["']/i;
// Multi-line form: `app.get(\n  "/path", ...` — path string lands on a
// subsequent non-blank line. Used by upgradeWebSocket-shaped registrations.
const ROUTE_DECL_OPEN = /^\s*(?:app|router|api|hono)\.(get|post|put|patch|delete|all)\(\s*$/i;
const STRING_LITERAL_LINE = /^\s*["']([^"']+)["']/;
const PENDING_TTL_LINES = 12;

function parseJsdocBlock(block: string): PendingAnnotation | null {
  const tags: Record<string, string> = {};
  // Use [ \t]* not \s* — \s matches newlines, which would let @experimental
  // (with no value on its own line) swallow the next line's @since tag.
  const re =
    /@(spec|internal|experimental|since|stabilizes_by|replacement|reason)\b[ \t]*([^\n]*)/g;
  for (const m of block.matchAll(re)) {
    const tag = m[1]!.toLowerCase();
    const val = (m[2] ?? "")
      .replace(/\s*\*\/\s*$/, "")
      .replace(/^\s*\*\s*/g, "")
      .trim();
    tags[tag] = val;
  }
  if ("spec" in tags) {
    return { type: "spec", specId: tags.spec || undefined, line: 0 };
  }
  if ("internal" in tags) {
    return { type: "internal", line: 0 };
  }
  if ("experimental" in tags) {
    return {
      type: "experimental",
      experimental: {
        since: tags.since,
        stabilizesBy: tags.stabilizes_by,
        replacement: tags.replacement,
        reason: tags.reason,
      },
      line: 0,
    };
  }
  return null;
}

function scanImplFile(
  file: string,
  content: string,
): { annotations: ImplRouteAnnotation[]; unclassified: ImplRouteUnclassified[] } {
  const lines = content.split("\n");
  const annotations: ImplRouteAnnotation[] = [];
  const unclassified: ImplRouteUnclassified[] = [];

  let pending: PendingAnnotation | null = null;

  const consume = (method: string, path: string, declarationLine: number): void => {
    if (pending && declarationLine - pending.line <= PENDING_TTL_LINES) {
      annotations.push({
        method: method.toUpperCase(),
        path,
        classification: pending.type,
        specId: pending.specId,
        experimental: pending.experimental,
        file,
        annotationLine: pending.line,
        declarationLine,
      });
    } else {
      unclassified.push({ method: method.toUpperCase(), path, file, line: declarationLine });
    }
    pending = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const single = line.match(SINGLE_LINE_ANN);
    if (single) {
      const type = single[1] as "spec" | "internal" | "experimental";
      pending = {
        type,
        specId: type === "spec" ? single[2] : undefined,
        line: i + 1,
      };
      continue;
    }

    if (JSDOC_OPEN.test(line)) {
      let block = "";
      let j = i + 1;
      while (j < lines.length && !JSDOC_CLOSE.test(lines[j]!)) {
        block += lines[j] + "\n";
        j++;
      }
      if (j < lines.length) block += lines[j];
      const parsed = parseJsdocBlock(block);
      if (parsed) {
        parsed.line = i + 1;
        pending = parsed;
      }
      i = j;
      continue;
    }

    const route = line.match(ROUTE_DECL);
    if (route) {
      consume(route[1]!, route[2]!, i + 1);
      continue;
    }

    // Multi-line route registration: `app.get(\n  "/path", ...`.
    const open = line.match(ROUTE_DECL_OPEN);
    if (open) {
      for (let k = i + 1; k < Math.min(i + 5, lines.length); k++) {
        const next = lines[k]!;
        if (next.trim() === "") continue;
        const lit = next.match(STRING_LITERAL_LINE);
        if (lit) {
          consume(open[1]!, lit[1]!, k + 1);
        }
        break;
      }
      continue;
    }
  }

  return { annotations, unclassified };
}

function collectImplAnnotations(): {
  annotations: ImplRouteAnnotation[];
  unclassified: ImplRouteUnclassified[];
} {
  const allAnn: ImplRouteAnnotation[] = [];
  const allUn: ImplRouteUnclassified[] = [];

  // Scan every .ts file under services/relay/src/ except __tests__.
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === "__tests__" || entry === "dist") continue;
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      const rel = full.slice(REPO_ROOT.length + 1);
      const content = readFileSync(full, "utf-8");
      const r = scanImplFile(rel, content);
      allAnn.push(...r.annotations);
      allUn.push(...r.unclassified);
    }
  };
  walk(RELAY_SRC_DIR);

  return { annotations: allAnn, unclassified: allUn };
}

function parseStabilizesBy(value: string): Date | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const d = new Date(value);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

// Spec-side paths use `:param` placeholders, which match the impl form
// directly. No further normalization needed today; this hook exists so
// future spec-side `{param}` bracket syntax could be normalized to
// colon form without rewriting every spec.
function normalizePath(path: string): string {
  return path.replace(/\{([^}]+)\}/g, ":$1");
}

function main(): void {
  const specRoutes = collectSpecRoutes();
  const { annotations, unclassified } = collectImplAnnotations();

  const findings: string[] = [];

  const annBySpecKey = new Map<string, ImplRouteAnnotation>();
  for (const a of annotations) {
    if (a.classification === "spec" && a.specId) {
      annBySpecKey.set(`${a.specId}::${a.method} ${normalizePath(a.path)}`, a);
    }
  }
  const specByKey = new Map<string, SpecRouteDecl>();
  for (const s of specRoutes) {
    specByKey.set(`${s.specId}::${s.method} ${normalizePath(s.path)}`, s);
  }

  // Rule (a)
  for (const [key, s] of specByKey) {
    if (!annBySpecKey.has(key)) {
      findings.push(
        `promise-not-served: spec/${s.file}:${s.line} declares "${s.method} ${s.path}" under ${s.specId} but no implementation annotates @spec ${s.specId} on a route matching that method+path.`,
      );
    }
  }

  // Rule (b)
  for (const [key, a] of annBySpecKey) {
    if (!specByKey.has(key)) {
      findings.push(
        `orphan-annotation: ${a.file}:${a.annotationLine} annotates @spec ${a.specId} on route "${a.method} ${a.path}" but ${a.specId} declares no such method+path in any "#### Routes (foundation law)" block.`,
      );
    }
  }

  // Rule (c)
  for (const u of unclassified) {
    findings.push(
      `unclassified: ${u.file}:${u.line} route "${u.method} ${u.path}" has no @spec/@internal/@experimental annotation.`,
    );
  }

  // Rules (d) and (e)
  const today = new Date();
  for (const a of annotations) {
    if (a.classification !== "experimental") continue;
    const f = a.experimental ?? {};
    const missing: string[] = [];
    if (!f.since) missing.push("@since");
    if (!f.stabilizesBy) missing.push("@stabilizes_by");
    if (!f.replacement) missing.push("@replacement");
    if (!f.reason) missing.push("@reason");
    if (missing.length > 0) {
      findings.push(
        `experimental-incomplete: ${a.file}:${a.annotationLine} route "${a.method} ${a.path}" @experimental annotation missing ${missing.join(", ")}. Four-field contract required.`,
      );
    }
    if (f.stabilizesBy) {
      const d = parseStabilizesBy(f.stabilizesBy);
      if (d && d < today) {
        findings.push(
          `experimental-past-due: ${a.file}:${a.annotationLine} route "${a.method} ${a.path}" @stabilizes_by ${f.stabilizesBy} is past due. Promote to @spec, demote to @internal, or remove.`,
        );
      }
    }
  }

  console.log(
    `check-spec-routes — ${specRoutes.length} spec-declared route(s), ${annotations.length} annotation(s), ${unclassified.length} unclassified\n`,
  );

  if (findings.length > 0) {
    console.log(`✗ ${findings.length} finding(s):\n`);
    for (const f of findings) console.log(`  ${f}`);
    console.log(
      `\n  Fix: ensure every public route has @spec/@internal/@experimental,\n` +
        `       every @spec X cross-references a "#### Routes (foundation law)" entry in spec X,\n` +
        `       every spec-declared route is implemented under that @spec, and\n` +
        `       every @experimental carries the four-field contract with a not-past-due @stabilizes_by.`,
    );
    process.exit(1);
  }

  console.log(
    `✓ All ${annotations.length} route annotations align with ${specRoutes.length} spec declaration(s); no unclassified routes.`,
  );
}

main();
