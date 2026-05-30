#!/usr/bin/env tsx
/**
 * check-state-export-signed — synchronization invariant for the
 * doctrine §8 promise that every state-export endpoint emits a
 * relay-asserted `ContentArtifactManifest`.
 *
 * Doctrine: `docs/doctrine/nist-alignment.md` §8 "Recognition note";
 * `docs/doctrine/self-attesting-system.md`. Sibling shape to
 * `check-audience-canonical` and `check-artifact-type-canonical` —
 * sixth closed-registry / structural-lock drift gate in the state-
 * export-signing series.
 *
 * Pre-this-gate, 1 of 12 state-export endpoints (the execution-ledger
 * reconstruction) emitted a signed manifest; the doctrine §8 claimed
 * "shipped." Same shape as the original §8 over-claim that this gate's
 * sibling (`check-doctrine-citations`) caught at the doctrine-prose
 * layer — now caught at the consumer-wiring layer.
 *
 * Forbidden: a route registration of ANY verb (`app.get`, `app.post`,
 * `app.put`, `app.patch`, `app.all`, `app.delete`) in
 * `services/relay/src/state-export.ts` whose handler body does not call
 * `emitSignedExport(...)` before returning — UNLESS the route is an
 * explicitly-classified mutation in `MUTATION_ALLOWLIST`.
 *
 *   ✗  app.get("/api/v1/state/:motebitId", async (c) => {
 *        const ...;
 *        return c.json({ ... });                       // unsigned
 *      });
 *
 *   ✓  app.get("/api/v1/state/:motebitId", async (c) => {
 *        const ...;
 *        return emitSignedExport(c, "state-snapshot", { ... });
 *      });
 *
 * Scope: only `services/relay/src/state-export.ts`. The file's own
 * header declares "Pure reads"; every read here is a state export by
 * definition, and every state export must be signed. Earlier this gate
 * inspected only GETs — a state read smuggled in under POST/PUT/ALL would
 * have escaped silently (the gate's scan was narrower than the "every state
 * export is signed" invariant). It now scans every verb. Genuine mutations
 * (today: the `app.delete(...)` memory tombstone) are exempted by an explicit
 * `MUTATION_ALLOWLIST` entry — the read-vs-mutation classification is an
 * audited line, not an invisible verb-scope gap.
 *
 * Adding a state-export endpoint without a signed manifest emission
 * fails CI here; remove the endpoint or wire it through
 * `emitSignedExport(c, "<artifact-type>", body)`. New artifact types
 * require updating `packages/protocol/src/artifact-type.ts` (closed
 * registry, also caught by `check-artifact-type-canonical`).
 *
 * Usage:
 *   tsx scripts/check-state-export-signed.ts        # exit 1 on violation
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const TARGET = "services/relay/src/state-export.ts";

/**
 * Routes that are genuine MUTATIONS, not state exports — they need their own
 * signing decision and are exempt from the emit-signed requirement. Listed
 * explicitly (method + route) so the read-vs-mutation classification is an
 * AUDITED line in this file, not an invisible consequence of "the gate only
 * scanned GETs." Adding a non-GET route to state-export.ts forces a choice:
 * route it through `emitSignedExport` (it serves a read) or add it here (it
 * mutates). A read smuggled in under POST/PUT/ALL can no longer hide.
 */
const MUTATION_ALLOWLIST: ReadonlyArray<{ method: string; route: string }> = [
  // Memory tombstone — deletes a memory node. A mutation; no signed export.
  { method: "delete", route: "/api/v1/memory/:motebitId/:nodeId" },
];

/**
 * Strip line-comments and string-literals so paren counting works
 * over actual code rather than prose. Conservative: replaces string
 * contents with same-length blanks to preserve column offsets;
 * line-comments and block-comments become blanks.
 */
function stripCommentsAndStrings(src: string): string {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i]!;
    const next = i + 1 < n ? src[i + 1]! : "";
    // Line comment
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    // Block comment
    if (ch === "/" && next === "*") {
      out += "  ";
      i += 2;
      while (i < n && !(src[i] === "*" && i + 1 < n && src[i + 1] === "/")) {
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += "  ";
        i += 2;
      }
      continue;
    }
    // String literal (single, double, backtick)
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += quote;
      i++;
      while (i < n && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < n) {
          // Preserve escape; blank both chars to maintain length
          out += "  ";
          i += 2;
          continue;
        }
        out += src[i] === "\n" ? "\n" : " ";
        i++;
      }
      if (i < n) {
        out += quote;
        i++;
      }
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

interface Finding {
  method: string;
  route: string;
  startLine: number;
  endLine: number;
  reason: string;
}

function scanFile(absPath: string): Finding[] {
  const src = readFileSync(absPath, "utf-8");
  const stripped = stripCommentsAndStrings(src);
  const lines = src.split("\n");
  const findings: Finding[] = [];

  // Walk character-by-character on the stripped source, find each route
  // registration of ANY verb (`app.get(`, `app.post(`, `app.put(`,
  // `app.patch(`, `app.all(`, `app.delete(`), paren-track to its closing
  // `)`, then map back to lines + check the original source slice for the
  // helper call. Scanning every verb — not just GET — closes the blind spot
  // where a state read served via POST/PUT/ALL would never be checked for a
  // signed manifest. Genuine mutations are exempted via MUTATION_ALLOWLIST.
  const re = /\bapp\.(get|post|put|patch|all|delete)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const method = m[1]!; // the HTTP verb
    const openParenIdx = m.index + m[0].length - 1; // the `(` is the last char of the match
    let depth = 1;
    let j = openParenIdx + 1;
    while (j < stripped.length && depth > 0) {
      const ch = stripped[j]!;
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      j++;
    }
    if (depth !== 0) continue;
    const closeIdx = j; // points to char AFTER closing `)`
    const bodySlice = src.slice(m.index, closeIdx);

    // Locate the route literal — `app.<verb>("...", ...)` — from the
    // original (non-stripped) source to preserve quote content.
    const routeMatch = bodySlice.match(/app\.\w+\s*\(\s*["'`]([^"'`]+)["'`]/);
    const route = routeMatch ? routeMatch[1]! : "<unknown>";

    // A genuine mutation (explicitly classified) is not an export — skip it.
    if (MUTATION_ALLOWLIST.some((a) => a.method === method && a.route === route)) continue;

    // Lines spanned (1-based) for reporting.
    const startLine = src.slice(0, m.index).split("\n").length;
    const endLine = src.slice(0, closeIdx).split("\n").length;

    if (!/\bemitSignedExport\s*\(/.test(bodySlice)) {
      findings.push({
        method,
        route,
        startLine,
        endLine,
        reason:
          method === "get"
            ? "handler returns without calling emitSignedExport(...)"
            : `${method.toUpperCase()} route is neither signed (emitSignedExport) nor in MUTATION_ALLOWLIST — a state read served via ${method.toUpperCase()} must emit a signed manifest`,
      });
    }
  }

  // Defensive: also verify the helper itself is declared in the file.
  // A rename or extraction would break the gate silently otherwise —
  // the gate's correctness depends on this symbol being the canonical
  // emit path. If the helper is removed, every endpoint scan would
  // flag (loud failure), so this is a belt-and-suspenders sibling check.
  if (!/\bfunction\s+emitSignedExport\s*\(/.test(stripped)) {
    findings.push({
      method: "-",
      route: "<sibling alignment>",
      startLine: 0,
      endLine: 0,
      reason:
        "emitSignedExport helper not declared in state-export.ts — gate's canonical emit-path symbol is missing or renamed",
    });
  }

  // Eslint-style: surface unused parameter (suppresses lint).
  void lines;
  return findings;
}

function main(): void {
  const abs = resolve(REPO_ROOT, TARGET);
  const findings = scanFile(abs);

  console.log(
    `check-state-export-signed — scanned ${TARGET} for app.<verb>(...) route registrations missing emitSignedExport(...) (mutations exempted via MUTATION_ALLOWLIST)\n`,
  );

  if (findings.length === 0) {
    console.log(
      `✓ Every state-export route registration emits a signed manifest (or is an allowlisted mutation).`,
    );
    return;
  }

  console.log(`✗ State-export endpoint not wired through emitSignedExport:\n`);
  for (const f of findings) {
    if (f.startLine === 0) {
      console.log(`  ${TARGET}:?  ${f.reason}`);
    } else {
      console.log(
        `  ${TARGET}:${f.startLine}-${f.endLine}  ${f.method.toUpperCase()} ${f.route}  (${f.reason})`,
      );
    }
  }
  console.log(
    `\n  Fix: route the handler through the closure-scope helper:\n` +
      `       return emitSignedExport(c, "<artifact-type>", body);\n` +
      `       New artifact types require a registry append in\n` +
      `       packages/protocol/src/artifact-type.ts AND a gate update\n` +
      `       in scripts/check-artifact-type-canonical.ts.\n` +
      `       Doctrine: docs/doctrine/nist-alignment.md §8.\n`,
  );
  process.exit(1);
}

main();
