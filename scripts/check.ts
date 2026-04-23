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

import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

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
    name: "check-spec-wire-schemas",
    defends:
      "every wire-format type declared in spec/*.md has a matching <TypeName>Schema export from @motebit/wire-schemas (invariant #23, added 2026-04-18 alongside the wire-schemas publication — completes the spec → TS-type → zod-schema → JSON-Schema chain so third-party implementers can validate without bundling motebit)",
    script: "check-spec-wire-schemas",
  },
  {
    name: "check-wire-schema-usage",
    defends:
      "every inbound wire-format body at services/api parses through @motebit/wire-schemas — handlers must call <Name>Schema.safeParse(/.parse( on the body, never accept untyped c.req.json() through inline casts (invariant #35, added 2026-04-20 after a principal-engineer audit found four Dispute* wire types and BalanceWaiver still bypassing the schema layer despite commit 1848d2ea adding the parse calls for the other four types — extends the protocol-primitive doctrine to runtime body validation; complements the static three-way pin in invariant #22)",
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
    defends: "every `major` changeset must ship a non-empty ## Migration section",
    script: "check-changeset-discipline",
  },
  {
    name: "check-api-surface",
    defends:
      "@motebit/{protocol,crypto,sdk} public API must match committed baseline unless a `major` changeset is pending",
    script: "check-api-surface",
  },
  {
    name: "check-docs-tree",
    defends:
      "apps/docs/content/docs/operator/architecture.mdx directory tree mirrors the filesystem and scripts/check-deps.ts LAYER/PERMISSIVE_PACKAGES (invariant #13, added 2026-04-14 after the architecture page was rewritten and 9 packages were previously misplaced across invented tiers)",
    script: "check-docs-tree",
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
      "every per-directory CLAUDE.md is indexed in root CLAUDE.md under 'Per-directory doctrine loads lazily' — sub-doctrine is only discoverable through the root index, so an unindexed CLAUDE.md is invisible to top-down readers (invariant #25, added 2026-04-18 after a birds-eye review found 6 package CLAUDE.md files added Apr 16 silently absent from the root index; extends the self-attesting-system doctrine to the doctrine-index itself)",
    script: "check-claude-md",
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
      "reputation scoring (continuous 0-1 score from trust-record + recency decay) lives in @motebit/policy (basic) or @motebit/market (receipt-history composite), not inline in apps or services (invariant #28, added 2026-04-19 after apps/admin/TrustPanel was caught with a reinvented formula that diverged from its claimed @motebit/policy source on the Beta-binomial prior — admin panel showed different scores than AI-core computed for the same agent record; extends the protocol-primitive doctrine to reputation judgment)",
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
