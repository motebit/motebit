/**
 * Meta-check runner — one command that runs every hard-fail drift defense.
 *
 * The monorepo's synchronization invariants are enforced by a collection of
 * small, focused check-* scripts (see CLAUDE.md § "Synchronization
 * invariants are the meta-principle"). Each one owns a specific invariant:
 *
 *   check-deps              — architectural layers, permissive-floor purity, cycles
 *   check-specs             — spec ↔ implementation references
 *   check-service-primitives — services must not inline protocol plumbing
 *   check-app-primitives    — apps must not bypass the product vocabulary
 *
 * Before this runner existed, CI invoked each check individually —
 * meaning a new check that was only added to package.json (but not to
 * ci.yml) would run locally but stay silent in PRs. That is the exact
 * drift shape the checks themselves are designed to prevent.
 *
 * This runner is the single source of truth for which defenses run.
 * CI calls `pnpm check` once; adding a new gate means appending an
 * entry here. Adversarially tested: if any gate fails, this process
 * exits non-zero with a summary of which one(s).
 *
 * Soft/advisory checks are intentionally excluded from this runner:
 *   check-unused (knip)              — soft signal, CI uses continue-on-error
 *   check-sibling-boundaries         — PR-diff scoped, runs separately
 *   check-secrets.sh                 — pre-commit hook, not a CI gate
 *
 * Each exclusion must be named in EXCLUDED_CHECKS below so this runner
 * can assert that every `check-*` script in root package.json is either
 * listed as a gate or explicitly excluded — closing the sibling-drift
 * gap in the drift-defense system itself.
 */

import { spawn, spawnSync } from "node:child_process";
import { availableParallelism } from "node:os";
import { readFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

/**
 * Test-fixture marker used by `check-gates-effective`. Probe files
 * carry this prefix so they're identifiable across the tree.
 */
const PROBE_PREFIX = "__gate_probe__";

/**
 * Drain orphan gate-probe files at the start of every `pnpm check`
 * run. Probe files are deliberately structured to look like
 * violations of source-walking gates (e.g.
 * `check-trust-propagation-primitives`), so a probe that survives an
 * interrupted `check-gates-effective` run will fail an unrelated
 * gate the next time it's run on its own.
 *
 * `check-gates-effective` already calls `drainStalePerturbations` at
 * its own startup, but the orphan window between an interrupted
 * `check-gates-effective` and the next `pnpm check` left the tree
 * dirty for any source-walking gate. This drain closes that window
 * — orphan probes get removed before any gate runs.
 *
 * Quiet on the happy path: only logs when files are found and
 * removed, matching the same pattern the canonical drain in
 * `check-gates-effective` uses.
 */
function drainStaleProbes(): void {
  const result = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf-8",
  });
  if (result.status !== 0) return;
  const orphans = result.stdout
    .split("\n")
    .filter((line) => line.length > 0 && line.includes(PROBE_PREFIX));
  if (orphans.length === 0) return;
  process.stderr.write(
    `\nDetected ${orphans.length} stale gate-probe fixture(s) from a prior interrupted run; draining before checks…\n`,
  );
  for (const f of orphans) {
    try {
      unlinkSync(resolve(ROOT, f));
      process.stderr.write(`  • removed ${f}\n`);
    } catch (err) {
      process.stderr.write(`  • could not remove ${f}: ${String(err)}\n`);
    }
  }
  process.stderr.write("\n");
}

interface Gate {
  name: string;
  /** What this gate defends. Shown when the gate fails so operators see the intent, not just the failure. */
  defends: string;
  /** npm/pnpm script name — must exist in root package.json. */
  script: string;
  /**
   * Extra args passed to the script. Used when a script has a soft default
   * but exposes a strict mode via flag (e.g. check-specs --strict). The gate
   * list is the policy layer; the script is the mechanism.
   */
  args?: string[];
}

/**
 * Explicitly excluded check-* scripts. Anything in root package.json that
 * starts with `check-` and is not in GATES must appear here, with a
 * one-line reason. This defends against the exact drift this runner exists
 * to prevent: a new check-* added to package.json but silently omitted
 * from CI.
 */
const EXCLUDED_CHECKS: Record<string, string> = {
  "check-unused": "soft signal (knip) — CI uses continue-on-error, not a hard gate",
  "check-sibling-boundaries": "PR-diff scoped advisory — runs as a separate CI job",
  "check-gates-effective":
    "meta-probe that runs every GATES entry under a deliberate perturbation — would invoke each gate a second time per PR. Runs as a separate CI job scoped to scripts/* changes.",
};

// Order matters: run fastest first so CI fails loudly on the cheapest signal.
const GATES: ReadonlyArray<Gate> = [
  {
    name: "check-deps",
    defends: "architectural layers, permissive-floor purity, cycles, tsconfig refs",
    script: "check-deps",
  },
  {
    name: "check-specs",
    defends: "every spec/*.md is referenced by implementation code",
    script: "check-specs",
    // --strict promotes the script from advisory to hard-fail: exit 1 if any
    // spec has zero references. The doctrine (CLAUDE.md § "Never let divergence
    // persist") makes this invariant right for the project even though the
    // script defaults to advisory for direct invocation.
    args: ["--strict"],
  },
  {
    name: "check-spec-coverage",
    defends:
      "types named in spec Wire format (foundation law) sections are exported from @motebit/protocol; every spec has adopted the wire-vs-storage split",
    script: "check-spec-coverage",
    // --strict promotes the grace-period warning (unstructured specs) into a
    // hard fail. Flipped on 2026-04-13 after all twelve specs adopted the
    // wire-vs-storage doctrine. The tenth synchronization invariant is now
    // locked at category 2 — a new spec MUST ship with at least one
    // "#### Wire format (foundation law)" subsection or CI fails.
    args: ["--strict"],
  },
  {
    name: "check-spec-tools",
    defends:
      "every MCP tool name declared in a spec/*.md `#### Tools (foundation law)` block is annotated `@spec <id>` on a registered tool, every `@spec` annotation cross-references a spec declaration, every public tool carries one of `@spec` / `@internal` / `@experimental`, and every `@experimental` carries the four-field temporal-sanity contract with a not-past-due `@stabilizes_by` (invariant #47, added 2026-04-24 as the first construct-level enforcement of the protocol-faithfulness invariant family — promise enforcement, not change detection)",
    script: "check-spec-tools",
  },
  {
    name: "check-spec-routes",
    defends:
      "every HTTP route declared in a spec/*.md `#### Routes (foundation law)` block is annotated `@spec <id>` on a registered route, every `@spec` annotation cross-references a spec declaration, every public route carries one of `@spec` / `@internal` / `@experimental`, and every `@experimental` carries the four-field temporal-sanity contract with a not-past-due `@stabilizes_by` (invariant #48, added 2026-04-24 as the second construct-level enforcement in the protocol-faithfulness family — same three-layer pattern as #47 against the larger 155-route surface; closes the protocol-faithfulness invariant family for routes and tools)",
    script: "check-spec-routes",
  },
  {
    name: "check-spec-wire-schemas",
    defends:
      "every wire-format type declared in spec/*.md has a matching <TypeName>Schema export from @motebit/wire-schemas (invariant #23, added 2026-04-18 alongside the wire-schemas publication — completes the spec → TS-type → zod-schema → JSON-Schema chain so third-party implementers can validate without bundling motebit)",
    script: "check-spec-wire-schemas",
  },
  {
    name: "check-wire-schema-usage",
    defends:
      "every inbound wire-format body at services/relay parses through @motebit/wire-schemas — handlers must call <Name>Schema.safeParse(/.parse( on the body, never accept untyped c.req.json() through inline casts (invariant #35, added 2026-04-20 after a principal-engineer audit found four Dispute* wire types and BalanceWaiver still bypassing the schema layer despite commit 1848d2ea adding the parse calls for the other four types — extends the protocol-primitive doctrine to runtime body validation; complements the static three-way pin in invariant #22)",
    script: "check-wire-schema-usage",
  },
  {
    name: "check-suite-declared",
    defends:
      "every signed wire-format artifact declares a `suite` field naming a @motebit/protocol-registered SuiteId (invariant #10)",
    script: "check-suite-declared",
  },
  {
    name: "check-suite-dispatch",
    defends:
      "every signature primitive call in @motebit/crypto, services/, and apps/ routes through suite-dispatch.ts — no implicit Ed25519 defaults (invariant #11; scope widened from packages/crypto/src/ only on 2026-04-13)",
    script: "check-suite-dispatch",
  },
  {
    name: "check-dist-smoke",
    defends:
      "every published binary (apps/cli, packages/create-motebit) boots cleanly — catches bundling regressions before publish (invariant #12, added 2026-04-13 after @noble/hashes × @solana/web3.js slipped into apps/cli/dist/)",
    script: "check-dist-smoke",
  },
  {
    name: "check-service-primitives",
    defends: "services must route protocol plumbing through @motebit/mcp-server",
    script: "check-service-primitives",
  },
  {
    name: "check-app-primitives",
    defends: "apps must consume product vocabulary, not protocol primitives",
    script: "check-app-primitives",
  },
  {
    name: "check-affordance-routing",
    defends:
      "UI affordances (chips, buttons, slash commands, scene clicks) must invoke capabilities via `invokeCapability`, never by constructing natural-language prompts routed through the AI loop (invariant #15, added 2026-04-14 after the PR-URL chip showcase exposed the ambiguity of model-mediated routing)",
    script: "check-affordance-routing",
  },
  {
    name: "check-deletion-routes-through-privacy",
    defends:
      "every user-driven memory or conversation delete exits through the privacy-layer choke point (`runtime.privacy.delete{Memory,Conversation}`) so the action is signed (mutable_pruning / consolidation_flush cert), audited, and event-logged with `DeleteRequested` — locks the asymmetry where web/mobile bypassed the privacy layer pre-fix (sovereignty doctrine + retention-policy.md decision 5)",
    script: "check-deletion-routes-through-privacy",
  },
  {
    name: "check-deploy-parity",
    defends: "fly.toml ↔ deploy workflow ↔ .env.example ↔ source env reads",
    script: "check-deploy-parity",
  },
  {
    name: "check-changeset-discipline",
    defends:
      "every changeset has a substantive body (no empty / `auto-generated patch bump` stubs) AND every `major` changeset ships a non-empty `## Migration` section",
    script: "check-changeset-discipline",
  },
  {
    name: "check-deprecation-discipline",
    defends:
      "every `@deprecated` annotation in a *published* package carries the four-field contract (since, removed in, replacement, Reason:) and no `removed in` version is past-due (invariant #39, added 2026-04-24 — the gate candidate the deprecation-lifecycle doctrine named but hadn't shipped; locked in against 19 currently-passing sites; scoped to `version != 0.0.0-private` packages 2026-04-28 when the private sibling gate landed)",
    script: "check-deprecation-discipline",
  },
  {
    name: "check-private-deprecation-shape",
    defends:
      "every `@deprecated` annotation in a *private* (`0.0.0-private`) package drops the semver contract (`since`/`removed in` are theater inside a workspace with no versioning boundary) but keeps the replacement pointer + `Reason:` block (workspace callers still need them) — invariant #59, added 2026-04-28 after the bird's-eye audit caught 9 markers across 4 private packages making promises to nobody (residue from the 2026-04-23 four-field pass made stale by the 2026-04-24 sentinel-version flip on 51 internal packages); sibling to check-deprecation-discipline",
    script: "check-private-deprecation-shape",
  },
  {
    name: "check-credentials-submit-response-shape",
    defends:
      "every client-side caller of `POST /api/v1/agents/:id/credentials/submit` inspects the `{accepted, rejected, errors}` response body, not just `response.ok` — the relay returns HTTP 200 even when it server-side-rejects every credential in the batch (spec/credential-v1.md §23: self-issued, signature-failed, unknown-subject) so a status-only check reports success while the index never accepted anything; invariant #60, added 2026-04-28 after the post-mortem on the 2026-04-25 hardware-attestation revert (commit 63fa2199) found the same anti-pattern reincarnated in `packages/runtime/src/interactive-delegation.ts` post-revert (codifies the `lesson_hardware_attestation_self_issued_dead_drop` detector that the original incident named but never landed as code)",
    script: "check-credentials-submit-response-shape",
  },
  {
    name: "check-admin-route-auth",
    defends:
      "every `/api/v1/admin/*` route registered in `services/relay/src/` is covered by a matching `app.use(\"...\", bearerAuth({ token: apiToken }))` registration in `middleware.ts` — the admin surface's only access control is the master bearer, so a route registered without the matching middleware ships as a wide-open endpoint; invariant #61, added 2026-04-28 after the post-mortem on the same wave that produced #60 found `GET /api/v1/admin/transparency` had been wide open since 2026-04-14 with a JSDoc claim that contradicted reality (`audience-bound at the auth layer (admin:query)`), fixed manually in commit 2560472b — manual audits expire, gates don't",
    script: "check-admin-route-auth",
  },
  {
    name: "check-skill-script-uses-tool-approval",
    defends:
      "every TS file that reads bytes from a skill's quarantined `scripts/` tree, imports `node:child_process`, and calls a spawn primitive (`spawn`/`spawnSync`/`execFile`/`execFileSync`) MUST also call `approvalStore.add(...)` to enroll the invocation in the canonical operator approval queue — same `SqliteApprovalStore` the existing `motebit approvals list/show/approve/deny` surface reads. A parallel approval surface for skill scripts fragments the operator audit trail and breaks fail-closed-at-the-capability-boundary; invariant #69, added 2026-05-02 alongside the skills phase 2 quarantine arc that wired `motebit skills run-script` to this gate",
    script: "check-skill-script-uses-tool-approval",
  },
  {
    name: "check-tsup-uses-emit-decl-only",
    defends:
      "every workspace package whose `scripts.build` invokes `tsup` MUST pin `emitDeclarationOnly: true` in its own `tsconfig.json` `compilerOptions`. `tsconfig.base.json` sets `composite: true` so any package's `tsc -b` walks references and emits per-source `.js` into referenced projects' `outDir` — clobbering tsup's bundle. Caught after `@motebit/crypto@1.2.0` shipped to npm 2026-05-02 with an 8.9 KB unbundled `dist/suite-dispatch.js` (expected ~100 KB tsup bundle); standalone `npm install` failed at import time on `@noble/ed25519`. Hot-fix `1.2.1` pinned the flag in `packages/crypto/tsconfig.json`. Invariant #70, added 2026-05-02",
    script: "check-tsup-uses-emit-decl-only",
  },
  {
    name: "check-deposit-detector-confirmations",
    defends:
      "every CAIP-2 chain id in `USDC_CONTRACTS` (services/relay/src/deposit-detector.ts) has a matching positive-integer entry in `CONFIRMATIONS_BY_CHAIN`. The deposit detector's `confirmations` parameter is the reorg-safety mechanism — the cycle never crosses `currentBlock - confirmations`, so a chain reorg shallower than this depth cannot roll back a credit. Adding a USDC chain without a confirmation depth disables the detector for that chain (short-circuits with `deposit-detector.disabled`); a non-positive value reintroduces the legacy 0-confirmation behavior the gate exists to retire. Invariant #72, added 2026-05-02 alongside the deposit-detector confirmation-horizon refactor that prepares x402 mainnet activation",
    script: "check-deposit-detector-confirmations",
  },
  {
    name: "check-api-surface",
    defends:
      "@motebit/{protocol,crypto,sdk} public API must match committed baseline unless a `major` changeset is pending",
    script: "check-api-surface",
  },
  {
    name: "check-cli-surface",
    defends:
      "`motebit` CLI operator-facing surface (subcommand tree + top-level flag set) must match `apps/cli/etc/cli-surface.json` baseline unless a pending `motebit: major` changeset declares the break (invariant #46, added 2026-04-24 to close the rigor asymmetry between the Apache-2.0 protocol floor gated by check-api-surface and the BSL-1.1 `motebit` reference runtime whose 1.0 promise rested on changeset discipline alone until this gate shipped — first cut covers the two load-bearing sub-surfaces; exit codes, `~/.motebit/` layout, relay HTTP routes, and MCP server tool list are follow-up extractors against the same baseline file)",
    script: "check-cli-surface",
  },
  {
    name: "check-docs-tree",
    defends:
      "apps/docs/content/docs/operator/architecture.mdx directory tree mirrors the filesystem and scripts/check-deps.ts LAYER/PERMISSIVE_PACKAGES (invariant #13, added 2026-04-14 after the architecture page was rewritten and 9 packages were previously misplaced across invented tiers)",
    script: "check-docs-tree",
  },
  {
    name: "check-doc-counts",
    defends:
      "every numeric count claim in README.md, CLAUDE.md, and apps/docs/content/docs/operator/architecture.mdx (`N packages`, `N specs`, `N apps`, `N services`) matches the filesystem-derived truth (invariant #45, added 2026-04-24 after a presentation cleanup found three doc surfaces drifted independently — README claimed 36/12, root CLAUDE.md claimed 40/14, the docs site claimed 37/12; actual was 46/19. check-docs-tree validated the directory tree but not the prose counts that sit alongside it; this gate closes the prose-count half of the same invariant)",
    script: "check-doc-counts",
  },
  {
    name: "check-spec-permissive-boundary",
    defends:
      "every backticked callable referenced in spec/*.md is exported from a permissive-floor package (protocol/crypto/sdk) or explicitly waived with a reason (invariant #14, added 2026-04-14 after an external review asked whether protocol-only algorithms could leak into BSL; the probe caught deriveSyncEncryptionKey as a real leak and forced the spec to inline the HKDF recipe; renamed from check-spec-mit-boundary on 2026-04-23 with the Apache-2.0 floor flip)",
    script: "check-spec-permissive-boundary",
  },
  {
    name: "check-privacy-ring",
    defends:
      "every surface app (web/cli/desktop/mobile/spatial) declares and imports @motebit/event-log + @motebit/privacy-layer — the Ring 2 fail-closed privacy substrate the root CLAUDE.md claims as doctrine (invariant #16, added 2026-04-16 after the birds-eye audit caught web/spatial/cli missing one or both declarations)",
    script: "check-privacy-ring",
  },
  {
    name: "check-readme",
    defends:
      "README.md 'What you see:' block advertises the scaffold's first-run output — tool names, MCP port, --direct flag, relay URL — which must match create-motebit's agent template and runtime-factory's DEFAULT_SYNC_URL (invariant #24, added 2026-04-18 after a principal-engineer review found the README making aspirational promises with no gate; extends the self-attesting-system doctrine to the repo's front door)",
    script: "check-readme",
  },
  {
    name: "check-claude-md",
    defends:
      "every per-directory CLAUDE.md and every docs/doctrine/*.md is indexed in root CLAUDE.md (under 'Per-directory doctrine loads lazily' and 'Cross-cutting doctrine (read on demand)' respectively); same canonical-index drift class for both lists, one gate covers both — sub-doctrine is only discoverable through the root index, so an unindexed file is invisible to top-down readers (invariant #25, added 2026-04-18 after a birds-eye review found 6 package CLAUDE.md files silently absent; doctrine-list scope added 2026-04-27 after the cross-cutting-doctrine audit found hardware-attestation.md on disk but missing from the lazy-load index)",
    script: "check-claude-md",
  },
  {
    name: "check-skill-corpus",
    defends:
      "every committed reference skill under `skills/*` carries a body_hash, content_hash, and envelope signature that match what `pnpm --filter @motebit/skills build-reference-skill` would produce — closes the drift class where a contributor edits SKILL.md without re-signing and ships a tampered-looking artifact users would only catch at install time on their machine (added 2026-04-28 alongside spec/skills-v1.md ship)",
    script: "check-skill-corpus",
  },
  {
    name: "check-skill-cli-coverage",
    defends:
      "every public method on `SkillRegistry` (in `@motebit/skills`) is reachable through a `motebit skills <verb>` CLI subcommand — closes the drift class where a registry method ships but isn't wired into dispatch, leaving the registry surface unreachable from the user-facing CLI (added 2026-04-28 alongside spec/skills-v1.md ship)",
    script: "check-skill-cli-coverage",
  },
  {
    name: "check-readme-bin-claims",
    defends:
      "every README.md / CLAUDE.md `npm i -g <pkg>` / `npx <pkg>` invocation targets a workspace package whose package.json ships a `bin` field; defends against code-shaped prose drift after package role changes (invariant #51, full history in docs/drift-defenses.md)",
    script: "check-readme-bin-claims",
  },
  {
    name: "check-docs-cli-claims",
    defends:
      'every backtick-anchored `motebit <subcommand> [<sub>]` invocation in any README.md / CLAUDE.md / docs MDX page resolves to a real dispatch arm at the top level (apps/cli/src/index.ts) and the child level (inline `Xcmd === "Y"` patterns or apps/cli/src/subcommands/<name>.ts `subCmd === "Y"` patterns); defends against fabricated CLI invocations and obsolete flag-vs-subcommand shapes leaking into onboarding pages (invariant #54, full history in docs/drift-defenses.md)',
    script: "check-docs-cli-claims",
  },
  {
    name: "check-docs-slash-claims",
    defends:
      "every backtick-anchored `/<slash-command>` invocation in any README.md / CLAUDE.md / docs MDX page (excluding apps/desktop.mdx and apps/mobile.mdx, which describe surface-native GUI registries) resolves to a real entry in the `COMMANDS` array of apps/cli/src/args.ts; sibling to check-docs-cli-claims, closing the same drift class for the REPL slash-command surface (invariant #55, full history in docs/drift-defenses.md)",
    script: "check-docs-slash-claims",
  },
  {
    name: "check-docs-default-models",
    defends:
      'every default-context Claude model literal in any README.md / CLAUDE.md / docs MDX page (`"default_model": "X"` JSON, `--model X` CLI flag, `Default model: X` / `Examples: ... \\`X\\`` prose) matches the canonical default extracted from the `defaultModel` ternary in apps/cli/src/args.ts; defends against the stale-model-literal class that drifted four places after the 2026-04 sonnet-4-5 → sonnet-4-6 bump (invariant #56, full history in docs/drift-defenses.md)',
    script: "check-docs-default-models",
  },
  {
    name: "check-llms-txt-fresh",
    defends:
      "apps/docs/public/llms.txt and apps/docs/public/llms-full.txt match exactly what scripts/generate-llms-txt.ts would write from current source (docs MDX + DOCTRINE.md + the nine chain documents); same-shape gate as check-api-surface, applied to the LLM-facing surface, closes the freshness drift class where source MDX or a foundational doc was edited without rerunning the generator (invariant #57, full history in docs/drift-defenses.md)",
    script: "check-llms-txt-fresh",
  },
  {
    name: "check-doctrine-format",
    defends:
      "DOCTRINE.md's chain bullets match the canonical format the llms.txt generator parses (`N. **[FILENAME.md](FILENAME.md)** — derives X.`), the chain length matches the expected nine documents, every cited filename exists at the repo root, and no derives-clause is missing sentence punctuation; moves the failure earlier than the build-time throw in scripts/generate-llms-txt.ts so prose-only edits to DOCTRINE.md can't silently break the LLM-surface generation (invariant #58, full history in docs/drift-defenses.md)",
    script: "check-doctrine-format",
  },
  {
    name: "check-license-doc-sync",
    defends:
      "every workspace package.json declares a SPDX-canonical license (Apache-2.0 or BUSL-1.1) and the permissive-floor membership agrees across LICENSING.md (table + quick reference) and CONTRIBUTING.md; the canonical truth is the package.json license field, the prose surfaces are the siblings (invariant #52, full history in docs/drift-defenses.md)",
    script: "check-license-doc-sync",
  },
  {
    name: "check-tsup-define-conventions",
    defends:
      "every `__<NAME>_VERSION__` constant in any `tsup.config.ts` reads from the workspace package name implied by `<NAME>`; catches the misnamed-constant class that produced the create-motebit@1.1.0 scaffold-pin bug where `__VERIFY_VERSION__` actually read from `@motebit/crypto` and was reused to pin `@motebit/sdk` and `motebit` (invariant #53, full history in docs/drift-defenses.md)",
    script: "check-tsup-define-conventions",
  },
  {
    name: "check-scene-primitives",
    defends:
      "SpatialExpression renderers live in @motebit/render-engine, not inline in apps (invariant #26, added 2026-04-19 after CredentialSatelliteRenderer moved from apps/spatial to packages/render-engine so apps/web could consume the same renderer; extends the protocol-primitive doctrine to scene primitives — every surface with a 3D creature consumes one implementation)",
    script: "check-scene-primitives",
  },
  {
    name: "check-retrieval-primitives",
    defends:
      "memory-retrieval ordering (similarity + confidence + recency scoring) lives in @motebit/memory-graph's five recall* lenses, not inline in apps/services/packages (invariant #27, added 2026-04-19 after the semiring-driven retrieval landed deprecating the hand-rolled retrieve() method; extends the protocol-primitive doctrine to retrieval judgment — one graph, five lenses, one algorithm)",
    script: "check-retrieval-primitives",
  },
  {
    name: "check-reputation-primitives",
    defends:
      "reputation scoring (continuous 0-1 score from trust-record + recency decay) lives in @motebit/policy (basic) or @motebit/market (receipt-history composite), not inline in apps or services (invariant #28, added 2026-04-19 after apps/inspector/TrustPanel — then apps/admin — was caught with a reinvented formula that diverged from its claimed @motebit/policy source on the Beta-binomial prior — the surface showed different scores than AI-core computed for the same agent record; extends the protocol-primitive doctrine to reputation judgment)",
    script: "check-reputation-primitives",
  },
  {
    name: "check-notability-primitives",
    defends:
      "notability scoring (weighted combination of decay + graph-isolation + conflict-involvement, used to rank memories for reflection) lives in @motebit/memory-graph (rankNotableMemories + NotabilitySemiring), not inline in apps/services/sibling-packages (invariant #29, added 2026-04-19 when the reflection engine moved from three hand-sorted categories to one algebraic ranking — extends the protocol-primitive doctrine to reflection judgment, second semiring consumer after retrieval proves the pattern beyond routing)",
    script: "check-notability-primitives",
  },
  {
    name: "check-trust-propagation-primitives",
    defends:
      "multi-hop trust propagation across the credential graph (walk issuer→subject edges, product-along-chain × max-across-parallel under TrustSemiring) lives in @motebit/market (propagateTrust + buildTrustGraph), not inline in apps/services/sibling-packages (invariant #30, added 2026-04-19 as the third non-trivial semiring consumer beyond routing + retrieval/notability — locks in the pattern of one primitive, many callers, swappable algebra; prevents divergence between admin UI, AI-core, and market router on the propagated trust of the same agent)",
    script: "check-trust-propagation-primitives",
  },
  {
    name: "check-spec-impl-coverage",
    defends:
      "every Stable protocol spec has ≥1 implementing package declared via `motebit.implements` in package.json (invariant #31, added 2026-04-19 to extend the type-surface guarantees of #9/#14/#23 to runtime-behavior ownership — a Stable spec without a declared implementer is a silent gap between what we ship and what we claim third parties can implement; drafts exempt)",
    script: "check-spec-impl-coverage",
  },
  {
    name: "check-disambiguation-primitives",
    defends:
      "referent disambiguation (picking one candidate from a list by matching a fuzzy user input against a title/name/label field) lives in @motebit/semiring (matchOrAsk + stringSimilaritySignal + disambiguate), not inline in apps/services/sibling-packages (invariant #32, added 2026-04-19 as the fourth non-trivial semiring consumer — completes the endgame map's 'semiring wherever algebra is natural' line item; same drift family as #27/#28/#29/#30)",
    script: "check-disambiguation-primitives",
  },
  {
    name: "check-panel-controllers",
    defends:
      "Sovereign-panel state/fetch layer (credential dedup + revocation batch-check + sovereign balance + sweep-config state machine + credentials/ledger/budget/succession fetching) lives in @motebit/panels, not inline in apps/* / src/ui or src/components (invariant #33, added 2026-04-19 after desktop/web/mobile all migrated to createSovereignController — three surfaces had carried identical state logic expressed in three render substrates; extends the protocol-primitive doctrine to multi-surface panel state)",
    script: "check-panel-controllers",
  },
  {
    name: "check-consolidation-primitives",
    defends:
      "the four-phase consolidation cycle (orient + gather + consolidate + prune — clusters episodic memories, summarizes them via the LLM, forms semantic memories, tombstones the cluster sources) lives in packages/runtime/src/consolidation-cycle.ts; runtime consumers call runtime.consolidationCycle(); inline reinvention is forbidden (invariant #34, added 2026-04-20 alongside the unification of runHousekeeping + proactiveAction:'reflect' into one cycle — extends the protocol-primitive doctrine to proactive-interior judgment and prevents the third copy of the autoDream-shape loop from emerging in a new shape)",
    script: "check-consolidation-primitives",
  },
  {
    name: "check-tool-modes",
    defends:
      'every ToolDefinition literal declares a `mode: "api" | "ax" | "pixels"` field so the tool registry\'s cost-tier sort lands the AI\'s default choice on the cheapest structured tool that can answer (invariant #36, added 2026-04-22 as the hybrid-engine enforcement — structural bias, not prompt reasoning, keeps the AI from reaching for pixel screenshots when an MCP tool would have answered in 500 tokens; applies to packages/tools/src/builtins and app-level tauri-tools; MCP-imported tools default to api in packages/mcp-client)',
    script: "check-tool-modes",
  },
  {
    name: "check-mode-contract-readers",
    defends:
      "every field of the `EmbodimentModeContract` interface in packages/render-engine/src/spec.ts (driver / observer / source / consent / sensitivity / lifecycleDefaults) has ≥1 runtime reader OR an explicit ALLOWLIST entry with a `deferred until X` reason; closes the doctrine-to-code asymmetry where the contract's six invariants are compile-time enforced (the `satisfies Record<EmbodimentMode, EmbodimentModeContract>` clause prevents field omission per mode) but only `lifecycleDefaults` is actually consumed (slab-controller anomaly check, ebb232dd). The other five fields are typed-but-passive — doctrine in code, not driving behavior. Allowlist entries are visible debt; future PRs eat them down as concrete consumers arrive (invariant #76, added 2026-05-07 as the load-bearing-ness gate paired with EMBODIMENT_MODE_CONTRACTS landing in commit c947ff15).",
    script: "check-mode-contract-readers",
  },
  {
    name: "check-drop-handlers",
    defends:
      "two arms of the drag-drop substrate. (1) Coverage: every `DropPayloadKind` entry in the closed union (`packages/protocol/src/perception.ts`) MUST be either registered in `DropDispatcher`'s constructor (`packages/runtime/src/perception.ts`) OR named on the gate's `ALLOWLIST` with a deferral reason; v1 ships handlers for url/text/image, v1.1-deferred file/artifact sit on the allowlist. (2) Routing: every per-surface file capturing DOM drag-drop events (`document.addEventListener('drop', ...)`, `dataTransfer.getData(...)`, `onDragEnd` etc.) MUST call `runtime.feedPerception(...)`; constructing a prompt string and calling sendMessage is the prompt-backdoor failure mode named in motebit-computer.md §\"Failure modes specific to supervised agency.\" Same agility-as-role pattern as the suite-dispatch / tool-mode / mode-contract-readers gates: closure on the protocol surface + drift gate that asks role questions, not instance questions (invariant #77, added 2026-05-07 as the gesture-ship-companion gate when the v1 drag-drop substrate landed end-to-end across protocol + runtime + web surface).",
    script: "check-drop-handlers",
  },
  {
    name: "check-hardware-attestation-primitives",
    defends:
      'the canonical composer (`composeHardwareAttestationCredential` in @motebit/encryption) and verifier (`verifyHardwareAttestationClaim` in @motebit/crypto) are the only way to build or parse a HardwareAttestationClaim-carrying AgentTrustCredential — inline VC composers (type-tuple ["VerifiableCredential", "AgentTrustCredential"] + `hardware_attestation:` subject) and inline attestation_receipt parsers (.split(\'.\') / base64url decode / P-256 verify) are CI failures (invariant #37, added 2026-04-22 after the CLI+desktop consolidation and ahead of the iOS / Expo mobile surface landing — extends the protocol-primitive doctrine to hardware-attestation judgment, prevents the third inline copy of the VC envelope and the first inline copy of the receipt parser)',
    script: "check-hardware-attestation-primitives",
  },
  {
    name: "check-dom-id-references",
    defends:
      "every `document.getElementById(literal)` / `document.querySelector('#literal')` call in `apps/{desktop,web,admin}/src` resolves against an `id=\"literal\"` declared in the same app's index.html or TS source; waivers live in `scripts/check-dom-id-references.allow.json` with required reason strings (invariant #38, full history in docs/drift-defenses.md)",
    script: "check-dom-id-references",
  },
  {
    name: "check-preset-imports",
    defends:
      'canonical preset identifiers exported from `@motebit/sdk` (APPROVAL_PRESET_CONFIGS, ApprovalPresetConfig, COLOR_PRESETS, RISK_LABELS, DEFAULT_GOVERNANCE_CONFIG, DEFAULT_VOICE_CONFIG, DEFAULT_APPEARANCE_CONFIG) are not locally redeclared in any `apps/*/src` file. Re-export trampolines (`export { X } from "@motebit/sdk"`) are allowed; `const`/`interface`/`type`/`enum` redeclarations are CI failures (invariant #40, added 2026-04-24 after an audit found `apps/mobile/src/mobile-app.ts` had redefined `APPROVAL_PRESET_CONFIGS` with `balanced: { denyAbove: 4 }` while the SDK\'s canonical value was `denyAbove: 3` — same motebit identity, divergent governance posture per surface. Extends the sibling-boundary rule to the developer-contract surface: if it ships from `@motebit/sdk` as public API, no app is allowed to shadow it).',
    script: "check-preset-imports",
  },
  {
    name: "check-chat-tag-stripping",
    defends:
      "every inline `.replace(...)` against an internal-tag / prompt-injection-marker pattern (`<thinking>`, `<memory>`, `<state/>`, `[EXTERNAL_DATA]`, `[MEMORY_DATA]`) in apps or services must be colocated with an import of `stripInternalTags` / `stripPartialActionTag` from `@motebit/ai-core`; inline regex copies are CI failures (invariant #41, full history in docs/drift-defenses.md)",
    script: "check-chat-tag-stripping",
  },
  {
    name: "check-drift-defenses-inventory",
    defends:
      "every hard CI gate registered in `scripts/check.ts` GATES has a corresponding row in the inventory table in `docs/drift-defenses.md`; matches at gate-level (one row per script file is enough) and accepts npm aliases (invariant #44, full history in docs/drift-defenses.md)",
    script: "check-drift-defenses-inventory",
  },
  {
    name: "check-doc-diagrams",
    defends:
      "every `<DiagramFigure cites={[...]}>` entry in apps/docs/content/docs/**/*.mdx resolves to a real file (and a real `## N.` section header for spec/* targets), every committed apps/docs/public/diagrams/*.svg carries populated `<title>` + `<desc>`, and no diagram SVG carries a raw `#hex` color literal (theme-bind enforcement so dark mode tracks). Extends the self-attesting-system doctrine to doc-site visuals — every arrow in a committed diagram cites code or spec by URL-shaped reference, and the gate proves the reference resolves (invariant #49, added 2026-04-26 alongside the four-diagram landing as the diagram-grade analog of #14's permissive-floor citation discipline).",
    script: "check-doc-diagrams",
  },
  {
    name: "check-doc-private-imports",
    defends:
      'any `from "@motebit/<X>"` import in apps/docs/content/docs/**/*.mdx where X is a workspace-private package (`"private": true` in packages/X/package.json) MUST sit inside an explicit `<ReferenceExample>` JSX wrapper. The wrapper component frames the snippet as reference-implementation internal code and links to source on GitHub. Sibling to the changeset config\'s `ignore` list that locks the version-doctrine sentinel (commit fa5fdfeb pinned 51 private packages to 0.0.0-private — only the eleven published packages make stability promises, and private packages have no API surface to claim). This gate is the docs-side enforcement of the same boundary: prevents a developer doc page from showing `import from "@motebit/market"` as if external developers could npm-install it (invariant #50, added 2026-04-26 after the docs.motebit.com audit found three pages — budget-settlement, semiring-routing, mcp-server-via-delegation — leaking 13 private-package imports into the public surface).',
    script: "check-doc-private-imports",
  },
  {
    name: "check-trust-score-display",
    defends:
      "every Agents-panel renderer (apps/desktop/src/ui/agents.ts, apps/web/src/ui/gated-panels.ts, apps/mobile/src/components/AgentsPanel.tsx) reads the `hardware_attestation` field projected onto AgentRecord/DiscoveredAgent AND surfaces the verifier name via `formatHardwarePlatform` from `@motebit/panels` (invariant #64, added 2026-04-29 alongside HA badge ship 3 — closes the doctrine breach documented in `ha_surface_badge_agents_panel_gap` project memory: routing factors HA via `HardwareAttestationSemiring` but the user couldn't see WHICH peer was hardware-attested or by what verifier; ship 1 added panel types + helpers, ship 2 lit up the data flow, ship 3 + this gate lock in the surface render so a fourth surface or a regression on the badge can't reopen the gap).",
    script: "check-trust-score-display",
  },
  {
    name: "check-sensitivity-routing",
    defends:
      'every runtime method that invokes `runTurn` or `runTurnStreaming` in `packages/runtime/src/motebit-runtime.ts` calls `this.assertSensitivityPermitsAiCall()` first (invariant #65, added 2026-04-30 closing the doctrine drift class audited the same day — CLAUDE.md asserts "Medical/financial/secret never reach external AI" but `provider-resolver.ts` had zero sensitivity references and the runtime hardcoded `session_sensitivity: "none"`. The gate throws `SovereignTierRequiredError` before any provider call when session is medical/financial/secret AND provider is not sovereign — fail-closed before any bytes leave the device. Sibling to `CONTEXT_SAFE_SENSITIVITY` in ai-core (filters memory injection); this one closes the request-side gap).',
    script: "check-sensitivity-routing",
  },
  {
    name: "check-sqlite-migration-runner",
    defends:
      "schema-version advancement (`PRAGMA user_version = N`) only happens through `runMigrations` / `runMigrationsAsync` in `@motebit/sqlite-migrations`, never inline at a call site (invariant #66, added 2026-04-30 closing the migration-ladder drift class — three SQLite surfaces (mobile expo-sqlite, desktop Tauri-IPC rusqlite, persistence better-sqlite3 / sql.js) had three independently-evolved ladders with three different version lines, three different error-swallow disciplines, and two of three had no transaction wrapping. The runner is the canonical source of truth; surfaces register `Migration` entries against per-surface registries and the runner advances the pragma. Three legitimate driver-internal pragma sites are allowlisted with reasons: the runner itself, the sql.js driver pragma() implementation, and the desktop async driver shim setUserVersion.",
    script: "check-sqlite-migration-runner",
  },
  {
    name: "check-retention-coverage",
    defends:
      "every runtime-side store with a `sensitivity` column or settlement obligation registers a `RetentionShape` in `RUNTIME_RETENTION_REGISTRY` (`packages/protocol/src/retention-policy.ts`), and every registered store has a matching at-rest schema in at least one runtime-side surface. Bidirectional drift check: stale-registry (registered store with no matching CREATE TABLE) and unregistered-table (CREATE TABLE with `sensitivity` column not in the registry) both fail (invariant #67, added 2026-04-30 closing the meta-version of the original CLAUDE.md gap — \"fail-closed privacy\" claimed retention enforcement existed; today the consolidation cycle's flush phase enforces, but a future schema adding `sensitivity TEXT` without registering would leak past the doctrinal ceiling because the cycle's flush phase doesn't see unregistered stores. Same enforcement pattern as `check-consolidation-primitives` (#34) and `check-suite-declared` (#10).",
    script: "check-retention-coverage",
  },
  {
    name: "check-relay-retention-coverage",
    defends:
      "every entry in the relay's `RETENTION_MANIFEST_CONTENT.stores[]` projection has a matching alias in `RELAY_STORE_TABLE_ALIASES` and a CREATE TABLE in `services/relay/src/`, and every alias has a matching manifest entry plus DDL. Sibling to #67 but scoped to relay-hosted operational ledgers (relay_execution_ledgers, relay_settlements, relay_credential_anchor_batches, relay_revocation_events, relay_disputes) rather than runtime-side stores (invariant #68, added 2026-05-01 with phase 4b-3 commit 5 — `RETENTION_MANIFEST_CONTENT.stores[]` graduated from empty to enumerating five operational ledgers under `append_only_horizon` once the federation co-witness handshake landed; bidirectional gate prevents the symmetric failure modes that #67 prevents on the runtime side: a manifest declaration of an enforcement that doesn't exist, or a future operational ledger that ships a CREATE TABLE without the corresponding manifest projection — operator's transparency claim \"every retention-obligated store is declared\" silently rotting either way).",
    script: "check-relay-retention-coverage",
  },
  {
    name: "check-skills-cross-surface",
    defends:
      "every shipping surface wires a `SkillRegistry` over its platform's storage adapter — web (`apps/web/src/web-app.ts` constructs `new SkillRegistry(...)` over `IdbSkillStorageAdapter`); desktop (`apps/desktop/src/ui/skills.ts` routes through `TauriIpcSkillsPanelAdapter` in production or `InRendererSkillsPanelAdapter` in dev-mode); mobile (`apps/mobile/src/adapters/expo-sqlite.ts` defines `ExpoSqliteSkillStorageAdapter`, ships ahead of the panel UI). Skills are permission-orthogonal procedural knowledge per `spec/skills-v1.md` §1 and belong on every surface; without this gate a surface could ship the panel UI but silently fail to wire the registry, rendering an empty list forever (invariant #73, added 2026-05-04 with the cross-surface skills landing — closes the gap that motivated `feedback_no_separate_pages` for the skills domain specifically: install + lifecycle has to work everywhere or it works nowhere). Tightens for mobile once the panel UI lands; the shipping-dormant adapter is the surface's commitment in the meantime.",
    script: "check-skills-cross-surface",
  },
  {
    name: "check-package-browser-entry",
    defends:
      'no browser-reachable workspace package\'s top-level `src/index.ts` re-exports from a sibling file that eagerly imports `node:*` at module top. Vite dev mode evaluates ES modules eagerly; vite serves browser-externalized `node:*` stubs that throw on property access — destructuring (`import { closeSync } from "node:fs"`) crashes the page at module-evaluation time, before any caller code runs. `"sideEffects": false` only helps production builds. The skills package broke this convention for one commit cycle (Commit 2 of the cross-surface skills arc, 2026-05-04) — `index.ts` re-exported `NodeFsSkillStorageAdapter` from `fs-adapter.ts`, web bundle picked it up via `import { SkillRegistry } from "@motebit/skills"`, the destructure of node:fs threw during bootstrap, and `app.bootstrap()` never ran (HUD chips mounted statically; canvas stayed empty because the renderer\'s animation loop never started). Hot-fix split the entry: bare `@motebit/skills` is browser-safe, `@motebit/skills/node-fs` carries the Node-only adapter. The convention was already established by `@motebit/core-identity`\'s `node.ts` sub-entry and `@motebit/ai-core`\'s explicit comment naming `loadConfig` as direct-file-path-only; skills was the exception. Source-walk reachability rooted at `apps/web/src/**/*.ts` and `apps/desktop/src/**/*.ts` — strips block + line comments before tracing imports so JSDoc examples don\'t count as real reachability. (Invariant #74, added 2026-05-04 alongside the skills hot-fix as the sibling-boundary follow-up.)',
    script: "check-package-browser-entry",
  },
  {
    name: "check-computer-use-dispatcher-parity",
    defends:
      "every `ComputerActionKind` declared in `packages/protocol/src/computer-use.ts` is handled by BOTH `ComputerPlatformDispatcher` producers — desktop Tauri Rust (`apps/desktop/src-tauri/src/computer_use.rs`) and cloud Playwright (`services/browser-sandbox/src/action-executor.ts`) — or carries an explicit ALLOWLIST entry naming the missing producer + a `deferred until X` reason. Two dispatchers implementing the same wire format is the v1 architecture per `spec/computer-use-v1.md` §8.1; the symmetry is load-bearing because a desktop-only kind silently breaking on cloud (or vice versa) would fragment the audit trail at the format boundary. The protocol type union catches missing handlers in TS at compile time but the Rust dispatcher is outside the TS type system, and the Playwright executor's `default: never` arm only fires at runtime — neither catches the inverse direction (one producer adding a kind the other forgot). Symmetric inverse arm: a kind handled by a producer but absent from the protocol fires as an orphan. (Invariant #78, added 2026-05-07 alongside the cloud-browser-sandbox second-producer landing.)",
    script: "check-computer-use-dispatcher-parity",
  },
  {
    name: "check-computer-dispatcher-modes",
    defends:
      'every site that registers the `computer` tool must stamp an explicit `embodimentMode` on the registered `ToolDefinition` (or join the `ALLOWLIST` with a `deferred until X` reason). The `computer` tool name is shared across physically distinct dispatchers — cloud-browser (apps/web → CloudBrowserDispatcher, isolated Chromium) is the `virtual_browser` embodiment per `motebit-computer.md` §"Embodiment modes"; OS-drive (apps/desktop → Tauri Rust bridge, real OS) is the `desktop_drive` embodiment. Without the stamp, the runtime\'s `projectSlabForTurn` falls through to `tool-policy.ts`\'s generic `tool_result` floor — sensitivity routing remains honest (`tier-bounded-by-tool` composes), but the embodiment-mode contract silently under-claims and the slab gets the wrong consent boundary, lifecycle defaults, and downstream affordances. The doctrine names this exact failure: "Mode mixed into kind. Don\'t rename `fetch` to `virtual_browser_fetch`. Kind is the fine-grained shape of the content; mode is the coarse-grained embodiment category." The fallback safe-floor in `tool-policy.ts` is intentionally name-keyed and surface-blind — it exists for unknown future callers (e.g. an MCP-imported `computer` tool from a federation peer), not as a dispenser for surfaces that should know their own embodiment. (Invariant added 2026-05-08 alongside the per-dispatcher mode stamping landing — v1.1 of the virtual_browser arc.)',
    script: "check-computer-dispatcher-modes",
  },
  {
    name: "check-doctrine-citations",
    defends:
      "every backtick-delimited path-shaped reference (≥1 `/`, ends in `.ts`/`.tsx`/`.md`/`.json`/`.toml`/`.js`/`.mdx`/`.yml`/`.yaml`) in `docs/doctrine/*.md` resolves to a real file, and every `check-X` reference resolves to a registered drift gate (either `scripts/check-X.ts` or a `check-X` script in root `package.json`). Fourth member of the doc-citation-validation family (`check-readme-bin-claims`, `check-docs-cli-claims`, `check-docs-slash-claims` are siblings), same enforcement shape applied to architectural doctrine. Why: the 2026-05-10 audit found three doctrine docs (settlement-rails, self-attesting-system, agility-as-role) citing paths that had moved during package extraction (`services/relay/src/__tests__/custody-boundary.test.ts` → `packages/settlement-rails/src/__tests__/`) or gate names that never existed (`check-floor-license`, `check-package-license`). Doctrine cites code as proof of structural claims; a stale citation is the doctrine lying about what's enforced. The gate makes doctrine-vs-code coherence self-healing. Allowlist accepts two legitimate classes (`PATH_ALLOWLIST`, `GATE_ALLOWLIST`): anticipated future artifacts (deferred specs/gates the doctrine names ahead of their landing) and historical references (past-tense narration of deleted files); URL paths (`/.well-known/…`) are excluded by regex shape (must not start with `/`). Adding a new entry is intentional: a typo or stale reference belongs in the doctrine fix, not the allowlist.",
    script: "check-doctrine-citations",
  },
  {
    name: "check-audience-canonical",
    defends:
      'every `aud: "<literal>"`, `aud === "<literal>"`, `aud !== "<literal>"`, `createSyncToken("<literal>")`, and `createCallerToken("<literal>")` site in `packages/`, `services/`, `apps/` carries a literal that is a member of the closed `TokenAudience` registry in `@motebit/protocol/src/audience.ts` (15 audiences today: `sync`, `device:auth`, `pair`, `rotate-key`, `push:register`, `task:submit`, `admin:query`, `proposal`, `account:{balance,deposit,withdraw,withdrawals,checkout}`, `browser-sandbox-grant`, `browser-sandbox`). Pre-registry, a signing-site typo (`aud: "task:sumbit"`) was a runtime 401 at the verifier — same fail-loud semantics, but the only signal was the wire round-trip; the doctrine in `services/relay/CLAUDE.md` Rule 5 listed six audiences while code used fifteen. Closure pattern, same as `SuiteId` (`check-suite-declared` + `check-suite-dispatch`): closed protocol-level registry + drift gate that asks role questions, not instance questions. Sibling-alignment check verifies `CANONICAL_AUDIENCES` mirrors `ALL_TOKEN_AUDIENCES`; a registry update without a gate update is itself a CI failure. Adding an audience: union entry + named constant + `ALL_TOKEN_AUDIENCES` + `CANONICAL_AUDIENCES` in this gate + doctrine update at `services/relay/CLAUDE.md` Rule 5.',
    script: "check-audience-canonical",
  },
  {
    name: "check-artifact-type-canonical",
    defends:
      'every `artifact_type: "<literal>"`, `artifactType: "<literal>"`, and equality-check site in `packages/`, `services/`, `apps/` carries a literal that is a member of the closed `ContentArtifactType` registry in `@motebit/protocol/src/artifact-type.ts` (12 types today, one per state-export endpoint in `services/relay/src/state-export.ts`). Pre-registry, `artifact_type` on `ContentArtifactManifest` was a free string and the manifest JSDoc carried three example values; a producer-site typo (`artifact_type: "audit_trail"`) was a verifier-side classification miss with no compile-time signal. Same closure pattern as `TokenAudience` (`check-audience-canonical`) and `SuiteId` (`check-suite-declared` + `check-suite-dispatch`). Sibling-alignment check verifies `CANONICAL_ARTIFACT_TYPES` mirrors `ALL_CONTENT_ARTIFACT_TYPES`; a registry update without a gate update is itself a CI failure. Adding a type: union entry + named constant + `ALL_CONTENT_ARTIFACT_TYPES` + `CANONICAL_ARTIFACT_TYPES` in this gate + doctrine update at `docs/doctrine/nist-alignment.md` §8.',
    script: "check-artifact-type-canonical",
  },
  {
    name: "check-state-export-signed",
    defends:
      'every `app.get(...)` registration in `services/relay/src/state-export.ts` MUST call `emitSignedExport(c, "<artifact-type>", body)` before returning so the response carries an outer relay-asserted `ContentArtifactManifest` in the `X-Motebit-Content-Manifest` HTTP header. Closes the doctrine §8 coherency gap (`docs/doctrine/nist-alignment.md`): pre-this-gate, 1 of 12 state-export endpoints was signed while the doctrine claimed "shipped." Sixth closed-registry / structural-lock gate in the state-export-signing series (after `check-suite-declared`, `check-suite-dispatch`, `check-tool-modes`, `check-audience-canonical`, `check-artifact-type-canonical`). The gate also performs a sibling-alignment check that the `emitSignedExport` helper symbol is declared in the file — a rename or extraction without updating the gate would break detection silently. Adding a state-export endpoint requires routing through the helper; new artifact types require a registry append in `packages/protocol/src/artifact-type.ts` (cross-locked by `check-artifact-type-canonical`).',
    script: "check-state-export-signed",
  },
  {
    name: "check-state-export-consumer-verifies",
    defends:
      'every source file in `apps/` or `packages/` that contains a state-export URL template (`/api/v1/{state|memory|audit|goals|plans|conversations|devices|gradient|sync|execution}/${...}`) MUST import from `@motebit/state-export-client` so the producer-signed `X-Motebit-Content-Manifest` header is verified against the response body. Seventh closed-registry / structural-lock gate, completing the producer-consumer-gate triple for the state-export-signing arc (producer #86 `check-state-export-signed`, registry #85 `check-artifact-type-canonical`, consumer this gate). Pre-this-gate, the producer signed but no consumer demanded the signature — invisible truth: a relay that silently stops signing breaks no shipping consumer, and the doctrine\'s "self-attesting" claim collapses into ceremony. The gate scans `apps/*` and `packages/*` source for the template-literal URL shape, excludes the producer (`services/relay/src/state-export.ts`) and the verifier package itself, allowlists declarative references (registry docs in `packages/protocol/src/artifact-type.ts`) and pending-wiring consumers (e.g. `packages/panels/src/sovereign/controller.ts` until its surface adapters wrap the verifier).',
    script: "check-state-export-consumer-verifies",
  },
  {
    name: "check-transparency-onchain-anchored",
    defends:
      'every relay startup file (`services/relay/src/index.ts`) that constructs a `SolanaMemoSubmitter` MUST also call `anchorTransparencyDeclaration` so the operator-transparency declaration\'s hash is committed onchain via the Memo program. Closes the trust-on-first-use (TOFU) "savant gap" on `/.well-known/motebit-transparency.json`: without an onchain anchor, the first fetch trusts HTTPS + DNS + CAs — a DNS hijack or malicious ISP can substitute a different declaration whose self-signature verifies (against the attacker\'s key). With the anchor, a verifier with the relay\'s pinned anchor address (`@motebit/state-export-client::lookupTransparencyAnchor`) cross-checks the declaration hash against a Solana memo at that address — a second channel the network provider cannot tamper with. The gate is narrow on purpose (the relay startup file is the unique trust-anchor surface); Solana submitters constructed elsewhere (tests, scripts) are not forced to anchor. Doctrine: `docs/doctrine/operator-transparency.md` § Stage 2 onchain anchor (lifted forward 2026-05-11, decoupled from the multi-operator wire-format spec); `docs/doctrine/nist-alignment.md` §8 "savant gap closure".',
    script: "check-transparency-onchain-anchored",
  },
  {
    name: "check-transparency-processors-canonical",
    defends:
      'every external hostname the relay/proxy actually contacts at runtime (collected by source-walking `services/{proxy,relay}/src/` for `"https://X/..."` literals, minus motebit-owned hosts) MUST be (a) mapped to a processor name in this gate\'s `HOSTNAME_TO_PROCESSOR` registry, and (b) the processor name MUST appear in `DECLARATION_CONTENT.third_party_processors` in `services/relay/src/transparency.ts` (which backs both `services/relay/PRIVACY.md` and the signed `/.well-known/motebit-transparency.json`). Stale gate-map entries (host in registry but no longer in code) also fire. Closes the services/relay/CLAUDE.md Rule 10 enforcement gap: pre-this-gate, Rule 10 was code-review-only, and the OpenAI + Google proxy routing landed without the declaration moving — drift caught externally by a third-party audit on 2026-05-13, not by any motebit gate. Same closed-registry / structural-lock shape as `check-suite-declared` (#10), `check-audience-canonical` (#46), `check-artifact-type-canonical` (#85), `check-state-export-signed` (#86). Closes the third drift class in the operator-transparency family (alongside #75 transparency-onchain-anchored). Adding a new external host: code adds `fetch(...)`; gate `HOSTNAME_TO_PROCESSOR` adds the mapping; `transparency.ts` adds the processor entry; regenerate `PRIVACY.md` from `renderMarkdown()`. Failure to do any one step breaks the gate.',
    script: "check-transparency-processors-canonical",
  },
  {
    name: "check-publishable-package-metadata",
    defends:
      'every publishable `package.json` (any direct subdirectory of `packages/`, `apps/`, `services/` where `private !== true` AND `version !== "0.0.0-private"`) MUST carry the canonical metadata block sigstore provenance + the npm registry require: `repository.type === "git"`, `repository.url === "https://github.com/motebit/motebit"`, `repository.directory` present AND matching the package\'s path relative to repo root, and a `license` field. Closes the `state-export-client@0.2.0` (2026-05-13) recurrence class: the package shipped under a `minor` Changeset bump without a `repository` block; sigstore provenance refused to attest the publish (`could not resolve provenance metadata`); the release failed mid-pipeline; the fix was applied by hand to one file. Pre-this-gate, the metadata block was a copy-paste convention living in 6+ shipping package.json files with no structural enforcement. Same closed-registry / structural-lock shape as `check-suite-declared` (#10), `check-audience-canonical` (#46), `check-artifact-type-canonical` (#85), `check-state-export-signed` (#86), `check-transparency-processors-canonical` (#92): the gate asks role questions (does this publishable package have the metadata sigstore needs?), not instance questions, and the publishable set is filesystem-derived so new publishable packages pick up enforcement automatically. SPDX validity is a sibling concern (`check-license-doc-sync`); this gate only enforces field presence + the canonical repository pin. Four grouped failure modes: `missing_repository`, `malformed_repository` (wrong type/url or missing directory), `directory_mismatch` (directory value does not match path), `missing_license`. Doctrine: `docs/doctrine/promoting-private-to-public.md`, `docs/doctrine/release-versioning.md`.',
    script: "check-publishable-package-metadata",
  },
  {
    name: "check-slab-chrome-coverage",
    defends:
      'the slab chrome\'s render is `f(controlState × embodimentMode)` (`docs/doctrine/chrome-as-state-render.md` § "The principle"); every surface that mounts a slab dispatcher MUST dispatch against the full matrix shape. Closed-registry / structural-lock pattern (same shape as #79 `check-universal-slash-coverage`, #10 `check-suite-declared`, #46 `check-audience-canonical`, #85 `check-artifact-type-canonical`, #92 `check-transparency-processors-canonical`, #93 `check-publishable-package-metadata`). `SLAB_SURFACES` is the closed inventory of dispatcher-bearing surfaces (web shipped 2026-05-12, mobile + spatial shipped 2026-05-13); `CONTROL_STATES` is the closed `ControlState` union; `DEFERRED_EMBODIMENT_MODES` is the closed list of columns named in the matrix but deferred to PR N. The gate asserts (1) each surface\'s dispatcher file + entry-point exists, (2) every control state appears as a backtick/quote-quoted literal in the dispatcher\'s source (handling, not just declaration — JSDoc-named cells count, matching the doctrine\'s "named in the matrix" contract), (3) every deferred embodiment is referenced. Lifts the doctrine from one-instance-deep (web alone) to generalizable pattern: a future slab surface (desktop, spatial AR-glasses) added to SLAB_SURFACES forces the gate to demand every cell be named in the new dispatcher\'s source. Adversarial probe: rewriting every `paused` literal in `apps/mobile/src/slab-chrome.ts` to `PAUSED_REMOVED` (the structural-erasure drift, where both code and JSDoc forget about the cell) makes the gate flag `control state "paused" not handled in apps/mobile/src/slab-chrome.ts` and exit non-zero; restoring returns the clean `3 surface(s) × 4 control state(s) + 5 deferred embodiment(s)` line. Doctrine: `docs/doctrine/chrome-as-state-render.md` § "Spatial-as-endgame validation" + § "PR 3 scope (spatial)."',
    script: "check-slab-chrome-coverage",
  },
  {
    name: "check-event-type-canonical",
    defends:
      "the three-way structural lock for the `EventType` closed registry: the `EventType` enum (`packages/protocol/src/index.ts`) × `ALL_EVENT_TYPES` (`packages/protocol/src/event-type.ts`) × the gate's own `EVENT_TYPES_REFERENCE` mirror MUST agree exactly on the 59-entry vocabulary. Plus wire-format compliance: every value MUST be snake_case identifier-shaped so JSON serializers round-trip identically across implementations. `EventType` is the event-log substrate's discriminator — every `EventLogEntry` carries an `event_type` field consumed by sync peers, federation participants, audit verifiers, and consolidation cycles. Sixth registered registry per `docs/doctrine/registry-pattern-canonical.md` — the meta-gate's first template-growth proof (`REGISTERED_REGISTRIES` was 5 → 6 in the same arc as this gate's landing, validating the doctrine's claim that adding a sixth registry is mechanical, not new design). The gate does NOT include a per-consumer literal scan because `EventType` is consumed predominantly via `EventType.X` enum-member access (TS catches typos at compile time) and the `event_type` field name is overloaded (e.g. `packages/policy/src/audit.ts` uses it for the audit-chain's separate discriminator) — a broad textual scan would generate false positives. The value-add over TS enforcement is the three-way sibling lock + wire-format compliance: a registry rotation that adds an enum entry without updating `ALL_EVENT_TYPES` would pass `tsc` but break the iteration-array contract every consumer downstream relies on. Same closed-registry / structural-lock shape as `check-suite-declared` (#10), `check-audience-canonical` (#46), `check-artifact-type-canonical` (#85), `check-routing-decision-coverage` (#95), `check-panel-registry-coverage` (#96), `check-sensitivity-canonical` (#97).",
    script: "check-event-type-canonical",
  },
  {
    name: "check-settlement-mode-canonical",
    defends:
      "the three-way structural lock for the `SettlementMode` closed registry: the `SettlementMode` union (`packages/protocol/src/settlement-mode.ts`) × `ALL_SETTLEMENT_MODES` (same file) × the gate's own `SETTLEMENT_MODES_REFERENCE` mirror MUST agree exactly on the 2-entry vocabulary (`relay` for relay-mediated virtual-account settlement, `p2p` for direct onchain settlement). Plus wire-format compliance: every value MUST be lowercase identifier-shaped so JSON serializers round-trip identically across implementations. `SettlementMode` discriminates how money moves for an agent task — relays route on it (`SettlementEligibility.mode`), discovery declares it (`AgentDiscovery.settlement_modes[]`), peer negotiation depends on agreement. Seventh registered registry per `docs/doctrine/registry-pattern-canonical.md` — the second template-growth proof after `EventType` shipped 2026-05-14 (`REGISTERED_REGISTRIES` was 6 → 7 in the same arc as this gate's landing, further validating the doctrine's claim that adding a registry is mechanical at this point). The value-add over TS enforcement is the three-way sibling lock + wire-format compliance: a registry rotation that adds a union arm without updating `ALL_SETTLEMENT_MODES` would pass `tsc` but break the iteration-array contract every consumer downstream relies on. Same closed-registry / structural-lock shape as `check-suite-declared` (#10), `check-audience-canonical` (#46), `check-artifact-type-canonical` (#85), `check-routing-decision-coverage` (#95), `check-panel-registry-coverage` (#96), `check-sensitivity-canonical` (#97), `check-event-type-canonical` (#99).",
    script: "check-settlement-mode-canonical",
  },
  {
    name: "check-goal-artifact-signing",
    defends:
      'every registered per-surface goal-runner (`apps/web/src/goals-runner.ts`, `apps/desktop/src/goal-scheduler.ts`, `apps/mobile/src/goal-scheduler.ts`) MUST call `runtime.signGoalArtifact(content, { goalId, runId })` so goal-fire artifacts ship as signed `ContentArtifactManifest` per `docs/doctrine/goal-results.md` §"The three categories" and the `receipts-unified.md` commitment that artifacts crossing cryptographic-provenance boundaries carry a manifest. Without this gate, a refactor that drops the call from one surface (or a new surface that adds a goal-fire loop without signing) regresses silently — TypeScript treats `signGoalArtifact` as optional from the runtime\'s perspective. The closed inventory `REGISTERED_GOAL_RUNNERS` lists the canonical fire-loop site per surface; ALLOWLIST documents surfaces that intentionally defer (empty at land — every registered surface signs). The Phase-3 close that wired signing across all three flat surfaces shipped 2026-05-14 (commits 2428248a → 347b8461 → 8b547f3f → 714d7e38); this gate locks the cross-surface invariant the arc established. Same load-bearing shape as `check-drop-handlers` (#48): inventory of registered surfaces × required runtime-API call per surface. Doctrine: `docs/doctrine/goal-results.md`.',
    script: "check-goal-artifact-signing",
  },
  {
    name: "check-closed-registry-canonical",
    defends:
      'the meta-invariant over the family of closed-registry-coverage gates: every entry in `REGISTERED_REGISTRIES` (the closed inventory of interop-law typed vocabularies — `SuiteId`, `TokenAudience`, `ContentArtifactType`, `TaskShape`, `SensitivityLevel`, `EventType`, `SettlementMode`) MUST carry the canonical eight-artifact set: closed-type + frozen-iteration-array (`ALL_X`) + type-guard (`isX`) + test-file exercising both + per-registry coverage gate + gate registration in `scripts/check.ts` + perturbation probe in `scripts/check-gates-effective.ts` + inventory entry in `docs/drift-defenses.md`. Plus one soft check (doctrine-citation: at least one doctrine memo or package CLAUDE.md references the registry by name; warns but does not fail since the inverse direction is already enforced by `check-doctrine-citations`). The meta-gate watches the *family*, not any individual registry — per-registry gates carry domain-specific consumer-coverage enforcement (literal-typo scans, consumer-shape verification, per-(consumer × decision-kind) matrices); this gate locks the structural perimeter that those gates rest on. Two layers of lock: per-registry gates lock the registry; this gate locks the gates. Adding a registry to `REGISTERED_REGISTRIES` is intentional protocol-level work — every entry must satisfy the criteria in `docs/doctrine/registry-pattern-canonical.md` §"When to add a registry" (interop law, multi-consumer, wire-format presence, real drift incident). Same closed-registry / structural-lock shape as the gates it watches, applied one level up. The lattice\'s unit cell, formalized as a CI invariant. Doctrine: `docs/doctrine/registry-pattern-canonical.md`.',
    script: "check-closed-registry-canonical",
  },
  {
    name: "check-sensitivity-canonical",
    defends:
      "the four-way structural lock for the `SensitivityLevel` closed registry (enum in `packages/protocol/src/index.ts` × `ALL_SENSITIVITY_LEVELS` × `SENSITIVITY_RANK` in `packages/protocol/src/sensitivity.ts` × the gate's own `LEVELS_REFERENCE` mirror). The privacy ladder is the most load-bearing closed registry in motebit — every fail-closed privacy decision derives from this 5-tier set; cross-implementation gating must agree on which tier dominates which or the protocol isn't interoperable. Pre-this-gate, `SensitivityLevel` was the only top-tier closed registry without the `ALL_X` + `isX` iteration + guard pair (the registry-gate-family audit on 2026-05-14 surfaced this asymmetry alongside the panels-registry arc landing). The enum is preserved for back-compat with the ~900 pre-existing literal sites; this gate locks the structural perimeter so the debt cannot grow. Per-consumer coverage: a closed inventory of CONSUMERS (the algebra home in `sensitivity.ts`, the runtime egress-write floor `CONTEXT_SAFE_SENSITIVITY` in `packages/runtime/src/motebit-runtime.ts`, the computer-tool sensitivity classifier in `packages/policy-invariants/src/computer-sensitivity.ts`) MUST either enumerate every tier as a literal OR route through the canonical algebra primitives (`rankSensitivity`, `maxSensitivity`, `sensitivityPermits`). The graduation of `policy-invariants/computer-sensitivity.ts` from a fourth-shaped local `LEVEL_RANK` + `higherLevel` table to the protocol algebra shipped in the same arc — the gate's first violation on landing. Same closed-registry / structural-lock shape as `check-suite-declared` (#10), `check-audience-canonical` (#46), `check-artifact-type-canonical` (#85), `check-routing-decision-coverage` (#95), `check-panel-registry-coverage` (#96). Doctrine: `docs/doctrine/retention-policy.md` § \"Sensitivity ceilings as interop law\"; the `Fail-closed privacy` principle in `CLAUDE.md`.",
    script: "check-sensitivity-canonical",
  },
  {
    name: "check-panel-registry-coverage",
    defends:
      "every panel id in `SIDE_RAIL_PANELS` (`packages/panels/src/registry.ts`) has a mount-site on each flat surface (web / desktop / mobile). Closed-registry / structural-lock pattern (same shape as #79 `check-universal-slash-coverage`, #94 `check-slab-chrome-coverage`, #95 `check-routing-decision-coverage`). The registry is the typed source of truth per `docs/doctrine/panel-temporal-registers.md`; a surface that silently drops a panel reopens the per-surface drift window the registry exists to close. Per-(panel × surface) the gate verifies a concrete fingerprint string in a known consumer file — controller initializer (`initSovereignPanels`, `initCapabilities`), controller factory (`createMemoryController`, `createAgentsController`), runner accessor (`getGoalsRunner`), or React component import (`SovereignPanel`, `CapabilitiesPanel`). Sibling-alignment: `PANEL_MOUNT_SITES` keys mirror `SIDE_RAIL_PANELS` ids exactly — a registry append without gate update fails the gate. Mobile component naming follows the canonical plural registry id (`ConversationsPanel`, not `ConversationPanel`); the canonical-plural rename closed a singular/plural drift on 2026-05-14 in the same arc as this gate's landing. The gate does NOT enforce the mode of opening (HUD button / URL route / state sheet) — that's per-panel design (e.g. web's Capabilities is URL-driven, `/capabilities` route, no HUD button). The structural invariant is mount-site existence, not opening affordance. Doctrine: `docs/doctrine/panel-temporal-registers.md`, `docs/doctrine/panel-presentation-modes.md`, `docs/doctrine/records-vs-acts.md`.",
    script: "check-panel-registry-coverage",
  },
  {
    name: "check-routing-decision-coverage",
    defends:
      'the auto-router\'s protocol primitive `dispatchRouting` (`packages/policy/src/auto-router.ts`) is consumed by a closed inventory of CONSUMERS — surfaces that need to pick a model for a task. Every registered consumer MUST import `dispatchRouting` from `@motebit/policy`, invoke it, AND reference every `RoutingDecision.kind` discriminator value (`route`, `fallback`, `deny`) in source. Closed-registry / structural-lock pattern (same shape as #79 `check-universal-slash-coverage`, #94 `check-slab-chrome-coverage`). PR 1 (2026-05-13) registers motebit-cloud\'s proxy as the first consumer; PR 2 adds BYOK; PR 3 adds on-device — the three-instance-deep endgame validates the matrix-as-primitive doctrine for routing decisions (mirror of chrome-as-state-render\'s web/mobile/spatial rollout). The gate does NOT scan TaskShape literals — the dispatcher\'s exhaustive switch with `never` fallthrough enforces per-shape coverage at compile time; redundant gate would be ceremony. Structural value is the consumer registry: a "rogue" consumer that inlines routing logic without consuming `dispatchRouting` fails the gate. Sibling-alignment: `TASK_SHAPES_REFERENCE` in this gate mirrors `ALL_TASK_SHAPES` from `@motebit/protocol`; a registry append without gate update is itself a CI failure. Adversarial probe: rewriting the `dispatchRouting` import in `services/proxy/src/app/v1/messages/route.ts` to a different identifier breaks both the import check AND the call check; gate flags both and exits non-zero. Doctrine: `docs/doctrine/auto-routing-as-protocol-primitive.md` § "PR 1 scope" + § "Why TaskShape coverage is TypeScript-enforced, not gate-enforced."',
    script: "check-routing-decision-coverage",
  },
  {
    name: "check-execution-ledger-receipts-archived",
    defends:
      'the execution-ledger reconstruction in `services/relay/src/state-export.ts` MUST surface byte-identical inner signed receipts via the v1.1 `signed_receipts` field — sourced from `relay_receipts.receipt_json` (the canonical archive per `services/relay/CLAUDE.md` Rule 11). Closes the operator-trust gap: without the v1.1 wiring, the reconstruction emits only `signature_prefix` (16 chars, display-only) and a verifier cannot independently check inner motebit signatures, so a relay that falsely claims "motebit X did this work" is undetectable. With v1.1, the verifier holds the canonical-JSON bytes the motebit signed and verifies each Ed25519 signature against the named motebit\'s public key. The gate scans `state-export.ts` for three required symbols: `getStoredReceiptJson` (archive accessor), `motebit/execution-ledger@1.1` (version-bumped spec literal), `motebit/execution-ledger@1.0` (graceful-degradation fallback when the archive is empty — testnet, ephemeral deploys). Drift-defense #89, completes the producer-side wiring for cross-relay verification. Doctrine: `spec/execution-ledger-v1.md` §4.3, `docs/doctrine/nist-alignment.md` §8 "inner-receipt verification."',
    script: "check-execution-ledger-receipts-archived",
  },
  {
    name: "check-execution-ledger-inner-receipt-verified",
    defends:
      'the consumer-side recursive verification for v1.1 inner signed receipts MUST stay wired end-to-end. `@motebit/state-export-client::verifyInnerSignedReceipts` exists in `src/inner-receipts.ts` AND is re-exported from `src/index.ts`; `motebit-verify`\'s `content-artifact` subcommand (`packages/verify/src/cli.ts`) imports it AND calls it on every body whose manifest declares `artifact_type === "execution-ledger"`. Completes the producer-consumer-gate triple for inner receipts (producer #89 archives + emits the bytes; this gate ensures consumers RECURSIVELY VERIFY them; #87 / #86 cover the outer state-export envelope). Without this gate, a future refactor that drops the recursive call silently regresses to outer-only verification — the v1.1 wire change becomes inert and the operator-trust gap stays operationally open in shipping tooling. Adversarial-tested: probe removes the `verifyInnerSignedReceipts` import from `packages/verify/src/cli.ts`; gate flags. Doctrine: `spec/execution-ledger-v1.md` §4.3, `docs/doctrine/nist-alignment.md` §8 "Inner-receipt verifier shipped 2026-05-12."',
    script: "check-execution-ledger-inner-receipt-verified",
  },
  {
    name: "check-readme-public-exports",
    defends:
      "every named value export (functions, classes, constants) from a publish-surface package's `src/index.ts` MUST appear as a word in that package's `README.md`. The published packages are motebit's front door on npm — a new export shipped under a `minor` Changeset bump that isn't in the README is invisible to consumers discovering the package on the npm page. Same code-shaped-prose-drift shape as the 2026-05-11 `state-export-client@0.2.0` incident where `verifyInnerSignedReceipts` shipped without README mention. Closed-registry / structural-lock pattern: derive publishables from filesystem (any `packages/*` / `apps/*` / `services/*` not marked `\"private\": true` and not at version `0.0.0-private`), parse `src/index.ts` for named value exports, grep README. Type-only exports skipped. Acknowledged-debt waivers live in `WAIVED_EXPORTS` keyed by package name with a categorical reason — ratchet downward over time; never silently grow. Stale-waiver detection: if a waived export now appears in README, the gate also flags the waiver as removable. Together with `check-api-surface` (type-surface stability), `check-cli-surface` (CLI-surface stability), and `check-audience-canonical`/`check-artifact-type-canonical` (wire-surface stability), this gate locks the fourth axis: npm-consumer-discovery surface. Doctrine: docs/doctrine/promoting-private-to-public.md; `feedback_code_shaped_prose_drift` memory.",
    script: "check-readme-public-exports",
  },
  {
    name: "check-ha-not-a-gate",
    defends:
      "hardware attestation raises the `HardwareAttestationSemiring` score — never admits or rejects (CLAUDE.md `Hardware-rooted identity is additive`; doctrine `docs/doctrine/hardware-attestation.md`). The software-only-identity floor is part of the protocol promise; converting the additive scoring axis into an admission criterion silently excludes software-floor users at the moat layer. Gate forbids four shapes in `services/relay/src` + `packages/{policy,market,runtime}/src`: (1) numeric threshold compares on `attestation_score`, (2) HA-property-chain `score`/`level` threshold compares, (3) exclusionary `.filter(…hardware_attestation…)` calls, (4) `if (…hardware_attestation…)` followed within 3 lines by reject/throw/skip. Waiver `// hardware-attestation: intentional-threshold — <reason>` for legitimate exceptions (one shipping today: `services/relay/src/agents.ts:334` — projection filter for response payload, not routing admission). Same negative-invariant + waiver shape as `check-suite-dispatch` (#11): closed-by-construction with explicit, audited exits.",
    script: "check-ha-not-a-gate",
  },
  {
    name: "check-money-boundary",
    defends:
      "every API-boundary money conversion (dollars float → integer micro/cents) routes through the canonical converter family in `@motebit/protocol/money.ts` (`toMicro` / `fromMicro` / `toCents` / `fromCents`); inline `Math.round(amount * 100|1_000_000|MICRO|CENTS)` outside that one file is a CI failure. Why: prior to this gate, `packages/settlement-rails/src/{stripe,x402}-rail.ts` re-rolled both formulas inline despite `@motebit/virtual-accounts` already exporting `toMicro`. Two siblings, one canonical source — exactly the synchronization-invariants meta-principle shape. Doctrine: CLAUDE.md § Money model. Same closure pattern as cryptosuite agility (#11) and consolidation primitives (#34): one home, one converter family per precision, additive — adding a third precision (RWA, JPY) is a new function in the same file, not a third inline copy.",
    script: "check-money-boundary",
  },
  {
    name: "check-typed-truth-perception",
    defends:
      "every typed-truth field the AI branches on (`already_there`, `not_in_control`, `text_appeared`, `slow_load`, `bytes_omitted_reason`, `visual_content_detected` / `blank_page_detected` / `access_denied_detected`) appears in BOTH the AI's `PERCEPTION_DOCTRINE` clause (`packages/ai-core/src/prompt.ts`) AND at least one dispatch source. Closes the doctrine drift class where one half quietly disappears: prompt teaches a field nothing emits (confabulation), or dispatch emits a field the AI doesn't know to read (silent typed truth). Closed-registry shape with bidirectional drift check, same as `check-tool-modes` / `check-mode-contract-readers` / `check-drop-handlers` — adding a typed-truth field MUST update the registry plus both halves. Doctrine: `docs/doctrine/typed-truth-perception.md`; CLAUDE.md root principle `Typed truth on results, prompt for interpretation`. (Invariant #80, added 2026-05-09 with six instances already shipping in production: `already_there` / `slow_load` / `visual_content_detected` / `blank_page_detected` / `access_denied_detected` from the navigate-noop + slow-load slices, `text_appeared` from the type-action truth slice, `bytes_omitted_reason` from the pixel-consent gate, and `not_in_control` from co-browse Slice 1 — the shape is stable enough to mechanize.)",
    script: "check-typed-truth-perception",
  },
  {
    name: "check-prompt-density",
    defends:
      "the system prompt (`packages/ai-core/src/prompt.ts`) does not silently grow rule-shaped clauses beyond a measured baseline. Each `- ` bullet or `<digit>. ` numbered RULES line is a conformance ask; accumulation contaminates the §4 emergent-interior thesis (`THE_EMERGENT_INTERIOR.md` — pressuring the system prompt corrupts emergence) and turns the prompt into a configuration file disguised as teaching. Smoke-alarm shape (not a per-clause registry): coarse line-count against a baseline, fires on growth, requires intentional bump with doctrine-grade justification in the commit message. Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md` — the five-question audit + periodic prompt-prune discipline. Baseline 62 measured 2026-05-12 after the prompt-prune pass that landed alongside the doctrine memo; growth requires either runtime backing (A-grade) or named teaching justification (B-grade), pruning lowers the floor silently.",
    script: "check-prompt-density",
  },
  {
    name: "check-universal-slash-coverage",
    defends:
      "every chat-surface that ships a slash-command registry — web (`apps/web/src/ui/slash-commands.ts`), desktop (`apps/desktop/src/ui/slash-commands.ts`), mobile (`apps/mobile/src/components/SlashAutocomplete.tsx`), CLI (`apps/cli/src/args.ts`) — registers every UNIVERSAL_COMMAND in the gate's registry. Today: `/trust` (canonical 5-dimension trust-accumulation summary computed by cmdTrust) + `/welcome` (onboarding tour naming the three thesis pillars). Closed-registry shape (same as `check-skills-cross-surface` #73 + `check-typed-truth-perception` #80): UNIVERSAL_COMMANDS × SURFACES matrix; adding a universal command MUST update the registry + every surface's slash list. Generalized from a per-command gate to one rule covering N commands — future universal commands cost one registry line, not a new script. Doctrine: `docs/doctrine/runtime-invariants-over-prompt-rules.md` § trust-accumulation visibility arc + onboarding arc. Spatial is intentionally out of scope — AR-glasses prototype has no chat surface and no slash menu.",
    script: "check-universal-slash-coverage",
  },
];

interface Result {
  gate: Gate;
  ok: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/**
 * Run one gate as a child process and buffer its output. Buffering
 * (instead of inheriting stdio) is what makes parallel execution
 * readable: interleaved stdout from N gates would be chaos; instead we
 * capture each gate's output and flush it atomically after the gate
 * completes, preserving the sequential look of the single-gate era.
 */
function runGateAsync(gate: Gate): Promise<Result> {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const cmdArgs = ["--silent", "run", gate.script];
    if (gate.args && gate.args.length > 0) {
      cmdArgs.push("--", ...gate.args);
    }
    const child = spawn("pnpm", cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("close", (code) => {
      const durationMs = Date.now() - started;
      const ok = code === 0;
      resolvePromise({ gate, ok, durationMs, stdout, stderr });
    });
    child.on("error", () => {
      const durationMs = Date.now() - started;
      resolvePromise({ gate, ok: false, durationMs, stdout, stderr });
    });
  });
}

/**
 * Bounded-concurrency runner — caps parallel gate processes at `limit`
 * so a 29-gate sweep on a 4-core CI runner doesn't thrash. Preserves the
 * input order in the returned results so the summary reads predictably.
 * Flushes each gate's captured output as it completes (not strictly in
 * order — operators see "X gate just finished" feedback; the final
 * summary is what's ordered).
 */
async function runGatesConcurrent(gates: ReadonlyArray<Gate>, limit: number): Promise<Result[]> {
  const results: Result[] = new Array(gates.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = nextIndex++;
      if (i >= gates.length) return;
      const gate = gates[i]!;
      const result = await runGateAsync(gate);
      results[i] = result;
      // Flush the gate's output atomically so parallel gates don't
      // interleave mid-line. Stderr-before-stdout matches the
      // single-gate era's ordering (description printed first, then
      // the check's ✓/✗ line).
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.stdout) process.stdout.write(result.stdout);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, gates.length)) }, worker);
  await Promise.all(workers);
  return results;
}

/**
 * Assert every `check-*` script in root package.json is either a gate or
 * explicitly excluded. Catches the drift where a new defense is added
 * to package.json but forgotten here (and therefore in CI).
 */
function assertRegistryCompleteness(): void {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf-8")) as {
    scripts: Record<string, string>;
  };
  const declared = new Set(Object.keys(pkg.scripts).filter((k) => k.startsWith("check-")));
  const accounted = new Set<string>([
    ...GATES.map((g) => g.script),
    ...Object.keys(EXCLUDED_CHECKS),
  ]);

  const unaccounted = [...declared].filter((c) => !accounted.has(c));
  if (unaccounted.length > 0) {
    process.stderr.write(
      `\nerror: ${unaccounted.length} check-* script(s) in package.json are neither registered as gates nor explicitly excluded:\n`,
    );
    for (const script of unaccounted) {
      process.stderr.write(`  - ${script}\n`);
    }
    process.stderr.write(
      `\nAdd each to GATES (if hard-fail CI) or to EXCLUDED_CHECKS with a reason (if soft/context-scoped).\n`,
    );
    process.exit(2);
  }
}

async function main(): Promise<void> {
  // Drain any orphan gate-probe files before running production
  // gates. See `drainStaleProbes` for why this lives here and not
  // only in `check-gates-effective`.
  drainStaleProbes();
  assertRegistryCompleteness();

  // Concurrency ceiling — match the runner's reported parallelism but
  // cap at 8 so a big-ci-box doesn't spawn 32 pnpm processes that
  // contend for disk I/O. Each gate spawns its own pnpm + tsx, so real
  // cost scales faster than core count.
  const limit = Math.min(8, availableParallelism());
  const results = await runGatesConcurrent(GATES, limit);
  const failed = results.some((r) => !r.ok);

  // Summary
  process.stderr.write("\n─── Drift defense summary ───\n");
  for (const { gate, ok, durationMs } of results) {
    const status = ok ? "✓" : "✗";
    process.stderr.write(`  ${status} ${gate.name.padEnd(30)} ${durationMs}ms\n`);
  }

  if (failed) {
    const failures = results.filter((r) => !r.ok).map((r) => r.gate.name);
    process.stderr.write(`\nFailed: ${failures.join(", ")}\n`);
    process.exit(1);
  }

  process.stderr.write(`\nAll ${GATES.length} drift defenses passed.\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`\ncheck runner crashed: ${msg}\n`);
  process.exit(2);
});
