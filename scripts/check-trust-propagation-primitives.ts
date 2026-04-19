/**
 * Trust-propagation-primitive drift gate (invariant #30).
 *
 * Enforces: multi-hop trust propagation across the credential graph
 * (walk issuer→subject edges, multiply issuer-trust × credential-weight
 * along a chain, pick max across competing paths) lives in
 * `@motebit/market` (`propagateTrust` + `buildTrustGraph`). Inline
 * reinvention in apps, services, or sibling packages is a CI failure.
 *
 * ## Why this gate exists
 *
 * Before 2026-04-19 `credential-weight.ts` asked callers to supply a
 * `getIssuerTrust(did)` function. Callers typically answered only with
 * one-hop trust, because walking the credential graph multi-hop — with
 * product-along-chain, max-across-parallel — is exactly the algebra the
 * semiring pattern collapses into a single primitive. Without a gate, the
 * next surface or service that wants "trust of an agent via the whole
 * credential chain" would write its own loop with slightly different
 * aggregation, and the admin UI would show a different propagated score
 * than AI-core or the market router. Same drift shape as #27/#28/#29:
 * parallel implementations of the same judgment diverging silently.
 *
 * ## Heuristic (all three required in one file)
 *
 *   1. References a credential-edge shape — at least two of:
 *      `credentialSubject`, `issuer`, `did:key`, or `VC_TYPE_REPUTATION`.
 *      This is the attestation-graph vocabulary.
 *   2. Combines issuer-trust × credential-weight in an aggregation
 *      expression — heuristic: literal `issuerTrust *` or
 *      `trust *` × a weight identifier (`weight`, `success_rate`,
 *      `trust_score`, `confidence`) within three lines. Single-hop
 *      weighting (like `credential-weight.ts` does) is allowed when
 *      the caller supplies the trust — the gate targets multi-hop
 *      aggregators that combine trust × weight in a loop.
 *   3. Does NOT import `propagateTrust` or `buildTrustGraph` from
 *      `@motebit/market`. Consumers that import the canonical primitive
 *      are by definition not reinventors.
 *
 * ## Owning package
 *
 *   - `@motebit/market` (packages/market/src/trust-propagation.ts,
 *     credential-weight.ts)
 *
 * Allowlist is empty at landing. Any future exception must add a row
 * here with the reason + follow-up pass named.
 *
 * Exit 1 on violation. Runs in CI via `pnpm check`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const ALLOWLIST: ReadonlyArray<{ path: string; reason: string }> = [];

interface Violation {
  file: string;
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
    if (entry === "node_modules" || entry === "dist" || entry === "__tests__" || entry === ".turbo")
      continue;
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

function countMatches(source: string, patterns: RegExp[]): number {
  let count = 0;
  for (const p of patterns) {
    if (p.test(source)) count++;
  }
  return count;
}

function scan(): Violation[] {
  const violations: Violation[] = [];
  const allowSet = new Set(ALLOWLIST.map((e) => e.path));

  // market is the owning package. Scan everything else.
  const OWNED = new Set(["market"]);
  const scanRoots = [
    join(ROOT, "apps"),
    join(ROOT, "services"),
    ...readdirSync(join(ROOT, "packages"))
      .filter((name) => !OWNED.has(name))
      .map((name) => join(ROOT, "packages", name)),
  ];

  for (const root of scanRoots) {
    let subdirs: string[];
    try {
      subdirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const sub of subdirs) {
      const srcDir = join(root, sub, "src");
      const files = walkTypeScript(srcDir);
      for (const file of files) {
        const rel = relative(ROOT, file);
        if (allowSet.has(rel)) continue;
        const source = readFileSync(file, "utf8");

        // 1. Credential-vocabulary threshold — ≥2 of these terms.
        const vocabHits = countMatches(source, [
          /\bcredentialSubject\b/,
          /\bVC_TYPE_REPUTATION\b/,
          /\bdid:key\b/,
          // "issuer" is common enough that we require it alongside
          // another credential-specific term, not on its own.
          /\bissuer\b/,
        ]);
        if (vocabHits < 2) continue;

        // 2. Multi-hop aggregation signature — a trust-times-weight
        //    expression combined with a graph-traversal construct. We
        //    look for `getIssuerTrust(`/`issuerTrust` (the naming of the
        //    one-hop callback in credential-weight.ts) paired with
        //    iteration over credentials or explicit loop-state. Any file
        //    that does this without the canonical import is reinventing
        //    what propagateTrust already provides.
        const usesIssuerTrust =
          /\bissuerTrust\b/.test(source) || /\bgetIssuerTrust\s*\(/.test(source);
        const iteratesCreds =
          /\bfor\s*\([^)]*\b(credential|vc|cred)s?\b/i.test(source) ||
          /\bcredentials\s*\.\s*(forEach|reduce|map|filter)\b/.test(source);
        if (!usesIssuerTrust || !iteratesCreds) continue;

        // 3. Canonical-import check — consumers get a pass.
        const importsCanonical =
          /\bpropagateTrust\b/.test(source) ||
          /\bbuildTrustGraph\b/.test(source) ||
          /\bmakeIssuerTrustResolver\b/.test(source);
        if (importsCanonical) continue;

        violations.push({
          file: rel,
          detail:
            "inline trust-propagation — file combines credential-graph vocabulary (credentialSubject / issuer / VC_TYPE_REPUTATION / did:key) with an issuerTrust × weight aggregation over a loop of credentials without importing the canonical primitive. Use `propagateTrust` (or `makeIssuerTrustResolver`) from `@motebit/market` instead — it walks the credential graph under TrustSemiring (max-times) and returns the best path with provenance.",
        });
      }
    }
  }
  return violations;
}

function main(): void {
  console.log(
    "▸ check-trust-propagation-primitives — multi-hop trust propagation over the credential graph (walk issuer→subject edges, product-along-chain × max-across-parallel under TrustSemiring) lives in @motebit/market (propagateTrust + buildTrustGraph), not inline in apps/services/sibling-packages (invariant #30, added 2026-04-19 as the third non-trivial semiring consumer beyond routing + retrieval/notability — extends the protocol-primitive doctrine to credential-graph judgment and locks in the pattern of one primitive, many callers, swappable algebra)",
  );
  const violations = scan();
  if (violations.length === 0) {
    console.log(
      `✓ check-trust-propagation-primitives: no inline trust-propagation in scanned source (allowlist: ${ALLOWLIST.length}).`,
    );
    process.exit(0);
  }

  console.error(`✗ check-trust-propagation-primitives: ${violations.length} violation(s):\n`);
  for (const v of violations) {
    console.error(`  ${v.file}`);
    console.error(`    ${v.detail}\n`);
  }
  console.error(
    "Fix: import `propagateTrust` from `@motebit/market` and pass credential edges + root anchors. The primitive returns `PropagatedTrust[]` with both score and path so UI can render provenance. If you need a callback-shaped resolver to plug into `aggregateCredentialReputation`, import `makeIssuerTrustResolver` instead.",
  );
  console.error(
    "If the file legitimately needs inline aggregation that can't be expressed via propagateTrust, add it to ALLOWLIST in scripts/check-trust-propagation-primitives.ts with the reason + follow-up pass named.",
  );
  process.exit(1);
}

main();
