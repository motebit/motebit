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
        `apps/inspector/src/${PROBE_PREFIX}forbidden_import.ts`,
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
    proves: "flags an env var in .env.example that no source reads (rule 3)",
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
    script: "check-deploy-parity",
    proves:
      "flags an env var read in service src that .env.example doesn't declare (rule 5 — the seed-coupling drift class)",
    perturb: () =>
      // Strip FEATURED_SKILL_SUBMITTERS from services/relay/.env.example.
      // services/relay/src/index.ts reads `process.env.FEATURED_SKILL_SUBMITTERS`
      // (the relay's skill-registry seed-coupling env var per memory
      // `skills_registry_seed_coupling`); rule 5 requires the read be
      // documented. Matches a multi-line block (header comment + blank
      // line + var declaration) so cleanup is unambiguous.
      mutateFile("services/relay/.env.example", (src) =>
        src.replace(
          /# COUPLED to the publishing identity[\s\S]*?FEATURED_SKILL_SUBMITTERS=\n?/,
          "",
        ),
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
    script: "check-changeset-discipline",
    proves: "flags a changeset that mixes ignored and published package bumps",
    perturb: () =>
      writeFixture(
        // Same .changeset/*.md scan path as the major-bump probe above. This
        // probe asserts the third invariant the gate added 2026-04-30: a
        // single changeset must not bump an ignored package
        // (e.g. @motebit/runtime) alongside a published one (e.g. motebit).
        // The release CLI rejects mixed bumps at publish time; without this
        // probe the local gate could regress and we wouldn't know until the
        // Release workflow went red on the next ship.
        `.changeset/${PROBE_PREFIX}mixed-ignored-published.md`,
        `---\n"@motebit/runtime": patch\n"motebit": patch\n---\n\nProbe-only mixed changeset bumping both an ignored and a published package.\n`,
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
      // Mutate the `protocol` row's layer tag from [L0 · Apache-2.0] to
      // [L3 · Apache-2.0]. check-deps.ts pins @motebit/protocol at L0;
      // the probe makes the tree lie about the layer. The gate should
      // emit "protocol tagged L3 but check-deps.ts says L0" and exit 1.
      // A layer swap beats a package rename here — no filesystem
      // entries invented, no cross-section side effects, cleanup
      // restores byte-identical.
      mutateFile("apps/docs/content/docs/operator/architecture.mdx", (src) =>
        src.replace(
          "├── protocol/              [L0 · Apache-2.0]",
          "├── protocol/              [L3 · Apache-2.0]",
        ),
      ),
  },
  {
    script: "check-spec-permissive-boundary",
    proves:
      "flags a backticked callable in spec/*.md whose identifier is not exported from a permissive-floor package and not explicitly waived",
    perturb: () =>
      // Drop a fake camelCase callable reference into an existing spec. The
      // probe scans backticked `fooBar(...)` patterns, skips snake_case and
      // all-lowercase (SQL DDL + math notation), then asserts each remaining
      // identifier is either permissive-floor-exported or listed in
      // WAIVED_CALLABLES. A novel camelCase name like `probeOnlyBslSymbol`
      // satisfies neither and should flip the gate to exit 1 with a specific
      // diagnostic.
      writeFixture(
        `spec/${PROBE_PREFIX}bsl-leak-v1.md`,
        // Minimal spec-shaped fixture. The gate reads spec/*.md — any .md
        // file here is in scope. Body mentions a callable that only BSL
        // could plausibly own, and that no current spec has waived.
        `# motebit/${PROBE_PREFIX}bsl-leak@1.0\n\n` +
          `Probe-only spec. The call \`probeOnlyBslSymbol(arg)\` must trip check-spec-permissive-boundary.\n`,
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
    script: "check-readme-bin-claims",
    proves:
      "flags an `npm i -g @motebit/<pkg>` invocation in any README.md / CLAUDE.md naming a workspace package whose package.json has no `bin` field",
    perturb: () =>
      // Write a probe README that tells the reader to globally-install
      // `@motebit/protocol` — a real workspace package with no `bin`
      // field. The gate should fire because the prose promises a binary
      // the package doesn't ship. Same shape as the verifier↔verify
      // 2026-04-09 swap that produced the original incident.
      writeFixture(
        `apps/web/src/${PROBE_PREFIX}README.md`,
        `# Probe README\n\nInstall: \`npm i -g @motebit/protocol\` and you will have a binary that does not exist.\n`,
      ),
  },
  {
    script: "check-docs-cli-claims",
    proves:
      'flags a backtick-anchored `motebit <subcommand>` invocation in any in-scope doc whose subcommand has no `if (subcommand === "X")` arm in apps/cli/src/index.ts (the original incident: `motebit pair` in get-your-agent.mdx after the pairing protocol shipped only on desktop/mobile)',
    perturb: () =>
      // Write a probe README that tells the reader to run `motebit pair` —
      // the exact 2026-04-26 fabricated invocation. The CLI dispatcher has
      // no `pair` arm, so the gate should fire with `pair is not a CLI
      // subcommand`. writeFixture cleans the file up after the probe.
      writeFixture(
        `apps/web/src/${PROBE_PREFIX}README.md`,
        `# Probe README\n\nRun: \`motebit pair\` to invoke a subcommand that does not exist.\n`,
      ),
  },
  {
    script: "check-docs-slash-claims",
    proves:
      'flags a backtick-anchored `/<slash-command>` invocation in any in-scope doc whose word has no `{ usage: "/X…" }` entry in apps/cli/src/args.ts COMMANDS array',
    perturb: () =>
      // Write a probe README invoking `/fakeslash` — a slash command that
      // is not in the registry. The gate should fire with `/fakeslash is
      // not in the COMMANDS array`. writeFixture cleans the file up
      // after the probe.
      writeFixture(
        `apps/web/src/${PROBE_PREFIX}README.md`,
        `# Probe README\n\nType \`/fakeslash\` to invoke a slash command that does not exist.\n`,
      ),
  },
  {
    script: "check-docs-default-models",
    proves:
      "flags a stale Claude default-model literal in any in-scope doc — the exact 2026-04-27 incident where docs pinned `claude-sonnet-4-5-20250929` after the production default in apps/cli/src/args.ts moved to `claude-sonnet-4-6`",
    perturb: () =>
      // Write a probe README pinning the previous Sonnet model in a
      // default-context shape (`default_model: "claude-sonnet-4-5-20250929"`).
      // The gate should fire with `stale: claude-sonnet-4-5-...; canonical:
      // claude-sonnet-4-6`. writeFixture cleans the file up after the probe.
      writeFixture(
        `apps/web/src/${PROBE_PREFIX}README.md`,
        `# Probe README\n\nSet \`default_model: "claude-sonnet-4-5-20250929"\` to pin the previous default.\n`,
      ),
  },
  {
    script: "check-license-doc-sync",
    proves:
      "flags a permissive-package directory present in the canonical license-field-derived set but missing from CONTRIBUTING.md's § License permissive-floor list",
    perturb: () =>
      // Drop `packages/crypto-android-keystore/` from CONTRIBUTING.md's
      // permissive-floor inline list — the exact 2026-04-26 drift the
      // gate was built to catch. The package's package.json declares
      // license: "Apache-2.0" so the canonical set still contains it;
      // the prose siblings should match. Direction: missing-from-prose
      // fires `missing entry: packages/crypto-android-keystore`.
      mutateFile("CONTRIBUTING.md", (src) =>
        src.replace("`packages/crypto-android-keystore/`, ", ""),
      ),
  },
  {
    script: "check-tsup-define-conventions",
    proves:
      "flags a `__<NAME>_VERSION__` constant in any tsup.config.ts whose value reads from a package name that doesn't match the constant name — the exact misnamed-constant pattern that produced the create-motebit@1.1.0 scaffold-pin bug",
    perturb: () =>
      // Re-introduce the original bug shape: change __SDK_VERSION__ to
      // read from "@motebit/crypto" instead of "@motebit/sdk". The gate
      // should fire with: expected the value to reference "@motebit/sdk".
      // mutateFile restores byte-identical on cleanup.
      mutateFile("packages/create-motebit/tsup.config.ts", (src) =>
        src.replace(
          'readPkgVersion("@motebit/sdk")',
          'readPkgVersion("@motebit/crypto-DELIBERATE-PROBE")',
        ),
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
      // apps/inspector/TrustPanel (then apps/admin) had before the fix
      // that precipitated this gate.
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
      "flags a manifest-listed inbound wire handler that drops its wire-schemas import — mutates services/relay/src/agents.ts to remove the @motebit/wire-schemas import statement, which Rule B (manifest-missing-import) catches",
    perturb: () =>
      // Strip the @motebit/wire-schemas import line(s) from agents.ts.
      // The gate's manifest requires ExecutionReceiptSchema in agents.ts;
      // removing the import means the file no longer satisfies the
      // requirement and Rule B fires. Rule A would also fire if a call
      // remained without an import, but Rule B is the doctrine-load-bearing
      // rule (it catches handlers that bypass the schema entirely).
      mutateFile("services/relay/src/agents.ts", (src) =>
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
  {
    script: "check-spec-tools",
    proves:
      "flags a public ToolDefinition under packages/tools/src/builtins that carries none of @spec / @internal / @experimental — the unclassified rule (rule c) is the load-bearing case because it catches a new tool shipping without any classification, which is the exact debt the gate exists to surface",
    perturb: () =>
      // Fixture: a builtin ToolDefinition literal with `mode:` and `name:` but
      // no preceding @spec/@internal/@experimental annotation. The gate's
      // pending-annotation TTL fires nothing for this declaration, so the
      // tool name lands in the `unclassified` bucket and the gate exits 1.
      writeFixture(
        `packages/tools/src/builtins/${PROBE_PREFIX}unclassified_tool.ts`,
        `import type { ToolDefinition } from "@motebit/sdk";\nexport const unclassifiedProbeDefinition: ToolDefinition = {\n  name: "unclassified_probe",\n  mode: "api",\n  description: "Probe fixture — intentionally missing classification annotation.",\n  inputSchema: { type: "object", properties: {} },\n};\n`,
      ),
  },
  {
    script: "check-spec-routes",
    proves:
      "flags a public Hono route registration under services/relay/src that carries none of @spec / @internal / @experimental — the unclassified rule (rule c) is the load-bearing case because it catches a new route shipping without any classification, which is the exact debt the gate exists to surface",
    perturb: () =>
      // Fixture: a TS file under services/relay/src/ that registers a Hono
      // route with no preceding annotation. The gate's pending-annotation
      // TTL fires nothing for this declaration, so the route lands in the
      // `unclassified` bucket and the gate exits 1.
      writeFixture(
        `services/relay/src/${PROBE_PREFIX}unclassified_route.ts`,
        `import type { Hono } from "hono";\nexport function registerProbeRoute(app: Hono): void {\n  app.get("/__probe__/unclassified", (c) => c.text("probe"));\n}\n`,
      ),
  },
  {
    script: "check-hardware-attestation-primitives",
    proves:
      "flags an inline `AgentTrustCredential` VC composer — file contains the literal type-tuple + a `hardware_attestation:` subject assignment but does not import `composeHardwareAttestationCredential`",
    perturb: () =>
      // Fixture: a file under apps/web/src/ that composes the VC envelope
      // inline — literal `type: ["VerifiableCredential", "AgentTrustCredential"]`
      // tuple plus `hardware_attestation:` in a `credentialSubject` literal.
      // This is the exact drift shape the gate exists to prevent (the third
      // inline copy after CLI and desktop). No import of the canonical
      // composer means Rule A fires.
      writeFixture(
        `apps/web/src/${PROBE_PREFIX}inline_ha_composer.ts`,
        `// Probe-only fixture — inline composition of a hardware-attestation VC.
export function rogueCompose(issuerDid: string, identityHex: string): unknown {
  return {
    "@context": ["https://www.w3.org/ns/credentials/v2"],
    type: ["VerifiableCredential", "AgentTrustCredential"],
    issuer: issuerDid,
    validFrom: new Date().toISOString(),
    credentialSubject: {
      id: issuerDid,
      identity_public_key: identityHex,
      hardware_attestation: { platform: "software", key_exported: false },
      attested_at: Date.now(),
    },
  };
}
`,
      ),
  },
  {
    script: "check-dom-id-references",
    proves:
      "flags a `document.getElementById(\"...\")` call in a surface app's src tree whose id argument is not declared in the same app's index.html or TS source — the exact shape the 2026-03-17 rotate-key drift had",
    perturb: () =>
      // Fixture: a TS file in apps/desktop/src querying an id that
      // doesn't exist anywhere else in the repo. The random-ish suffix
      // on the id ensures it can't accidentally coincide with a real
      // declared id — the gate should flag it unambiguously.
      writeFixture(
        `apps/desktop/src/${PROBE_PREFIX}dom_id_drift.ts`,
        `// Probe-only fixture — queries an id that isn't declared anywhere.
export function rogueLookup(): HTMLElement | null {
  return document.getElementById("__gate_probe__nonexistent_id_xqz7k");
}
`,
      ),
  },
  {
    script: "check-deprecation-discipline",
    proves:
      "flags a `@deprecated` annotation that lacks a replacement pointer and a `Reason:` block — violates two of the four-field contract rules the deprecation-lifecycle doctrine mandates",
    perturb: () =>
      // Fixture: a packages/sdk source file (published, version != 0.0.0-private)
      // with a `@deprecated` annotation that has since + removed in but no
      // replacement pointer and no Reason: block. The gate should fire with
      // both violations named.
      writeFixture(
        `packages/sdk/src/${PROBE_PREFIX}deprecation_drift.ts`,
        `/**
 * @deprecated since 1.0.0, removed in 1.1.0.
 */
export const __probeOnlyDeprecationDrift = 1;
`,
      ),
  },
  {
    script: "check-private-deprecation-shape",
    proves:
      "flags a `@deprecated` annotation in a `0.0.0-private` package that carries `since X.Y.Z` and `removed in X.Y.Z` — semver fields are theater inside a workspace with no versioning boundary; the private path requires only a replacement pointer + Reason",
    perturb: () =>
      // Fixture: a packages/runtime source file (version "0.0.0-private")
      // with a four-field `@deprecated` annotation. Should trip the
      // no-semver rule on both `since` and `removed in`. Replacement
      // pointer + Reason are present so the only violations are the
      // two semver fields.
      writeFixture(
        `packages/runtime/src/${PROBE_PREFIX}private_deprecation_shape.ts`,
        `/**
 * @deprecated since 1.0.0, removed in 2.0.0. Use \`newProbeShape\` instead.
 *
 * Reason: probe-only fixture for the private-deprecation-shape gate.
 */
export const __probeOnlyPrivateDeprecation = 1;
`,
      ),
  },
  {
    script: "check-credentials-submit-response-shape",
    proves:
      "flags a client-side fetch(`/credentials/submit`) caller that checks only `response.ok` and never inspects the `{accepted, rejected, errors}` response body — the relay returns HTTP 200 even when it server-side-rejects every credential per spec/credential-v1.md §23",
    perturb: () =>
      // Fixture: a packages/runtime src file that POSTs to /credentials/submit
      // and checks only resp.ok. The gate should fire because neither
      // `accepted` nor `rejected` appears in the file. Probe shape mirrors
      // the actual reverted bug (commit 63fa2199) and the post-revert
      // reincarnation in interactive-delegation.ts.
      writeFixture(
        `packages/runtime/src/${PROBE_PREFIX}credentials_submit_response.ts`,
        `export async function __probeOnlyBadSubmit(syncUrl: string, motebitId: string, vc: unknown): Promise<boolean> {
  const resp = await fetch(\`\${syncUrl}/api/v1/agents/\${motebitId}/credentials/submit\`, {
    method: "POST",
    body: JSON.stringify({ credentials: [vc] }),
  });
  return resp.ok;
}
`,
      ),
  },
  {
    script: "check-admin-route-auth",
    proves:
      'flags an `/api/v1/admin/*` route registered in services/relay/src/ that has no matching `app.use("...", bearerAuth(...))` registration in middleware.ts — the route would ship wide open, same shape as the /api/v1/admin/transparency seam fixed manually in 2560472b',
    perturb: () =>
      // Fixture: a services/relay/src file that registers a fresh admin
      // route. The gate runs after this is dropped in; middleware.ts has
      // no entry for `/api/v1/admin/__effective_probe`, so the gate must
      // exit non-zero with the missing-coverage message.
      writeFixture(
        `services/relay/src/${PROBE_PREFIX}admin_unauth_route.ts`,
        `import type { Hono } from "hono";

export function __probeOnlyRegisterAdminUnauth(app: Hono): void {
  app.get("/api/v1/admin/__effective_probe", (c) => c.json({ probe: true }));
}
`,
      ),
  },
  {
    script: "check-skill-script-uses-tool-approval",
    proves:
      "flags a TS file that reads bytes from a skill's quarantined `scripts/` tree, imports `node:child_process`, and calls a spawn primitive — but never calls `approvalStore.add(...)` to enroll the invocation in the canonical operator approval queue",
    perturb: () =>
      // Fixture: a packages/runtime src file that walks `record.files["scripts/X"]`
      // bytes through `child_process.spawn(...)` without ever creating an
      // approval-store row. This is the parallel-approval-surface anti-pattern
      // the skills phase 2 quarantine memo names; the gate must catch it.
      writeFixture(
        `packages/runtime/src/${PROBE_PREFIX}skill_script_unapproved.ts`,
        `import { spawn } from "node:child_process";

interface ProbeRecord { files: Record<string, Uint8Array> }

export function __probeRunScriptDirectly(record: ProbeRecord, scriptName: string): void {
  const bytes = record.files["scripts/" + scriptName];
  if (!bytes) return;
  // Bypassing the canonical approval store entirely — this is the
  // anti-pattern the gate exists to catch.
  spawn("sh", ["-c", "cat", String(bytes.length)]);
}
`,
      ),
  },
  {
    script: "check-tsup-uses-emit-decl-only",
    proves:
      "flags a workspace package whose `scripts.build` invokes tsup but whose own tsconfig.json does not pin `emitDeclarationOnly: true` — the exact shape that shipped a broken @motebit/crypto@1.2.0 to npm",
    perturb: () =>
      // Strip the `"emitDeclarationOnly": true,` line from packages/crypto/tsconfig.json
      // (the canonical tsup user). The gate reads each tsup-using package's own
      // tsconfig literally — extends chains aren't resolved — so removing the
      // explicit pin must surface as a violation. The regex matches the line
      // including its trailing comma + newline; mutateFile restores byte-identical
      // on cleanup.
      mutateFile("packages/crypto/tsconfig.json", (src) =>
        src.replace(/\s+"emitDeclarationOnly":\s*true,?/, ""),
      ),
  },
  {
    script: "check-deposit-detector-confirmations",
    proves:
      "flags a CAIP-2 chain in USDC_CONTRACTS that has no matching CONFIRMATIONS_BY_CHAIN entry — the silent-omission shape that disables the detector for the chain",
    perturb: () =>
      // Strip the eip155:8453 (Base mainnet) entry from CONFIRMATIONS_BY_CHAIN
      // while leaving it in USDC_CONTRACTS. The gate must surface the parity
      // mismatch — adding a chain to one map without the other is the
      // canonical drift the gate exists to catch. mutateFile restores
      // byte-identical on cleanup.
      mutateFile("services/relay/src/deposit-detector.ts", (src) =>
        src.replace(/^\s*"eip155:8453":\s*12,\n/m, ""),
      ),
  },
  {
    script: "check-preset-imports",
    proves:
      "flags a surface-app declaration that shadows an @motebit/sdk canonical preset identifier (APPROVAL_PRESET_CONFIGS, COLOR_PRESETS, RISK_LABELS, …)",
    perturb: () =>
      // Fixture: an apps/inspector src file that redeclares APPROVAL_PRESET_CONFIGS
      // locally. The gate scans apps/*/src for top-level
      // const/let/interface/type/enum declarations whose name matches any
      // canonical SDK preset identifier; a re-export trampoline would be
      // accepted, a bare declaration is a violation.
      writeFixture(
        `apps/inspector/src/${PROBE_PREFIX}preset_shadow.ts`,
        `export const APPROVAL_PRESET_CONFIGS = { drifted: { requireApprovalAbove: 99, denyAbove: 100 } };\n`,
      ),
  },
  {
    script: "check-chat-tag-stripping",
    proves:
      "flags a surface file with an inline `.replace(/<thinking>/…)` stripping pass that doesn't import `stripInternalTags` / `stripPartialActionTag` from @motebit/ai-core",
    perturb: () =>
      // Fixture: an apps/inspector src file that strips the <thinking> tag inline
      // (the runtime-emitted narration token the canonical primitive owns)
      // without importing the primitive. The gate should fire because the
      // file has a .replace against a stripping token AND no canonical import.
      writeFixture(
        `apps/inspector/src/${PROBE_PREFIX}tag_strip_drift.ts`,
        `export function clean(text: string): string {\n  return text.replace(/<thinking>[\\s\\S]*?<\\/thinking>/g, "");\n}\n`,
      ),
  },
  {
    script: "check-drift-defenses-inventory",
    proves:
      "flags a GATES entry in scripts/check.ts that has no corresponding row in docs/drift-defenses.md's inventory table",
    perturb: () =>
      // Perturbation: delete the inventory row for check-scene-primitives.
      // Chose this gate because it's referenced in exactly ONE line of the
      // document (its own inventory row — no incident-history prose, no
      // cross-reference from another invariant's row). Deleting that one
      // line leaves the gate registered in scripts/check.ts GATES but
      // entirely absent from docs/drift-defenses.md — the exact drift
      // shape the meta-gate defends against. mutateFile restores the
      // file byte-identical on cleanup.
      //
      // If scene-primitives ever gains a second inventory reference
      // (e.g. cross-linked from another row), pick a different single-
      // mention gate — check-tool-modes is the current alternate. The
      // probe wants a surgical perturbation that nothing else masks.
      mutateFile("docs/drift-defenses.md", (src) =>
        src.replace(
          /^\|\s+\d+\s+\|[^|]*\|[^|]*`check-scene-primitives\.ts`[^|]*\|[^|]*\|\s*\n/m,
          "",
        ),
      ),
  },
  {
    script: "check-cli-surface",
    proves:
      "flags a divergence between the motebit CLI operator-ergonomic surface (subcommands / flags / exit codes / on-disk paths) and apps/cli/etc/cli-surface.json baseline",
    skipWhen: () => {
      // Gate's escape hatch: a pending `motebit: major` changeset accepts
      // any drift. If one is present, perturbing the surface tests the
      // escape rather than the detection.
      const dir = resolve(ROOT, ".changeset");
      if (!existsSync(dir)) return { skip: false, reason: "" };
      const files = readdirSync(dir).filter(
        (f) => f.endsWith(".md") && f !== "README.md" && f !== "CHANGELOG.md",
      );
      for (const f of files) {
        const front = readFileSync(resolve(dir, f), "utf-8").match(/^---\n([\s\S]*?)\n---/);
        if (!front) continue;
        for (const line of front[1]!.split("\n")) {
          const m = line.match(/^"motebit":\s*(patch|minor|major)/);
          if (m && m[1] === "major") {
            return {
              skip: true,
              reason: "pending `motebit: major` changeset authorizes CLI-surface drift",
            };
          }
        }
      }
      return { skip: false, reason: "" };
    },
    perturb: () =>
      // Comment out the `voice` flag declaration in args.ts. Extract pulls
      // every `name: { type: ... }` entry; once `voice` is hidden behind
      // `//`, the regex no longer matches, the extracted set drops the
      // flag, and the gate emits `flag-removed: --voice` against the
      // baseline. mutateFile restores byte-identical on cleanup. Choosing
      // `voice` over higher-traffic flags keeps the perturbation surgical:
      // single-line declaration, no comma-juggling, no semantic side
      // effects in CLI arg parsing during the brief window the file is
      // mutated (the gate is a static read).
      mutateFile("apps/cli/src/args.ts", (src) =>
        src.replace(
          /^(\s+)voice: \{ type: "boolean", default: false \},$/m,
          '$1// voice: { type: "boolean", default: false },',
        ),
      ),
  },
  {
    script: "check-doc-counts",
    proves:
      "flags a numeric count claim in README.md / CLAUDE.md / architecture.mdx that disagrees with the filesystem (packages/specs/apps/services)",
    perturb: () =>
      // Mutate the README architecture banner from "47 packages" to "37
      // packages" — exactly the drift shape this gate was built for
      // (the 2026-04-24 incident found three doc surfaces drifted to
      // 36/40/37 against an actual filesystem; same shape resurfaced
      // 2026-04-26 when crypto-android-keystore landed and four doc
      // surfaces stayed pinned at "46 packages"). Distinctive enough
      // that grep-and-revert is trivial if cleanup ever fails. Other
      // count claims (specs, the second package mention) stay correct,
      // so only the perturbed line should appear in the gate's
      // findings — proves the gate is per-line precise, not just a
      // pass/fail of the whole doc. Probe-literal drift (the count
      // bumping over time as packages are added) is itself caught by
      // check-gates-effective: a stale literal makes the perturbation
      // a no-op and the gate exits 0, surfaced as "did NOT catch the
      // perturbation" — so the probe self-rots are visible.
      mutateFile("README.md", (src) =>
        src.replace(
          "**49 packages across 7 architectural layers",
          "**37 packages across 7 architectural layers",
        ),
      ),
  },
  {
    script: "check-doc-diagrams",
    proves:
      "flags a `<DiagramFigure>` cite that names a `## N.` section number not present in the cited spec/*.md — the exact rot shape the gate exists for: spec restructure renumbers headers, the diagram cite quietly 404s",
    perturb: () =>
      // Mutate one of the live cites in operator/architecture.mdx — flip
      // the receipt-chain cite from §11 (real, present in
      // execution-ledger-v1.md) to §99 (does not exist). The gate's
      // section-existence check fires on the spec/ branch and exits 1.
      // Surgical: a single-character replacement, byte-identical
      // restoration on cleanup.
      mutateFile("apps/docs/content/docs/operator/architecture.mdx", (src) =>
        src.replace(
          'label: "execution-ledger §11", file: "spec/execution-ledger-v1.md", section: 11',
          'label: "execution-ledger §11", file: "spec/execution-ledger-v1.md", section: 99',
        ),
      ),
  },
  {
    script: "check-doc-private-imports",
    proves:
      'flags a `from "@motebit/<private>"` import in docs MDX that is NOT wrapped in `<ReferenceExample>` — exactly the doctrine drift the gate exists for: a developer doc page leaking an unimportable private package as if it were public npm surface',
    perturb: () =>
      // Drop a fixture MDX file containing a top-level `from
      // "@motebit/market"` import outside any wrapper. Distinctive
      // filename so cleanup can find and remove it cleanly. The
      // gate's import scanner picks it up as a violation.
      writeFixture(
        `apps/docs/content/docs/developer/${PROBE_PREFIX}private_import_violation.mdx`,
        [
          "---",
          "title: Probe fixture",
          "description: Probe fixture — intentional unwrapped private-package import.",
          "---",
          "",
          "```typescript",
          'import { allocateBudget } from "@motebit/market";',
          "```",
          "",
        ].join("\n"),
      ),
  },
  {
    script: "check-llms-txt-fresh",
    proves:
      "flags llms.txt drifted from generator output — appending a stale line to the committed artifact makes the freshness gate's byte-comparison fail",
    perturb: () =>
      // Mutate the committed llms.txt by appending a marker that the
      // generator would never produce. The gate regenerates in-process
      // and compares byte-for-byte; the appended line forces a delta.
      mutateFile(
        "apps/docs/public/llms.txt",
        (src) => `${src}\n<!-- ${PROBE_PREFIX}stale_line — drift gate probe -->\n`,
      ),
  },
  {
    script: "check-doctrine-format",
    proves:
      "flags DOCTRINE.md chain bullet whose canonical bold-link format is broken — dropping the `**` markers reduces the parser's match count below the expected nine and the gate fires",
    perturb: () =>
      // Drop the `**…**` bold markers from the first chain bullet.
      // The parser regex requires the bold link, so removing it
      // drops parsed-chain-length from 9 to 8 and the
      // EXPECTED_CHAIN_LENGTH check fires. Reversed cleanly by
      // mutateFile's restore.
      mutateFile("DOCTRINE.md", (src) =>
        src.replace(/^1\. \*\*\[([^\]]+)\]\(([^)]+)\)\*\* — /m, "1. [$1]($2) — "),
      ),
  },
  {
    script: "check-skill-corpus",
    proves:
      "flags a committed reference skill whose SKILL.md body bytes have drifted away from the body_hash committed in skill-envelope.json (the exact pre-push incident this gate caught when prettier reformatted SKILL.md after signing)",
    perturb: () =>
      // Append a stray byte to the reference SKILL.md body so its SHA-256
      // diverges from the envelope's committed body_hash. The signed
      // envelope has not been re-derived, so the gate should fire on the
      // body_hash mismatch. mutateFile's restore reverses it byte-for-byte.
      mutateFile("skills/git-commit-motebit-style/SKILL.md", (src) => src + "\n# probe drift\n"),
  },
  {
    script: "check-skill-cli-coverage",
    proves:
      'flags a public method on SkillRegistry that has no matching `skillsCmd === "<verb>"` dispatch arm in apps/cli/src/index.ts — the drift class where a registry method ships unreachable from the CLI',
    perturb: () =>
      // Add a fake public method to the SkillRegistry class. The CLI's
      // skills dispatch block has no arm for it, so the gate's
      // method↔verb crosscheck should fire. mutateFile's restore
      // reverses cleanly.
      mutateFile("packages/skills/src/registry.ts", (src) =>
        src.replace(
          /  async verify\(/,
          "  async fooBar(): Promise<void> { return; }\n\n  async verify(",
        ),
      ),
  },
  {
    script: "check-trust-score-display",
    proves:
      "flags an Agents-panel renderer that no longer surfaces the verifier name via `formatHardwarePlatform` — the doctrine breach where the runtime ranks peers on hardware attestation but the user can't see WHICH verifier attested the peer",
    perturb: () =>
      // Strip the formatHardwarePlatform import + use from the desktop
      // renderer. The gate's per-arm check (field reference AND
      // verifier-formatter import) should fire on the missing helper.
      // mutateFile's restore reverses cleanly.
      mutateFile("apps/desktop/src/ui/agents.ts", (src) =>
        src.replace(/\bformatHardwarePlatform\b/g, "_disabledFormatHardwarePlatform"),
      ),
  },
  {
    script: "check-trust-score-display",
    proves:
      "flags an Agents-panel renderer that no longer surfaces the latency readout via `formatLatency` — same doctrine breach class as the HA arm: latency factors into peer ranking via `agent-graph.ts` but the user can't see the avg/p95 the runtime ranks against",
    perturb: () =>
      // Strip the formatLatency import + use from the web renderer.
      // Per-arm symmetry with the HA probe above; using a different
      // surface so a regression in only one renderer's wiring still
      // gets caught. mutateFile's restore reverses cleanly.
      mutateFile("apps/web/src/ui/gated-panels.ts", (src) =>
        src.replace(/\bformatLatency\b/g, "_disabledFormatLatency"),
      ),
  },
  {
    script: "check-sensitivity-routing",
    proves:
      "flags a runtime AI-call entry that skips the sensitivity gate AND a user-facing surface that drops the `/sensitivity` affordance — both shapes of the doctrine breach where bytes leak (gate skipped at the runtime) or the gate is unreachable (affordance missing on a surface)",
    perturb: () =>
      // Strip the canonical runtime setter from one surface's slash
      // dispatch. The affordance arm fires because the file no longer
      // routes through `runtime.setSessionSensitivity` — sensitivity
      // case present but disconnected from the runtime API is exactly
      // the "decorative affordance" failure mode the gate's surface
      // arm exists to catch. mutateFile's restore reverses cleanly.
      mutateFile("apps/cli/src/slash-commands.ts", (src) =>
        src.replace(/runtime\.setSessionSensitivity\b/g, "runtime._disabledSetSessionSensitivity"),
      ),
  },
  {
    script: "check-sqlite-migration-runner",
    proves:
      "flags an inline `PRAGMA user_version = N` write outside the canonical migration runner — the exact drift class the gate exists to prevent (independent inline ladders divergent from `@motebit/sqlite-migrations`)",
    perturb: () =>
      // Inject an inline pragma write into the runtime's SDK index — a
      // file that today contains no migration code at all, so the
      // injected line is unambiguously the violation. The gate scans
      // packages/, apps/, services/ for `user_version = (digit|$|?|`)`
      // outside the allowlisted runner / driver-internal sites; this
      // injection should fire on the next scan. mutateFile restores
      // byte-identical on cleanup.
      mutateFile("packages/sdk/src/index.ts", (src) =>
        src.replace(
          /(\/\/ === Relation Types)/,
          'const __probe_user_version = "PRAGMA user_version = 999";\nvoid __probe_user_version;\n\n$1',
        ),
      ),
  },
  {
    script: "check-retention-coverage",
    proves:
      "flags a runtime-side CREATE TABLE with a `sensitivity` column whose table name is not in `RUNTIME_RETENTION_REGISTRY` — the unregistered-table drift class (a sensitivity-classified store the cycle's flush phase doesn't see, leaking past the doctrinal ceiling)",
    perturb: () =>
      // Inject a fake CREATE TABLE with a `sensitivity` column into the
      // persistence at-rest schema. The table name `__probe_unregistered`
      // doesn't appear in RUNTIME_RETENTION_REGISTRY or
      // STORE_TABLE_ALIASES, so the gate's reverse drift check fires on
      // the next scan. mutateFile restores byte-identical on cleanup.
      mutateFile("packages/persistence/src/index.ts", (src) =>
        src.replace(
          /(CREATE TABLE IF NOT EXISTS conversation_messages \()/,
          "CREATE TABLE IF NOT EXISTS __probe_unregistered (\n  id TEXT PRIMARY KEY,\n  sensitivity TEXT\n);\n\n$1",
        ),
      ),
  },
  {
    script: "check-relay-retention-coverage",
    proves:
      "flags a `RETENTION_MANIFEST_CONTENT.stores[]` entry whose `store_id` has no matching alias in `RELAY_STORE_TABLE_ALIASES` — the missing-alias drift class (a manifest declaration of an enforcement that doesn't exist, the operator's transparency claim silently rotting). Sibling to check-retention-coverage's probe but scoped to the relay-side manifest projection rather than the runtime-side registry.",
    perturb: () =>
      // Inject an orphan manifest store entry into OPERATIONAL_LEDGER_STORES
      // in retention-manifest.ts. The store_id `__probe_orphan_store`
      // doesn't appear in RELAY_STORE_TABLE_ALIASES, so the gate's
      // forward-direction `missing-alias` check fires on the next scan.
      // mutateFile restores byte-identical on cleanup.
      mutateFile("services/relay/src/retention-manifest.ts", (src) =>
        src.replace(
          /(const OPERATIONAL_LEDGER_STORES: RetentionStoreDeclaration\[\] = \[)/,
          `$1
  {
    store_id: "__probe_orphan_store",
    store_name: "Probe orphan store (gate-effectiveness probe)",
    shape: {
      kind: "append_only_horizon",
      horizon_advance_period_days: 1,
      witness_required: false,
    },
  },`,
        ),
      ),
  },
  {
    script: "check-skills-cross-surface",
    proves:
      "flags a surface (web) that drops its `SkillRegistry` construction. The gate would let a future contributor delete the registry wiring while leaving the panel UI in place — silently rendering an empty panel forever. Probe rewrites `new SkillRegistry(` to a no-op token so the regex no longer matches, confirming the gate fires on the missing wiring.",
    perturb: () =>
      mutateFile("apps/web/src/web-app.ts", (src) =>
        src.replace(/new SkillRegistry\(/g, "/* probe */ Object.create(null) as SkillRegistry; (("),
      ),
  },
  {
    script: "check-package-browser-entry",
    proves:
      'flags a workspace package whose top-level `src/index.ts` re-exports a sibling that imports `node:*` at module top — the exact shape of the skills bug fixed in commit 18e978a0. Probe restores the pre-fix `export ... from "./fs-adapter.js"` line in `packages/skills/src/index.ts`, recreating the bomb the gate exists to prevent.',
    perturb: () =>
      mutateFile(
        "packages/skills/src/index.ts",
        (src) =>
          // Append the pre-fix re-export at the end of the file. The
          // gate inspects only `src/index.ts` directly; appending an
          // `export ... from "./fs-adapter.js"` line is the minimal
          // probe shape and matches the structural pattern the gate
          // catches without needing to undo the comment block.
          `${src}\nexport { NodeFsSkillStorageAdapter } from "./fs-adapter.js";\n`,
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

/**
 * Pre-flight: detect and revert leakage from a previously interrupted run.
 *
 * The per-probe try/finally and the SIGINT/SIGTERM handlers below cover
 * graceful interrupts. They cannot cover SIGKILL — when a tool runner or
 * the OS hard-kills this process, the cleanup closures don't get a chance
 * to run and the perturbation is left in the working tree. The fix is
 * asymmetric: we can't catch SIGKILL inside the killed process, but we
 * can scan for its leakage at the start of the next run.
 *
 * Two leakage shapes need draining:
 *
 *   1. Orphan fixture files — probes that synthesize new files (their
 *      basename always carries PROBE_PREFIX). git tracks these as
 *      untracked; the prefix in the path is the signature.
 *
 *   2. Mutated baselines — probes that splice a one-line marker comment
 *      into an existing tracked file (e.g. an api-extractor baseline).
 *      git diff reports them as modified; the needle is constructed at
 *      runtime as `PROBE_PREFIX + "injected"` to avoid having this
 *      script's own source contain the literal pattern (which would
 *      cause every drain run to revert this script to HEAD).
 *
 * Self-exclusion: this script never drains itself, even if it somehow
 * matches the needle. Defensive backstop against the same self-trip.
 *
 * Idempotent: if drain is itself interrupted, the next run sees the same
 * leakage and drains again. Quiet on the happy path.
 */
function drainStalePerturbations(): void {
  // Construct the needle at runtime so this source never contains the
  // literal "__gate_probe__" + "injected" sequence.
  const INJECTED_NEEDLE = PROBE_PREFIX + "injected";
  const SELF = "scripts/check-gates-effective.ts";

  // Orphan fixture files — untracked, with the prefix in the path.
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  const orphanFixtures = untracked.stdout
    .split("\n")
    .filter((line) => line && line.includes(PROBE_PREFIX));

  // Mutated baselines — tracked, dirty, containing the injected marker.
  // Parse `git diff HEAD` once and pluck filenames where an added line
  // carries the needle.
  const diff = spawnSync("git", ["diff", "HEAD"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  const dirtyFiles = new Set<string>();
  if (diff.stdout.includes(INJECTED_NEEDLE)) {
    let currentFile: string | null = null;
    for (const line of diff.stdout.split("\n")) {
      if (line.startsWith("+++ b/")) {
        currentFile = line.slice(6);
      } else if (
        currentFile &&
        currentFile !== SELF &&
        line.startsWith("+") &&
        line.includes(INJECTED_NEEDLE)
      ) {
        dirtyFiles.add(currentFile);
      }
    }
  }

  if (orphanFixtures.length === 0 && dirtyFiles.size === 0) return;

  console.error(`\nDetected stale gate-probe leakage from a prior interrupted run:`);
  for (const f of dirtyFiles) console.error(`  • mutated baseline: ${f}`);
  for (const f of orphanFixtures) console.error(`  • orphan fixture:  ${f}`);
  console.error(`Draining before starting probes…\n`);

  for (const f of dirtyFiles) {
    spawnSync("git", ["checkout", "HEAD", "--", f], { cwd: ROOT });
  }
  for (const f of orphanFixtures) {
    try {
      unlinkSync(resolve(ROOT, f));
    } catch (err) {
      console.error(`  (could not unlink ${f}: ${String(err)})`);
    }
  }
}

function main(): void {
  drainStalePerturbations();
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
