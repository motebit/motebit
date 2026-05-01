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
