/**
 * Gate effectiveness probe — every registered gate must actually fire.
 *
 * The drift-defense system has a subtle failure mode: a check script can sit
 * in `GATES` (scripts/check.ts), run during CI, exit 0 on every run, and
 * appear green — yet check nothing. That happened with `check-memory`, which
 * always exits 0 by design and silently no-ops on CI runners where its
 * user-local target path doesn't exist. Category error: advisory tool in a
 * hard-gate slot.
 *
 * Registry completeness (accounted for or not) doesn't catch this — a
 * misrouted entry looks identical to a correct one. The invariant we need
 * is stronger: *when the invariant a gate claims to defend is violated,
 * the gate must exit non-zero*.
 *
 * This probe runs each gate against a deliberately-broken fixture and
 * asserts it fails with a non-zero exit code. If a gate doesn't fail
 * under a known-bad input, it isn't a gate — it's decoration.
 *
 * ── How probes work ─────────────────────────────────────────────────────
 *
 * Each probe declares a `perturb()` function that:
 *   1. Writes a small known-violating fixture file into the repo.
 *   2. Returns a cleanup function that reverts the perturbation.
 *
 * The probe runner:
 *   1. Applies the perturbation.
 *   2. Runs the gate via `pnpm <script>`.
 *   3. Asserts the gate exited non-zero.
 *   4. Calls cleanup.
 *
 * Cleanup also runs on process exit / signal, so an interrupted probe
 * doesn't leave fixture files behind.
 *
 * ── Adding a new gate ───────────────────────────────────────────────────
 *
 * Add an entry to PROBES with a perturbation that is minimal, distinctive,
 * and reversible. Prefer creating a single fixture file with a clearly-
 * invalid shape over mutating existing code — fixtures are easier to clean
 * up and leave a cleaner git diff if anything goes wrong.
 */

import { spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/** Distinctive prefix — any stray fixture file is easy to find and remove. */
const PROBE_PREFIX = "__gate_probe__";

interface Probe {
  /** Matches the `script` field of an entry in scripts/check.ts GATES. */
  script: string;
  /**
   * Extra args to forward. Must match the GATES entry's `args` so the probe
   * runs the gate in the same mode CI does (e.g. check-specs --strict).
   */
  args?: string[];
  /** What invariant this probe proves the gate enforces. */
  proves: string;
  /** Apply a violation; return a cleanup function that reverts it. */
  perturb: () => () => void;
  /**
   * Predicate: `true` means "the probe's gate has an escape hatch that is
   * currently active, so running the probe would test the escape rather than
   * the detection." When it returns `true`, the probe is skipped with an
   * explicit note — the caller sees `⚠ skipped (escape hatch active)` rather
   * than a silent pass. Used for check-api-surface during a pass where every
   * published package has a pending `major` changeset (the gate's intended
   * design: major changesets authorize API breaks).
   */
  skipWhen?: () => { skip: boolean; reason: string };
}

/**
 * Write a fixture file and return a cleanup that removes it. If the file
 * already exists (unlikely — prefix guards against this), refuse to
 * clobber.
 */
function writeFixture(relativePath: string, content: string): () => void {
  const absolute = resolve(ROOT, relativePath);
  if (existsSync(absolute)) {
    throw new Error(
      `probe refused to clobber existing file: ${relativePath}. Is a prior probe not cleaned up?`,
    );
  }
  writeFileSync(absolute, content);
  return () => {
    if (existsSync(absolute)) unlinkSync(absolute);
  };
}

/**
 * Mutate an existing file and return a cleanup that restores the original
 * content. Used when a probe must modify a real config file (e.g. package.json)
 * rather than create a new file.
 */
function mutateFile(relativePath: string, mutate: (src: string) => string): () => void {
  const absolute = resolve(ROOT, relativePath);
  const original = readFileSync(absolute, "utf-8");
  writeFileSync(absolute, mutate(original));
  return () => writeFileSync(absolute, original);
}

const PROBES: ReadonlyArray<Probe> = [
  {
    script: "check-service-primitives",
    proves: "flags a forbidden @motebit/encryption import inside a service",
    perturb: () =>
      writeFixture(
        `services/code-review/src/${PROBE_PREFIX}forbidden_import.ts`,
        // A forbidden package import. The gate scans service src/ recursively
        // and treats any non-test file's @motebit/encryption import as a
        // violation.
        `import { verifySignedToken } from "@motebit/encryption";\nvoid verifySignedToken;\n`,
      ),
  },
  {
    script: "check-app-primitives",
    proves: "flags a forbidden @motebit/protocol import inside an app",
    perturb: () =>
      writeFixture(
        `apps/admin/src/${PROBE_PREFIX}forbidden_import.ts`,
        // Apps must consume the product vocabulary (@motebit/sdk), not the
        // protocol primitive directly.
        `import type { MotebitId } from "@motebit/protocol";\nexport type _Probe = MotebitId;\n`,
      ),
  },
  {
    script: "check-affordance-routing",
    proves:
      "flags a UI handler that routes a capability-named prompt through handleSend (surface-determinism anti-pattern)",
    perturb: () =>
      writeFixture(
        `apps/web/src/ui/${PROBE_PREFIX}affordance_violation.ts`,
        // The gate forbids constructing a capability-naming prompt and
        // routing it through the AI loop. A surface affordance must call
        // `invokeCapability(name, args)` directly — see
        // `docs/doctrine/surface-determinism.md`.
        [
          `declare function handleSend(text: string): void;`,
          `export function onClick(url: string): void {`,
          `  handleSend(\`Delegate this review to a remote agent (required_capabilities: ["review_pr"]). PR: \${url}\`);`,
          `}`,
          ``,
        ].join("\n"),
      ),
  },
  {
    script: "check-deploy-parity",
    proves: "flags an env var in .env.example that no source reads",
    perturb: () =>
      mutateFile(
        "services/code-review/.env.example",
        // Append an obviously-unused env var. The gate's env-name regex is
        // /^[A-Z][A-Z0-9_]*\s*=/ (conventional shell env vars) — so the name
        // MUST start with a capital letter or the line is ignored entirely,
        // which means no "stale declared var" violation would fire.
        // Distinctive middle-token for easy grep-and-grep-out if something
        // goes wrong.
        (src) => `${src}\nGATE_PROBE_UNUSED_VAR=never_read\n`,
      ),
  },
  {
    script: "check-deps",
    proves: "flags tsconfig references out of sync with package.json deps",
    perturb: () =>
      mutateFile(
        "packages/mcp-server/tsconfig.json",
        // Drop the @motebit/sdk tsconfig reference while keeping the
        // dependency in package.json. check-deps' "tsconfig references must
        // match production deps" rule should fire.
        (src) => src.replace(/\{\s*"path":\s*"\.\.\/sdk"\s*\},?\s*/, ""),
      ),
  },
  {
    script: "check-specs",
    // --strict flips check-specs from advisory to hard-fail. This must match
    // the `args` in the corresponding GATES entry (scripts/check.ts) — probe
    // and CI must run the gate in the same mode, or we're proving the wrong
    // thing. The category error we're defending against is: a soft-exit-0
    // script sitting in GATES pretending to be a gate.
    args: ["--strict"],
    proves: "flags a spec file that has zero implementation references (under --strict)",
    perturb: () =>
      writeFixture(
        `spec/${PROBE_PREFIX}orphan-v1.md`,
        // A spec file with a plausible schema identifier but no matching
        // implementation references anywhere in the tree.
        `# motebit/${PROBE_PREFIX}orphan@1.0\n\nOrphan spec — no implementation references.\n`,
      ),
  },
  {
    script: "check-changeset-discipline",
    proves: "flags a `major` changeset that lacks a non-empty ## Migration section",
    perturb: () =>
      writeFixture(
        // The gate reads .changeset/*.md, skipping README.md and CHANGELOG.md
        // only — our prefixed fixture is picked up like any pending changeset.
        `.changeset/${PROBE_PREFIX}major-no-migration.md`,
        // Frontmatter declares a `major` bump on a tracked published package.
        // Body contains nothing that looks like a ## Migration section, so the
        // gate's "every major must teach upgraders" invariant is violated.
        `---\n"@motebit/protocol": major\n---\n\nProbe-only major bump with no migration guide.\n`,
      ),
  },
  {
    script: "check-spec-coverage",
    // --strict is the gate's production mode (scripts/check.ts GATES). Probe
    // must match or we'd be proving the wrong mode.
    args: ["--strict"],
    proves:
      "flags a spec whose Wire format block names a type that @motebit/protocol does not export",
    perturb: () =>
      writeFixture(
        // A fixture spec with a `#### Wire format (foundation law)` block under
        // a `### X.Y — TypeName` heading whose identifier (`ProbeOnlyNonExported`)
        // does not appear in packages/protocol. The probe relies on the gate's
        // regex: the section heading declares the type; check-spec-coverage
        // asserts the protocol package exports it.
        `spec/${PROBE_PREFIX}coverage-v1.md`,
        `# motebit/${PROBE_PREFIX}coverage@1.0

## 1. ProbeArtifact

### 1.1 — ProbeOnlyNonExportedSymbol

#### Wire format (foundation law)

Probe-only artifact — \`ProbeOnlyNonExportedSymbol\` is not exported from \`@motebit/protocol\` by design so \`check-spec-coverage\` fails on this file.
`,
      ),
  },
  {
    script: "check-spec-wire-schemas",
    proves:
      "flags a spec wire-format type that has no matching <TypeName>Schema export from @motebit/wire-schemas (and no entry in WAIVERS)",
    perturb: () =>
      writeFixture(
        // Fixture spec with a `#### Wire format (foundation law)` block that
        // declares a type name (`ProbeOnlyUnschematizedType`) which has no
        // matching `ProbeOnlyUnschematizedTypeSchema` export in
        // @motebit/wire-schemas and no entry in the WAIVERS table.
        // check-spec-wire-schemas extracts the type name via the section
        // heading regex and asserts the schema-or-waiver pairing — the gate
        // fails because neither side exists.
        `spec/${PROBE_PREFIX}wire-schemas-v1.md`,
        `# motebit/${PROBE_PREFIX}wire-schemas@1.0

## 1. ProbeArtifact

### 1.1 — ProbeOnlyUnschematizedType

#### Wire format (foundation law)

Probe-only artifact — \`ProbeOnlyUnschematizedType\` has no matching schema in \`@motebit/wire-schemas\` and no entry in the gate's WAIVERS table by design, so \`check-spec-wire-schemas\` fails on this file.
`,
      ),
  },
  {
    script: "check-suite-declared",
    proves: "flags a Wire format block that declares `signature` but no `suite` field",
    perturb: () =>
      writeFixture(
        // A signed wire-format artifact in pseudo-TypeScript inside a code
        // block — the gate detects `signature` / `suite` field declarations in
        // both markdown tables and code blocks. By declaring `signature`
        // without `suite`, the gate's invariant-#11 rule fires.
        `spec/${PROBE_PREFIX}suite-declared-v1.md`,
        `# motebit/${PROBE_PREFIX}suite-declared@1.0

## 1. ProbeArtifact

#### Wire format (foundation law)

\`\`\`
ProbeArtifact {
  probe_id:   string      // arbitrary
  signature:  string      // signed but no suite — drift gate should catch this
}
\`\`\`
`,
      ),
  },
  {
    script: "check-suite-dispatch",
    proves:
      "flags a direct @noble/ed25519 primitive call outside packages/crypto/src/suite-dispatch.ts (scope: packages/crypto/src/, services/, apps/)",
    perturb: () =>
      writeFixture(
        // Any .ts under packages/crypto/src/ (outside suite-dispatch.ts) that
        // contains the forbidden pattern `ed.verifyAsync` is a violation.
        // Use a non-top-level directory so it's picked up by the recursive
        // walk — `scan-dir/__probe.ts` would also work, but a top-level file
        // mirrors the way a real drift would appear in code review.
        `packages/crypto/src/${PROBE_PREFIX}primitive-leak.ts`,
        `// Probe-only file that leaks a primitive verify call.
// If check-suite-dispatch is working, it refuses to accept this file.
declare const ed: { verifyAsync(a: Uint8Array, b: Uint8Array, c: Uint8Array): Promise<boolean> };
declare const sig: Uint8Array;
declare const msg: Uint8Array;
declare const pub: Uint8Array;
export async function probeLeak(): Promise<boolean> {
  return ed.verifyAsync(sig, msg, pub);
}
`,
      ),
  },
  {
    script: "check-dist-smoke",
    proves:
      "flags a dist binary that fails to boot (bundling regression class: CJS-in-ESM, missing exports subpath, wrong runtime dep version)",
    perturb: () =>
      // Swap the CLI's real dist entry with a known-crashing one.
      // `process.exit(2)` is deterministic and distinct from the
      // accepted exit code (0) — the gate should flag exit 2 as a
      // non-match and fail. Cleanup restores the original dist on the
      // next tick so subsequent probes and tests see the real binary.
      mutateFile(
        "apps/cli/dist/index.js",
        () =>
          `#!/usr/bin/env node\nconsole.error("${PROBE_PREFIX}intentional crash for dist-smoke probe");\nprocess.exit(2);\n`,
      ),
  },
  {
    script: "check-api-surface",
    // Requires packages/{protocol,crypto,sdk}/dist to exist so api-extractor
    // can read the .d.ts and produce etc/temp/*.api.md to diff against the
    // (mutated) baseline. Pre-push and the CI gate-effectiveness job run
    // `pnpm build` before this probe for exactly that reason — without dist/,
    // api-extractor errors on missing input and the probe would "pass" for
    // the wrong reason (non-zero exit without actually proving drift
    // detection).
    proves: "flags a committed baseline that diverges from the extracted API surface",
    perturb: () =>
      mutateFile(
        // Mutating the baseline (not the source) gives us a deterministic
        // divergence without a rebuild: dist/ is unchanged, so extractor
        // produces the current surface in etc/temp/, which now differs from
        // the doctored baseline. Assumes no pending `major` changeset for
        // @motebit/protocol — otherwise the gate would accept the diff as
        // declared-breaking and exit 0 (see check-api-surface.ts escape
        // hatch). If a real major is ever pending while this probe runs,
        // we skip the probe (see skipWhen below) rather than test the wrong
        // thing; returning ok=true on a skipped probe would be a false
        // positive ("gate is effective" when we proved nothing).
        "packages/protocol/etc/protocol.api.md",
        (src) => `// ${PROBE_PREFIX}injected drift marker\n${src}`,
      ),
    skipWhen: () => scanChangesetsForMajor("@motebit/protocol"),
  },
  {
    script: "check-docs-tree",
    proves:
      "flags an architecture.mdx package whose [Ln] layer tag diverges from scripts/check-deps.ts LAYER map",
    perturb: () =>
      // Mutate the `protocol` row's layer tag from [L0 · MIT] to [L3 · MIT].
      // check-deps.ts pins @motebit/protocol at L0; the probe makes the tree
      // lie about the layer. The gate should emit
      // "protocol tagged L3 but check-deps.ts says L0" and exit 1. A layer
      // swap beats a package rename here — no filesystem entries invented,
      // no cross-section side effects, cleanup restores byte-identical.
      mutateFile("apps/docs/content/docs/operator/architecture.mdx", (src) =>
        src.replace(
          "├── protocol/              [L0 · MIT]",
          "├── protocol/              [L3 · MIT]",
        ),
      ),
  },
  {
    script: "check-spec-mit-boundary",
    proves:
      "flags a backticked callable in spec/*.md whose identifier is not exported from an MIT package and not explicitly waived",
    perturb: () =>
      // Drop a fake camelCase callable reference into an existing spec. The
      // probe scans backticked `fooBar(...)` patterns, skips snake_case and
      // all-lowercase (SQL DDL + math notation), then asserts each remaining
      // identifier is either MIT-exported or listed in WAIVED_CALLABLES. A
      // novel camelCase name like `probeOnlyBslSymbol` satisfies neither and
      // should flip the gate to exit 1 with a specific diagnostic.
      writeFixture(
        `spec/${PROBE_PREFIX}bsl-leak-v1.md`,
        // Minimal spec-shaped fixture. The gate reads spec/*.md — any .md
        // file here is in scope. Body mentions a callable that only BSL
        // could plausibly own, and that no current spec has waived.
        `# motebit/${PROBE_PREFIX}bsl-leak@1.0\n\n` +
          `Probe-only spec. The call \`probeOnlyBslSymbol(arg)\` must trip check-spec-mit-boundary.\n`,
      ),
  },
  {
    script: "check-privacy-ring",
    proves:
      "flags a surface app whose package.json drops one of the Ring 2 privacy-substrate packages (@motebit/event-log or @motebit/privacy-layer)",
    perturb: () =>
      // Remove `@motebit/event-log` from apps/web/package.json. The gate scans
      // each surface's deps + devDeps and asserts both Ring 2 packages are
      // declared; dropping one should emit a "missing-dep" finding and exit 1.
      // Web is the probe target — a fresh declaration hygienically matches the
      // other four surfaces. mutateFile restores byte-identical on cleanup.
      mutateFile("apps/web/package.json", (src) =>
        src.replace(/\s+"@motebit\/event-log":\s*"workspace:\*",/, ""),
      ),
  },
  {
    script: "check-readme",
    proves:
      "flags a README 'What you see:' block claim that disagrees with create-motebit / runtime-factory source-of-truth (here: the relay URL ↔ DEFAULT_SYNC_URL pin)",
    perturb: () =>
      // Replace the README's `Registered with relay:` value with an obviously
      // invalid URL. The gate's claim-4 assertion compares this line against
      // `DEFAULT_SYNC_URL` in apps/cli/src/runtime-factory.ts — under the
      // perturbation, the two disagree and the gate fires. Distinctive
      // `.invalid` TLD makes the perturbation trivially safe to grep-and-
      // revert if cleanup ever fails.
      mutateFile("README.md", (src) =>
        src.replace(
          /^Registered with relay:\s+\S+/m,
          "Registered with relay: https://probe-only-wrong-relay.invalid",
        ),
      ),
  },
  {
    script: "check-claude-md",
    proves:
      "flags a sub-CLAUDE.md file that exists on disk but is not referenced from root CLAUDE.md's per-directory doctrine index",
    perturb: () =>
      // Strip the `packages/protocol/CLAUDE.md` line out of root CLAUDE.md's
      // "Per-directory doctrine loads lazily" index. The file still exists on
      // disk; the index entry is gone. Direction 1 of the gate (every disk
      // CLAUDE.md must be referenced from root) should fire on the now-orphan
      // sub-doctrine. mutateFile restores byte-identical on cleanup.
      mutateFile("CLAUDE.md", (src) =>
        src.replace(/^- \[`packages\/protocol\/CLAUDE\.md`\][^\n]*\n/m, ""),
      ),
  },
  {
    script: "check-scene-primitives",
    proves:
      "flags an inline scene primitive in an app — imports `three` AND registers a SpatialExpression kind outside @motebit/render-engine",
    perturb: () =>
      // The gate's two-condition heuristic: a file under apps/*/src/ that
      // both imports `three` AND calls registerSpatialDataModule is an
      // inline scene primitive and should have moved to render-engine.
      // This fixture satisfies both conditions.
      writeFixture(
        `apps/web/src/${PROBE_PREFIX}inline_scene_primitive.ts`,
        `import * as THREE from "three";\nimport { registerSpatialDataModule } from "@motebit/render-engine";\nconst _probe = new THREE.Group();\nvoid _probe;\nregisterSpatialDataModule({ kind: "satellite", name: "__probe__" });\n`,
      ),
  },
  {
    script: "check-retrieval-primitives",
    proves:
      "flags inline retrieval scoring — similarity + confidence + sort in one file outside @motebit/memory-graph",
    perturb: () =>
      // Three-predicate heuristic: similarity, confidence, sort/rerank
      // all present. This fixture reinvents memory ranking inline — the
      // exact drift the gate exists to catch.
      writeFixture(
        `apps/web/src/${PROBE_PREFIX}inline_retrieval_scoring.ts`,
        `interface Node { similarity: number; confidence: number }\nexport function rankInline(nodes: Node[]): Node[] {\n  return nodes\n    .map((n) => ({ ...n, score: n.similarity * 0.6 + n.confidence * 0.4 }))\n    .sort((a, b) => b.score - a.score);\n}\n`,
      ),
  },
  {
    script: "check-reputation-primitives",
    proves:
      "flags inline reputation scoring — Math.exp(-…) decay + interaction_count/volumeScore without importing the canonical computeReputationScore",
    perturb: () =>
      // Fixture matches the three-condition heuristic: decay signature +
      // volume sub-score + no canonical import. Exactly the shape
      // apps/admin/TrustPanel had before the fix that precipitated this
      // gate.
      writeFixture(
        `apps/web/src/${PROBE_PREFIX}inline_reputation.ts`,
        `export function reputationProbe(r: { interaction_count: number; last_seen_at: number }): number {\n  const volumeScore = Math.min(r.interaction_count / 50, 1.0);\n  const recency = Math.exp(-(Date.now() - r.last_seen_at) / 1000);\n  return (volumeScore + recency) / 2;\n}\n`,
      ),
  },
  {
    script: "check-notability-primitives",
    proves:
      "flags inline notability scoring — computeDecayedConfidence + two-of-{edgeCount, isolated, orphan, ConflictsWith} without importing the canonical rankNotableMemories",
    perturb: () =>
      // Fixture matches the heuristic: decay-math + two isolation signals
      // + no canonical import. Exactly the shape the reflection engine's
      // buildAuditSummary carried before the notability primitive landed.
      writeFixture(
        `apps/web/src/${PROBE_PREFIX}inline_notability.ts`,
        `import { computeDecayedConfidence } from "@motebit/memory-graph";\nimport type { MemoryNode, MemoryEdge } from "@motebit/sdk";\nimport { RelationType } from "@motebit/sdk";\nexport function notabilityProbe(node: MemoryNode, edges: MemoryEdge[]): number {\n  const edgeCount = edges.filter((e) => e.source_id === node.node_id).length;\n  const isolated = edgeCount === 0;\n  const hasConflict = edges.some((e) => e.relation_type === RelationType.ConflictsWith);\n  const decayed = computeDecayedConfidence(node.confidence, node.half_life, Date.now() - node.created_at);\n  return (isolated ? decayed : 0) + (hasConflict ? decayed : 0);\n}\n`,
      ),
  },
  {
    script: "check-trust-propagation-primitives",
    proves:
      "flags inline trust propagation — credential-vocabulary + issuerTrust × weight aggregation over a loop of credentials without importing the canonical propagateTrust",
    perturb: () =>
      // Fixture matches the three-condition heuristic: credential-graph
      // vocabulary (≥2 of credentialSubject/issuer/VC_TYPE_REPUTATION/did:key),
      // getIssuerTrust × weight in an aggregation loop, and no canonical
      // import. This is the shape a caller would write if they tried to
      // implement multi-hop trust lookup themselves instead of asking
      // the market package for it.
      writeFixture(
        `apps/web/src/${PROBE_PREFIX}inline_trust_propagation.ts`,
        `interface Cred { issuer: string; credentialSubject: { id: string; success_rate: number } }\nexport function aggregate(credentials: Cred[], getIssuerTrust: (did: string) => number): Map<string, number> {\n  const out = new Map<string, number>();\n  for (const vc of credentials) {\n    const issuerTrust = getIssuerTrust(vc.issuer);\n    const weight = vc.credentialSubject.success_rate;\n    const score = issuerTrust * weight;\n    const prev = out.get(vc.credentialSubject.id) ?? 0;\n    if (score > prev) out.set(vc.credentialSubject.id, score);\n  }\n  return out;\n}\n`,
      ),
  },
  {
    script: "check-spec-impl-coverage",
    proves:
      "flags a new Stable spec that no package declares via motebit.implements (uncovered-spec violation)",
    perturb: () =>
      // Fixture: a minimally-valid Stable spec that no package has
      // declared in its motebit.implements array. The gate's second
      // invariant (every Stable spec has ≥1 declarer) should fire.
      writeFixture(
        `spec/${PROBE_PREFIX}uncovered-v1.md`,
        `# motebit/probe-uncovered@1.0\n\n**Status:** Stable  \n**Version:** 1.0\n\nProbe fixture for check-spec-impl-coverage — intentionally uncovered.\n`,
      ),
  },
  {
    script: "check-disambiguation-primitives",
    proves:
      "flags an inline `.find(c => c.title.toLowerCase().includes(keyword))` referent pick without importing matchOrAsk",
    perturb: () =>
      // Fixture matches the ADHOC_PICK signature: a find-based lookup
      // using .toLowerCase() + .includes() against a title field. This
      // is the exact shape voice-commands.ts carried before the
      // disambiguation primitive landed.
      writeFixture(
        `apps/web/src/${PROBE_PREFIX}inline_disambiguation.ts`,
        `interface Conv { id: string; title: string }\nexport function pick(convs: Conv[], keyword: string): Conv | undefined {\n  return convs.find((c) => c.title.toLowerCase().includes(keyword.toLowerCase()));\n}\n`,
      ),
  },
  {
    script: "check-panel-controllers",
    proves:
      "flags a sovereign-panel surface file that fetches relay endpoints directly without importing @motebit/panels",
    perturb: () =>
      // Fixture: a file under apps/web/src/ui/ with `sovereign` in its name
      // that touches a relay sovereign endpoint but has zero @motebit/panels
      // import. This is precisely the drift the gate exists to prevent —
      // someone re-implementing the credential-fetch path inline after the
      // controller extraction.
      writeFixture(
        `apps/web/src/ui/${PROBE_PREFIX}sovereign-rogue.ts`,
        `// Probe-only file — reimplements the sovereign fetch path inline.
export async function fetchCredsInline(id: string): Promise<unknown> {
  const res = await fetch(\`https://relay.test/api/v1/agents/\${id}/credentials\`);
  return res.json();
}
`,
      ),
  },
  {
    script: "check-wire-schema-usage",
    proves:
      "flags a manifest-listed inbound wire handler that drops its wire-schemas import — mutates services/api/src/agents.ts to remove the @motebit/wire-schemas import statement, which Rule B (manifest-missing-import) catches",
    perturb: () =>
      // Strip the @motebit/wire-schemas import line(s) from agents.ts.
      // The gate's manifest requires ExecutionReceiptSchema in agents.ts;
      // removing the import means the file no longer satisfies the
      // requirement and Rule B fires. Rule A would also fire if a call
      // remained without an import, but Rule B is the doctrine-load-bearing
      // rule (it catches handlers that bypass the schema entirely).
      mutateFile("services/api/src/agents.ts", (src) =>
        src.replace(
          /import\s*\{[^}]*\}\s*from\s*["']@motebit\/wire-schemas["'];?\n/g,
          "/* check-gates-effective probe — wire-schemas import removed */\n",
        ),
      ),
  },
  {
    script: "check-consolidation-primitives",
    proves:
      "flags inline consolidation cycle — clusterBySimilarity + LLM summarization + formMemory + deleteMemory in one file without importing the canonical runConsolidationCycle",
    perturb: () =>
      // Fixture matches the four-condition heuristic: clusterBySimilarity
      // call + summariz keyword + formMemory + deleteMemory. This is the
      // exact shape that diverged into housekeeping.ts vs the reflection
      // engine before the cycle unification — the gate exists so the third
      // copy can never land.
      writeFixture(
        `apps/web/src/${PROBE_PREFIX}inline_consolidation.ts`,
        `import { clusterBySimilarity } from "@motebit/memory-graph";\nimport type { MemoryNode } from "@motebit/sdk";\nexport async function rogueConsolidate(\n  nodes: MemoryNode[],\n  memory: { formMemory: (...a: unknown[]) => Promise<unknown>; deleteMemory: (id: string) => Promise<void> },\n): Promise<void> {\n  const clusters = clusterBySimilarity(nodes, 0.6);\n  for (const cluster of clusters) {\n    if (cluster.length < 2) continue;\n    // pretend to summarize via an LLM here\n    const summary = "summarize: " + cluster.map((n) => n.content).join(" / ");\n    await memory.formMemory({ content: summary }, [], 0);\n    for (const n of cluster) await memory.deleteMemory(n.node_id);\n  }\n}\n`,
      ),
  },
  {
    script: "check-tool-modes",
    proves:
      "flags a ToolDefinition literal in packages/tools/src/builtins that lacks the `mode:` field — writing a fixture file with a complete definition minus the mode tag must trip the gate",
    perturb: () =>
      // Fixture: a ToolDefinition literal without a `mode` field. This
      // is the exact shape the gate exists to prevent — a new builtin
      // shipping without a cost-tier tag, which would sort to the
      // bottom of the registry and silently nullify the hybrid-engine
      // preference.
      writeFixture(
        `packages/tools/src/builtins/${PROBE_PREFIX}untagged_tool.ts`,
        `import type { ToolDefinition } from "@motebit/sdk";\nexport const untaggedProbeDefinition: ToolDefinition = {\n  name: "untagged_probe",\n  description: "Probe fixture — intentionally missing mode tag.",\n  inputSchema: { type: "object", properties: {} },\n};\n`,
      ),
  },
];

/**
 * Return `{ skip: true, reason }` if a pending changeset declares a `major`
 * bump on `pkgName`. The caller uses this to skip probes whose gate has a
 * documented escape hatch keyed to pending majors (e.g. check-api-surface).
 */
function scanChangesetsForMajor(pkgName: string): { skip: boolean; reason: string } {
  const dir = resolve(ROOT, ".changeset");
  if (!existsSync(dir)) return { skip: false, reason: "" };
  const entries = readdirSync(dir).filter(
    (f) => f.endsWith(".md") && f !== "README.md" && f !== "CHANGELOG.md",
  );
  for (const name of entries) {
    const body = readFileSync(resolve(dir, name), "utf-8");
    const front = body.match(/^---\n([\s\S]*?)\n---/);
    if (!front) continue;
    const line = new RegExp(`^"${pkgName.replace("/", "/")}":\\s*major\\s*$`, "m");
    if (line.test(front[1]!)) {
      return {
        skip: true,
        reason: `pending \`major\` changeset for ${pkgName} activates the gate's escape hatch — probe would test the escape, not the detection`,
      };
    }
  }
  return { skip: false, reason: "" };
}

interface ProbeResult {
  probe: Probe;
  gateExitCode: number | null;
  ok: boolean;
  error?: string;
  skipped?: { reason: string };
}

function runProbe(probe: Probe): ProbeResult {
  // Escape-hatch check — run before perturbation so we don't touch the tree
  // for a probe we're going to skip.
  if (probe.skipWhen) {
    const decision = probe.skipWhen();
    if (decision.skip) {
      return { probe, gateExitCode: null, ok: true, skipped: { reason: decision.reason } };
    }
  }

  let cleanup: (() => void) | null = null;
  try {
    cleanup = probe.perturb();

    const result = spawnSync("pnpm", ["--silent", "run", probe.script], {
      stdio: "pipe",
      encoding: "utf-8",
    });

    const gateExitCode = result.status;
    // A gate that "works" MUST exit non-zero when given a known violation.
    // Zero = the gate didn't catch the injected drift = the gate is
    // decoration, not defense.
    const ok = gateExitCode !== null && gateExitCode !== 0;

    return { probe, gateExitCode, ok };
  } catch (err) {
    return {
      probe,
      gateExitCode: null,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (cleanup) {
      try {
        cleanup();
      } catch (err) {
        console.error(`  cleanup failed for ${probe.script}: ${String(err)}`);
      }
    }
  }
}

/**
 * Assert every entry in scripts/check.ts's GATES list has a matching probe.
 * The drift this defends against: someone adds a new gate to GATES but
 * forgets to add a probe here — the new gate would be accepted into CI
 * without any proof it actually fires.
 */
function assertProbeCoverage(): void {
  const checkTs = readFileSync(resolve(ROOT, "scripts/check.ts"), "utf-8");
  const gateScripts = new Set(
    [...checkTs.matchAll(/script:\s*["']([a-z0-9-]+)["']/g)].map((m) => m[1]),
  );
  const probedScripts = new Set(PROBES.map((p) => p.script));

  const uncovered = [...gateScripts].filter((g) => !probedScripts.has(g));
  const stale = [...probedScripts].filter((p) => !gateScripts.has(p));

  const problems: string[] = [];
  if (uncovered.length > 0) {
    problems.push(
      `${uncovered.length} gate(s) in scripts/check.ts have no probe here:\n` +
        uncovered.map((s) => `    - ${s}`).join("\n") +
        `\n  Add a probe with a minimal perturbation that the gate should catch.`,
    );
  }
  if (stale.length > 0) {
    problems.push(
      `${stale.length} probe(s) target scripts that are no longer in GATES:\n` +
        stale.map((s) => `    - ${s}`).join("\n") +
        `\n  Remove the stale probe or add the gate back.`,
    );
  }

  if (problems.length > 0) {
    console.error(`\nProbe/gate registry out of sync:\n`);
    for (const msg of problems) console.error(`  ${msg}\n`);
    console.error(
      `A gate without a probe cannot be proven effective. A probe without a gate is dead code.\n`,
    );
    process.exit(2);
  }
}

function main(): void {
  assertProbeCoverage();

  const results: ProbeResult[] = [];
  // Install one-shot cleanup guards so interrupted runs don't leave probe
  // fixtures in the tree.
  let activeCleanup: (() => void) | null = null;
  const onExit = (): void => {
    if (activeCleanup) {
      try {
        activeCleanup();
      } catch {
        /* best-effort */
      }
    }
  };
  process.on("SIGINT", () => {
    onExit();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    onExit();
    process.exit(143);
  });

  for (const probe of PROBES) {
    process.stderr.write(`\n▸ ${probe.script} — ${probe.proves}\n`);
    // Escape-hatch check. If a gate has a documented escape hatch currently
    // active (e.g. check-api-surface during a release with a pending major
    // changeset), the probe would test the escape rather than the detection.
    // Skip explicitly — an ok=true on skipped probes is a false positive.
    if (probe.skipWhen) {
      const decision = probe.skipWhen();
      if (decision.skip) {
        process.stderr.write(`  ⚠ skipped: ${decision.reason}\n`);
        results.push({
          probe,
          gateExitCode: null,
          ok: true,
          skipped: { reason: decision.reason },
        });
        continue;
      }
    }
    // Patch runProbe's cleanup into activeCleanup so the signal handler sees it.
    // (Small duplication of runProbe's logic for this reason.)
    let cleanup: (() => void) | null = null;
    let gateExitCode: number | null = null;
    let ok = false;
    let error: string | undefined;
    try {
      cleanup = probe.perturb();
      activeCleanup = cleanup;
      const cmdArgs = ["--silent", "run", probe.script];
      if (probe.args && probe.args.length > 0) {
        cmdArgs.push("--", ...probe.args);
      }
      const result = spawnSync("pnpm", cmdArgs, {
        stdio: "pipe",
        encoding: "utf-8",
      });
      gateExitCode = result.status;
      ok = gateExitCode !== null && gateExitCode !== 0;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      if (cleanup) {
        try {
          cleanup();
        } catch (err) {
          console.error(`  cleanup failed: ${String(err)}`);
        }
      }
      activeCleanup = null;
    }
    results.push({ probe, gateExitCode, ok, error });
  }

  // Summary
  process.stderr.write("\n─── Gate effectiveness summary ───\n");
  let anyFailed = false;
  let skippedCount = 0;
  for (const { probe, gateExitCode, ok, error, skipped } of results) {
    if (skipped) {
      process.stderr.write(`  ⚠ ${probe.script.padEnd(32)} skipped — ${skipped.reason}\n`);
      skippedCount++;
      continue;
    }
    const status = ok ? "✓" : "✗";
    const detail = error
      ? `error: ${error}`
      : ok
        ? `gate exited ${gateExitCode} (non-zero) as expected`
        : `gate exited ${gateExitCode} — did NOT catch the perturbation`;
    process.stderr.write(`  ${status} ${probe.script.padEnd(32)} ${detail}\n`);
    if (!ok) anyFailed = true;
  }

  if (anyFailed) {
    process.stderr.write(
      `\nOne or more gates failed to catch a known violation. Either the gate is wrong, the probe is wrong, or the gate is decoration masquerading as defense.\n`,
    );
    process.exit(1);
  }

  const provenCount = PROBES.length - skippedCount;
  const skipNote = skippedCount > 0 ? ` (${skippedCount} skipped — see ⚠ above)` : "";
  process.stderr.write(`\n${provenCount} of ${PROBES.length} gates proven effective${skipNote}.\n`);
}

main();
