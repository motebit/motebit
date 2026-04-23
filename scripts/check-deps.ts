/**
 * Architectural dependency enforcement for the Motebit monorepo.
 *
 * Ten checks:
 *   1. No circular dependencies between @motebit/* packages
 *   2. No imports from internal paths (@motebit/foo/src/* or /dist/*)
 *   3. Layer ordering — lower layers cannot depend on higher layers
 *   4. Export surface — every package with src/ must have src/index.ts
 *   5. Undeclared dependencies — every @motebit/* import must be in package.json
 *   6. package.json field order — name, version, license, private for private packages
 *   7. tsconfig.json references — must match production @motebit/* dependencies
 *   8. No license text in source files — license lives in package.json, not headers
 *   9. MIT purity — MIT packages must not import from BSL packages
 *  10. MIT export surface — MIT packages must export only types, enums, branded
 *      casts, and constants (no algorithms)
 *
 * Exit code 1 on any violation. Designed to run in CI before typecheck.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── Layer map ──────────────────────────────────────────────────────────
// Layer N may depend on layers 0..N-1 (production) or 0..N (devDependencies).
// Apps/services are Layer 5 and may depend on anything.

const LAYER: Record<string, number> = {
  // Layer 0 — Foundation (zero internal deps)
  "@motebit/protocol": 0,
  "@motebit/sdk": 0,
  "@motebit/crypto": 0,
  "@motebit/voice": 0,

  // Layer 1 — Primitives (depend only on Layer 0)
  "@motebit/encryption": 1,
  "@motebit/gradient": 1,
  "@motebit/event-log": 1,
  "@motebit/policy": 1,
  "@motebit/tools": 1,
  "@motebit/semiring": 1,
  "@motebit/policy-invariants": 1,
  "@motebit/wallet-solana": 1,
  "@motebit/circuit-breaker": 1,
  "@motebit/settlement-rails": 1,
  "@motebit/evm-rpc": 1,
  "@motebit/virtual-accounts": 1,
  "@motebit/deposit-detector": 1,
  "@motebit/self-knowledge": 1,
  "@motebit/wire-schemas": 1,

  // Layer 2 — Engines (depend on Layer 0–1)
  "@motebit/crypto-appattest": 2,
  "@motebit/crypto-play-integrity": 2,
  "@motebit/market": 2,
  "@motebit/behavior-engine": 2,
  "@motebit/state-vector": 2,
  "@motebit/render-engine": 2,
  "@motebit/memory-graph": 2,
  "@motebit/core-identity": 2,
  "@motebit/sync-engine": 2,
  "@motebit/mcp-client": 2,
  "@motebit/identity-file": 2,

  // Layer 3 — Lower composites (depend on Layer 0–2)
  "@motebit/privacy-layer": 3,
  "@motebit/ai-core": 3,
  "@motebit/mcp-server": 3,

  // Layer 4 — Upper composites (depend on Layer 0–3)
  "@motebit/persistence": 4,
  "@motebit/planner": 4,
  "@motebit/reflection": 4,

  // Layer 5 — Orchestrator
  "@motebit/runtime": 5,
  "@motebit/browser-persistence": 5,
  "@motebit/panels": 5,

  // Layer 6 — Applications (apps/*, services/*, create-motebit, molecule-runner, verifier)
  "create-motebit": 6,
  "@motebit/molecule-runner": 6,
  "@motebit/verifier": 6,
};

const APP_LAYER = 6;

// MIT-licensed packages — must not import from BSL packages, must export only types.
const MIT_PACKAGES = new Set([
  "@motebit/protocol",
  "@motebit/sdk",
  "@motebit/crypto",
  "create-motebit",
  "@motebit/verifier",
]);

// MIT packages allowed to import from other MIT packages only (plus external deps).
// create-motebit is bundled (tsup) so devDeps are inlined — but only MIT deps allowed.
// @motebit/verifier ships unbundled and depends on @motebit/crypto at runtime.
const MIT_IMPORT_ALLOWED = new Set([
  "@motebit/protocol",
  "@motebit/sdk",
  "@motebit/crypto",
  "create-motebit",
  "@motebit/verifier",
]);

// Allowlisted non-trivial exported functions in MIT packages.
// These are reviewed and confirmed safe: branded casts, parse/verify utilities.
// Any new function export in an MIT package requires explicit allowlisting here.
const MIT_ALLOWED_FUNCTIONS: Record<string, Set<string>> = {
  "@motebit/protocol": new Set([
    // Branded ID casts
    "asMotebitId",
    "asDeviceId",
    "asNodeId",
    "asGoalId",
    "asEventId",
    "asConversationId",
    "asPlanId",
    "asAllocationId",
    "asSettlementId",
    "asListingId",
    "asProposalId",
    "isDepositableRail",
    "isBatchableRail",
    // Semiring algebra — protocol-level primitives (open standard)
    "productSemiring",
    "recordSemiring",
    "mappedSemiring",
    "optimalPaths",
    "optimalPath",
    "transitiveClosure",
    "optimalPathTrace",
    "trustLevelToScore",
    "trustAdd",
    "trustMultiply",
    "composeTrustChain",
    "joinParallelRoutes",
    // Cryptosuite registry — pure type guard + lookup over a frozen record
    "isSuiteId",
    "getSuiteEntry",
    // Tool-mode taxonomy — pure sort-priority lookup over a closed union
    "toolModePriority",
  ]),
  "@motebit/crypto": new Set([
    // Artifact verification (original verify package)
    "verify",
    "verifyIdentityFile",
    "parse",
    // Signing primitives
    "canonicalJson",
    "bytesToHex",
    "hexToBytes",
    "toBase64Url",
    "fromBase64Url",
    "base58btcEncode",
    "base58btcDecode",
    "didKeyToPublicKey",
    "publicKeyToDidKey",
    "hexPublicKeyToDidKey",
    "hash",
    "sha256",
    "generateKeypair",
    "ed25519Sign",
    "ed25519Verify",
    "getPublicKeyBySuite",
    "createSignedToken",
    "verifySignedToken",
    "parseScopeSet",
    "isScopeNarrowed",
    // Artifact signing
    "signExecutionReceipt",
    "verifyExecutionReceipt",
    "signSovereignPaymentReceipt",
    "verifyReceiptChain",
    "verifyReceiptSequence",
    "signDelegation",
    "verifyDelegation",
    "verifyDelegationChain",
    "signKeySuccession",
    "signGuardianRecoverySuccession",
    "verifyKeySuccession",
    "verifySuccessionChain",
    "signGuardianRevocation",
    "verifyGuardianRevocation",
    "signCollaborativeReceipt",
    "verifyCollaborativeReceipt",
    // Credential signing
    "signVerifiableCredential",
    "verifyVerifiableCredential",
    "signVerifiablePresentation",
    "verifyVerifiablePresentation",
    "issueGradientCredential",
    "issueReputationCredential",
    "issueTrustCredential",
    "createPresentation",
    // Credential anchoring (credential-anchor-v1.md §3, §5.2)
    "computeCredentialLeaf",
    "verifyCredentialAnchor",
  ]),
};

// ── Types ──────────────────────────────────────────────────────────────

interface PkgInfo {
  name: string;
  dir: string;
  deps: string[]; // @motebit/* production dependencies
  devDeps: string[]; // @motebit/* dev dependencies
  exports: Record<string, unknown> | undefined;
}

// ── Helpers ────────────────────────────────────────────────────────────

function discoverPackages(): PkgInfo[] {
  const dirs = ["packages", "apps", "services"];
  const result: PkgInfo[] = [];

  for (const base of dirs) {
    const absBase = join(ROOT, base);
    if (!existsSync(absBase)) continue;
    for (const entry of readdirSync(absBase)) {
      const pkgJson = join(absBase, entry, "package.json");
      if (!existsSync(pkgJson)) continue;
      const pkg = JSON.parse(readFileSync(pkgJson, "utf-8")) as Record<string, unknown>;
      const name = pkg.name as string | undefined;
      if (!name) continue;

      const allDeps = pkg.dependencies as Record<string, string> | undefined;
      const allDevDeps = pkg.devDependencies as Record<string, string> | undefined;

      result.push({
        name,
        dir: join(absBase, entry),
        deps: Object.keys(allDeps ?? {}).filter(
          (d) => d.startsWith("@motebit/") || d === "create-motebit",
        ),
        devDeps: Object.keys(allDevDeps ?? {}).filter(
          (d) => d.startsWith("@motebit/") || d === "create-motebit",
        ),
        exports: pkg.exports as Record<string, unknown> | undefined,
      });
    }
  }
  return result;
}

/** Extract @motebit/* package name from an import specifier. */
function extractPkgName(specifier: string): string | null {
  if (specifier === "create-motebit") return "create-motebit";
  const m = /^(@motebit\/[^/]+)/.exec(specifier);
  return m ? m[1] : null;
}

/** Extract sub-path from an import specifier (e.g., "browser" from "@motebit/ai-core/browser"). */
function extractSubPath(specifier: string): string | null {
  if (specifier === "create-motebit") return null;
  const m = /^@motebit\/[^/]+\/(.+)$/.exec(specifier);
  return m ? m[1] : null;
}

/** Get declared sub-path export keys from a package's exports field. */
function getDeclaredSubPaths(exports: Record<string, unknown> | undefined): Set<string> {
  const paths = new Set<string>();
  if (!exports) return paths;
  for (const key of Object.keys(exports)) {
    if (key === ".") continue;
    // "./browser" → "browser", "./dist/*" → wildcard (skip)
    const sub = key.replace(/^\.\//, "");
    if (sub.includes("*")) continue; // wildcards are not allowed — they undermine boundary enforcement
    paths.add(sub);
  }
  return paths;
}

/** Recursively collect all .ts/.tsx files under a directory, excluding node_modules and dist. */
function collectSourceFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  function walk(d: string): void {
    for (const entry of readdirSync(d)) {
      if (entry === "node_modules" || entry === "dist" || entry === ".next" || entry === ".turbo")
        continue;
      const full = join(d, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry) && !entry.endsWith(".d.ts")) {
        files.push(full);
      }
    }
  }
  walk(dir);
  return files;
}

/** Extract all @motebit/* import specifiers from a source file. */
function extractImports(
  filePath: string,
): Array<{ specifier: string; line: number; typeOnly: boolean }> {
  const content = readFileSync(filePath, "utf-8");
  const results: Array<{ specifier: string; line: number; typeOnly: boolean }> = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check for "import type" or "import { type ... } from" patterns
    const isTypeImport = /^\s*import\s+type\s/.test(line);

    // Match: import ... from "@motebit/...", require("@motebit/..."), import("@motebit/...")
    const patterns = [
      /from\s+['"](@motebit\/[^'"]+)['"]/g,
      /from\s+['"](create-motebit)['"]/g,
      /require\(\s*['"](@motebit\/[^'"]+)['"]\s*\)/g,
      /import\(\s*['"](@motebit\/[^'"]+)['"]\s*\)/g,
    ];
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(line)) !== null) {
        results.push({ specifier: match[1], line: i + 1, typeOnly: isTypeImport });
      }
    }
  }
  return results;
}

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes("__tests__") || filePath.endsWith(".test.ts") || filePath.endsWith(".spec.ts")
  );
}

/**
 * Auto-generated TS modules may carry committed data containing verbatim
 * license tokens or import-shaped substrings (e.g., a README code fence
 * showing `import { verify } from "@motebit/crypto"` lands as a data
 * string in a corpus index). These are DATA, not imports — the generator,
 * not a human, owns the file. Checks that scan header/source text should
 * skip these.
 */
const AUTOGEN_BANNER = /AUTO-GENERATED|@generated/i;

function isAutoGenerated(filePath: string): boolean {
  const content = readFileSync(filePath, "utf-8");
  const header = content.split("\n").slice(0, 20).join("\n");
  return AUTOGEN_BANNER.test(header);
}

// ── Checks ─────────────────────────────────────────────────────────────

const violations: string[] = [];

function fail(check: string, msg: string): void {
  violations.push(`[${check}] ${msg}`);
}

// Check 1: Circular dependencies (DFS)
function checkCircularDeps(packages: PkgInfo[]): void {
  const graph = new Map<string, string[]>();
  for (const pkg of packages) {
    graph.set(pkg.name, pkg.deps);
  }

  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(node: string, path: string[]): void {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      const cycle = path.slice(cycleStart).concat(node);
      fail("circular", `Cycle detected: ${cycle.join(" → ")}`);
      return;
    }
    if (visited.has(node)) return;

    visited.add(node);
    stack.add(node);

    for (const dep of graph.get(node) ?? []) {
      if (graph.has(dep)) {
        dfs(dep, [...path, node]);
      }
    }

    stack.delete(node);
  }

  for (const name of graph.keys()) {
    dfs(name, []);
  }
}

// Check 2: No internal path imports
function checkInternalImports(packages: PkgInfo[]): void {
  // Build map of allowed sub-paths per package
  const allowedSubPaths = new Map<string, Set<string>>();
  for (const pkg of packages) {
    allowedSubPaths.set(pkg.name, getDeclaredSubPaths(pkg.exports));
  }

  for (const pkg of packages) {
    const srcDir = join(pkg.dir, "src");
    if (!existsSync(srcDir)) continue;

    for (const file of collectSourceFiles(srcDir)) {
      for (const imp of extractImports(file)) {
        const subPath = extractSubPath(imp.specifier);
        if (!subPath) continue;

        const targetPkg = extractPkgName(imp.specifier);
        if (!targetPkg) continue;

        // Check if this sub-path is declared in the target's exports
        const allowed = allowedSubPaths.get(targetPkg);
        if (!allowed || !allowed.has(subPath)) {
          const rel = relative(ROOT, file);
          fail(
            "internal-import",
            `${rel}:${imp.line} imports internal path "${imp.specifier}" — ` +
              `only root or declared sub-path exports are allowed`,
          );
        }
      }
    }
  }
}

// Check 3: Layer ordering
function checkLayerOrdering(packages: PkgInfo[]): void {
  for (const pkg of packages) {
    const pkgLayer = LAYER[pkg.name];

    // Apps and services are implicitly the application layer
    const isApp = pkg.dir.includes("/apps/") || pkg.dir.includes("/services/");
    const effectiveLayer = pkgLayer ?? (isApp ? APP_LAYER : undefined);

    if (effectiveLayer === undefined) {
      fail(
        "layer",
        `Package "${pkg.name}" is not registered in the layer map — add it to scripts/check-deps.ts`,
      );
      continue;
    }

    // Production deps must be strictly lower layer.
    // Exception: same-layer re-export deps (sdk re-exports protocol, both Layer 0).
    const SAME_LAYER_PROD_ALLOWED = new Set(["@motebit/sdk->@motebit/protocol"]);
    for (const dep of pkg.deps) {
      const depLayer = LAYER[dep];
      if (depLayer === undefined) continue; // external or unregistered (caught above)
      if (depLayer >= effectiveLayer && effectiveLayer !== APP_LAYER) {
        const pair = `${pkg.name}->${dep}`;
        if (depLayer === effectiveLayer && SAME_LAYER_PROD_ALLOWED.has(pair)) continue;
        fail(
          "layer",
          `"${pkg.name}" (layer ${effectiveLayer}) depends on "${dep}" (layer ${depLayer}) — ` +
            `production dependencies must be in a strictly lower layer`,
        );
      }
    }

    // Dev deps may be same layer or lower (not higher)
    for (const dep of pkg.devDeps) {
      const depLayer = LAYER[dep];
      if (depLayer === undefined) continue;
      if (depLayer > effectiveLayer && effectiveLayer !== APP_LAYER) {
        fail(
          "layer",
          `"${pkg.name}" (layer ${effectiveLayer}) has devDependency on "${dep}" (layer ${depLayer}) — ` +
            `devDependencies must not be in a higher layer`,
        );
      }
    }
  }
}

// Check 4: Export surface
function checkExportSurface(packages: PkgInfo[]): void {
  for (const pkg of packages) {
    // Skip apps and services — they don't export
    if (pkg.dir.includes("/apps/") || pkg.dir.includes("/services/")) continue;

    const srcDir = join(pkg.dir, "src");
    if (!existsSync(srcDir)) continue;

    const indexTs = join(srcDir, "index.ts");
    if (!existsSync(indexTs)) {
      fail(
        "export-surface",
        `"${pkg.name}" has src/ but no src/index.ts — every package must export from src/index.ts`,
      );
    }
  }
}

// Packages that bundle workspace deps via tsup — devDependencies are inlined
// at build time, so importing them in production source is correct.
const BUNDLED_PACKAGES = new Set(["motebit", "create-motebit"]);

// Check 5: Undeclared dependencies
function checkUndeclaredDeps(packages: PkgInfo[]): void {
  for (const pkg of packages) {
    const srcDir = join(pkg.dir, "src");
    if (!existsSync(srcDir)) continue;

    const declaredDeps = new Set([...pkg.deps, ...pkg.devDeps]);
    const prodDeps = new Set(pkg.deps);
    const isBundled = BUNDLED_PACKAGES.has(pkg.name);

    for (const file of collectSourceFiles(srcDir)) {
      // Auto-generated files (e.g. @motebit/self-knowledge's corpus) may
      // contain import-shaped strings inside data — code-fence samples
      // from embedded docs. Skip the undeclared-deps scan for them; the
      // generator owns the file, not a human.
      if (isAutoGenerated(file)) continue;
      for (const imp of extractImports(file)) {
        const depName = extractPkgName(imp.specifier);
        if (!depName) continue;
        if (depName === pkg.name) continue; // self-import

        if (!declaredDeps.has(depName)) {
          const rel = relative(ROOT, file);
          fail(
            "undeclared",
            `${rel}:${imp.line} imports "${depName}" but it is not in ${pkg.name}/package.json dependencies`,
          );
        } else if (!isTestFile(file) && !prodDeps.has(depName)) {
          // Non-test file importing a devDependency
          // Allowed cases:
          //   1. Type-only imports (erased at compile time)
          //   2. Bundled packages (tsup inlines devDeps)
          if (imp.typeOnly || isBundled) continue;

          const rel = relative(ROOT, file);
          fail(
            "undeclared",
            `${rel}:${imp.line} imports "${depName}" which is only a devDependency of ${pkg.name} — ` +
              `move it to dependencies or use "import type" if type-only`,
          );
        }
      }
    }
  }
}

// Check 6: package.json field order for private packages
// Canonical order: name, version, license, private, type, main, types
function checkPackageJsonOrder(packages: PkgInfo[]): void {
  for (const pkg of packages) {
    // Skip apps and services
    if (pkg.dir.includes("/apps/") || pkg.dir.includes("/services/")) continue;

    const pkgPath = join(pkg.dir, "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Only check private packages (published packages have different structure)
    if (!parsed.private) continue;

    const keys = Object.keys(parsed);
    const nameIdx = keys.indexOf("name");
    const versionIdx = keys.indexOf("version");
    const licenseIdx = keys.indexOf("license");
    const privateIdx = keys.indexOf("private");

    if (versionIdx !== -1 && nameIdx !== -1 && nameIdx > versionIdx) {
      fail("pkg-order", `${pkg.name}: "name" must come before "version" in package.json`);
    }
    if (versionIdx !== -1 && licenseIdx !== -1 && licenseIdx < versionIdx) {
      fail("pkg-order", `${pkg.name}: "version" must come before "license" in package.json`);
    }
    if (versionIdx !== -1 && privateIdx !== -1 && privateIdx < versionIdx) {
      fail("pkg-order", `${pkg.name}: "version" must come before "private" in package.json`);
    }

    // Check main/types use ./dist/ prefix
    const main = parsed.main as string | undefined;
    const types = parsed.types as string | undefined;
    if (main && main.startsWith("dist/") && !main.startsWith("./dist/")) {
      fail("pkg-order", `${pkg.name}: "main" should use "./dist/" prefix, got "${main}"`);
    }
    if (types && types.startsWith("dist/") && !types.startsWith("./dist/")) {
      fail("pkg-order", `${pkg.name}: "types" should use "./dist/" prefix, got "${types}"`);
    }
  }
}

// Check 7: tsconfig.json references match production @motebit/* dependencies
function checkTsconfigReferences(packages: PkgInfo[]): void {
  for (const pkg of packages) {
    // Skip apps and services
    if (pkg.dir.includes("/apps/") || pkg.dir.includes("/services/")) continue;

    const tscPath = join(pkg.dir, "tsconfig.json");
    if (!existsSync(tscPath)) continue;

    const tsc = JSON.parse(readFileSync(tscPath, "utf-8")) as Record<string, unknown>;
    const refs = (tsc.references as Array<{ path: string }> | undefined) ?? [];
    const refPaths = new Set(refs.map((r) => r.path.replace("../", "")));

    // Expected: every @motebit/* production dep should have a reference
    const expectedDeps = pkg.deps
      .filter((d) => d.startsWith("@motebit/"))
      .map((d) => d.replace("@motebit/", ""));

    for (const dep of expectedDeps) {
      if (!refPaths.has(dep)) {
        fail(
          "tsconfig-refs",
          `${pkg.name}: tsconfig.json missing reference for production dep "@motebit/${dep}"`,
        );
      }
    }

    // No extra references that aren't production deps
    for (const ref of refPaths) {
      if (!expectedDeps.includes(ref)) {
        fail(
          "tsconfig-refs",
          `${pkg.name}: tsconfig.json has reference "../${ref}" but "@motebit/${ref}" is not a production dependency`,
        );
      }
    }

    // Packages with no @motebit/* deps should have no references
    if (expectedDeps.length === 0 && refs.length > 0) {
      fail(
        "tsconfig-refs",
        `${pkg.name}: tsconfig.json has references but no @motebit/* production dependencies`,
      );
    }
  }
}

// Check 8: No license text in source file headers
function checkNoLicenseInSource(packages: PkgInfo[]): void {
  const licensePattern = /\bBSL[-\s]1\.1\b|\bMIT\s+licens/i;

  for (const pkg of packages) {
    const srcDir = join(pkg.dir, "src");
    if (!existsSync(srcDir)) continue;

    for (const file of collectSourceFiles(srcDir)) {
      if (isTestFile(file)) continue;
      if (isAutoGenerated(file)) continue;
      const content = readFileSync(file, "utf-8");
      // Only check the first 20 lines (file header)
      const header = content.split("\n").slice(0, 20).join("\n");
      if (licensePattern.test(header)) {
        const rel = relative(ROOT, file);
        fail(
          "license-in-source",
          `${rel}: license text in source header — license belongs in package.json, not code`,
        );
      }
    }
  }
}

// Check 9: MIT purity — MIT packages must not import from BSL packages
function checkMitPurity(packages: PkgInfo[]): void {
  for (const pkg of packages) {
    if (!MIT_PACKAGES.has(pkg.name)) continue;

    const srcDir = join(pkg.dir, "src");
    if (!existsSync(srcDir)) continue;

    for (const file of collectSourceFiles(srcDir)) {
      if (isTestFile(file)) continue; // tests can import anything
      for (const imp of extractImports(file)) {
        const depName = extractPkgName(imp.specifier);
        if (!depName) continue;
        if (depName === pkg.name) continue; // self-import
        if (imp.typeOnly) continue; // type-only imports are erased at compile time

        if (!MIT_IMPORT_ALLOWED.has(depName)) {
          const rel = relative(ROOT, file);
          fail(
            "mit-purity",
            `${rel}:${imp.line} — MIT package "${pkg.name}" imports BSL package "${depName}". ` +
              `MIT packages must only import from other MIT packages (or use "import type").`,
          );
        }
      }
    }
  }
}

// Check 10: MIT export surface — MIT packages must not export unapproved functions
function checkMitExportSurface(packages: PkgInfo[]): void {
  // Check packages that publish typed exports. create-motebit is excluded (bin-only, no library API).
  const CHECKED_MIT = ["@motebit/protocol", "@motebit/sdk", "@motebit/crypto"];

  for (const pkg of packages) {
    if (!CHECKED_MIT.includes(pkg.name)) continue;

    const indexPath = join(pkg.dir, "src", "index.ts");
    if (!existsSync(indexPath)) continue;
    const content = readFileSync(indexPath, "utf-8");
    const lines = content.split("\n");

    const allowed = MIT_ALLOWED_FUNCTIONS[pkg.name] ?? new Set<string>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;

      // Match "export function NAME" or "export async function NAME"
      const fnMatch = /^export\s+(?:async\s+)?function\s+(\w+)/.exec(line);
      if (fnMatch) {
        const fnName = fnMatch[1]!;
        if (!allowed.has(fnName)) {
          fail(
            "mit-export",
            `${pkg.name} src/index.ts:${i + 1} exports function "${fnName}" — ` +
              `MIT packages must export only types, enums, and allowlisted utilities. ` +
              `Move this function to a BSL package or add it to MIT_ALLOWED_FUNCTIONS in check-deps.ts.`,
          );
        }
      }

      // Match re-exported non-type names: export { a, b, c } from "..."
      // Skip lines with "export type {" — those are type-only re-exports
      if (/^export\s+type\s/.test(line)) continue;
      const reExportMatch = /^export\s*\{([^}]+)\}\s*from\s/.exec(line);
      if (reExportMatch) {
        const names = reExportMatch[1]!.split(",").map((n) =>
          n
            .trim()
            .split(/\s+as\s+/)
            .pop()!
            .trim(),
        );
        for (const name of names) {
          if (!name || /^[A-Z]/.test(name)) continue; // Skip types/classes/enums (PascalCase)
          if (!allowed.has(name)) {
            fail(
              "mit-export",
              `${pkg.name} src/index.ts:${i + 1} re-exports function "${name}" — ` +
                `MIT packages must export only types, enums, and allowlisted utilities. ` +
                `Add to MIT_ALLOWED_FUNCTIONS in check-deps.ts if intentional.`,
            );
          }
        }
      }
    }
  }
}

// Check for wildcard exports (warnings, not errors)
function warnWildcardExports(packages: PkgInfo[]): void {
  for (const pkg of packages) {
    if (!pkg.exports) continue;
    for (const key of Object.keys(pkg.exports)) {
      if (key.includes("*")) {
        console.warn(
          `  WARN: "${pkg.name}" declares wildcard export "${key}" — ` +
            `this undermines boundary enforcement. Use explicit sub-path exports instead.`,
        );
      }
    }
  }
}

// ── Main ───────────────────────────────────────────────────────────────

console.log("Checking architectural dependencies...\n");

const packages = discoverPackages();
console.log(`  Found ${packages.length} workspace packages\n`);

warnWildcardExports(packages);

checkCircularDeps(packages);
checkInternalImports(packages);
checkLayerOrdering(packages);
checkExportSurface(packages);
checkUndeclaredDeps(packages);
checkPackageJsonOrder(packages);
checkTsconfigReferences(packages);
checkNoLicenseInSource(packages);
checkMitPurity(packages);
checkMitExportSurface(packages);

if (violations.length === 0) {
  console.log("\n  All architectural checks passed.\n");
  process.exit(0);
} else {
  console.error(`\n  ${violations.length} violation(s) found:\n`);
  for (const v of violations) {
    console.error(`  ERROR ${v}`);
  }
  console.error("");
  process.exit(1);
}
