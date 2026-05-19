#!/usr/bin/env tsx
/**
 * check-doctrine-references — drift defense for "doctrine cites code by
 * symbol name" coherence.
 *
 * Sibling of `check-doctrine-citations`: that gate validates path-shaped
 * and line-anchored citations (`\`packages/foo/src/bar.ts\``,
 * `\`bar.ts:42\``); this gate validates *symbol-shaped* citations
 * (`\`BridgeSettlementRail\``, `\`SOLANA_MAINNET_CAIP2\``,
 * `\`synthesizeClosingFallback\``). Same drift class — doctrine prose
 * names a code artifact that no longer exists or was never spelled the
 * way the doctrine claims — applied one level deeper: rename a type or
 * constant and the doctrine references rot silently. The doctrine still
 * reads coherent, but the named symbol resolves to nothing.
 *
 * Naming class this gate exists to catch (same shape as the
 * FIN-2015-G001 prose-fossil catch on 2026-05-18 and the CAIP-2
 * canonicality fix landing in the same arc): a specific identifier
 * survives local construction but fails verification against the
 * canonical source. The previous instances were caught by review; this
 * gate makes the catch structural so the next contributor cannot
 * recreate it.
 *
 * Out of scope (intentional — narrower than `check-doctrine-citations`):
 *
 *   - Member access (`Foo.bar`), generics (`Foo<P>`), function-call
 *     shape (`foo(x, y)`). The regex matches whole-identifier
 *     backticks only — compound forms are left to v2 if a fossil
 *     surfaces. The simple form catches the prose-fossil class today.
 *   - Content equivalence (the named symbol still means what the
 *     doctrine claims). Same scoping as check-doctrine-citations: the
 *     name resolves, the semantics are a separate class.
 *   - Identifiers inside fenced code blocks. Code blocks usually hold
 *     example snippets where stale identifiers might be intentional
 *     ("the old name was X, the new name is Y") — prose claims are the
 *     fossil surface, not code-block illustrations.
 *
 * What this gate enforces:
 *
 *   Every backtick-delimited identifier in `docs/doctrine/*.md` (inline
 *   prose, not fenced code blocks) matching one of three shapes —
 *   PascalCase with ≥2 capital transitions (`BridgeSettlementRail`),
 *   SCREAMING_SNAKE (must contain ≥1 underscore — `SOLANA_MAINNET_CAIP2`),
 *   or camelCase (lowercase start + ≥1 later uppercase —
 *   `synthesizeClosingFallback`) — resolves to a token that appears in
 *   the source corpus (packages/*, services/*, apps/*, scripts/,
 *   spec/*.md). Minimum identifier length 4 filters two-letter prose
 *   acronyms (`CN`, `OK`) that the SCREAMING_SNAKE clause would otherwise
 *   pick up.
 *
 *   Disjoint with `check-doctrine-citations`: path-shaped refs require
 *   `/`, gate refs are `check-X`-prefixed-with-hyphen — neither matches
 *   the identifier shapes here.
 *
 *   Resolution is source-grep against tokenized identifier extraction
 *   (regex `[A-Za-z_][A-Za-z0-9_]*` over `.ts`/`.tsx`/`.js`/`.mjs`/`.json`
 *   in code roots + `.md` in `spec/`). Not dist-surface resolution —
 *   that's invasive for line-rate CI and not necessary to catch the
 *   fossil class. Token-presence-as-substring is the right granularity:
 *   a renamed symbol's old name vanishes from the source corpus the
 *   commit it lands; a typo never appears in source at all.
 *
 * Usage:
 *   tsx scripts/check-doctrine-references.ts        # exit 1 on violation
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(new URL(".", import.meta.url).pathname, "..");
const DOCTRINE_DIR = join(REPO_ROOT, "docs/doctrine");

const CODE_ROOTS = ["packages", "services", "apps", "scripts"].map((r) => join(REPO_ROOT, r));
const SPEC_ROOT = join(REPO_ROOT, "spec");
const CODE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".json"];
const SPEC_EXTENSIONS = [".md"];
/**
 * Per-package CLAUDE.md files participate in the doctrine layer (they
 * carry package-local rules and shorthand the cross-cutting doctrine in
 * `docs/doctrine/` refers back to). A name that appears in a package
 * CLAUDE.md but nowhere in code is still part of the curated naming
 * surface; including them prevents the gate from over-flagging
 * conceptual cross-references inside the doctrine system.
 *
 * `docs/doctrine/*.md` itself is NOT in the corpus — those are the docs
 * being verified, so they cannot validate themselves. The root
 * `CLAUDE.md` is included via its presence at `REPO_ROOT/CLAUDE.md`.
 */
const CLAUDE_MD_BASENAMES = new Set(["CLAUDE.md"]);
const EXCLUDE_DIRS = new Set([
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  ".next",
  "build",
  "out",
]);

/**
 * Files excluded from the source-token corpus. `check-gates-effective.ts`
 * literally embeds synthetic identifier payloads inside template-string
 * probe fixtures (`XyzNonExistentProbeReconciler`, etc.) — if we
 * tokenize that file, those probe payloads pollute the corpus and the
 * gate's own perturbation probe stops being caught (a self-reference
 * loop). The file is excluded by name because it's the one source file
 * whose declared purpose is to contain identifiers that should NOT
 * resolve from anywhere else.
 */
const EXCLUDE_FILES = new Set(["check-gates-effective.ts"]);

/** Minimum length for an identifier-shaped backticked ref to count. Filters
 * two-letter / three-letter acronyms that the SCREAMING_SNAKE clause would
 * otherwise pick up if they happen to contain an underscore (none do today,
 * but the filter is the cheap defense). */
const MIN_IDENT_LENGTH = 4;

/**
 * PascalCase with at least two capital transitions:
 *   `BridgeSettlementRail`, `WritableSettlementMode`, `MotebitId`
 * Single-capital words (`Solana`, `Bridge`) DO NOT match — they're
 * predominantly prose proper nouns in motebit doctrine.
 */
const PASCAL_CASE = /^[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*$/;

/**
 * SCREAMING_SNAKE with at least one underscore:
 *   `SOLANA_MAINNET_CAIP2`, `DEFAULT_TRUST_THRESHOLDS`, `ALL_SUITE_IDS`
 * Underscore requirement disambiguates from single-word prose acronyms
 * like `BASELINE`, `LICENSE`, `NOTICE` — those have legitimate prose
 * uses (license filenames, baseline preset names) and would generate
 * false positives.
 */
const SCREAMING_SNAKE = /^[A-Z][A-Z0-9_]*_[A-Z0-9_]+$/;

/**
 * camelCase: lowercase start + at least one later uppercase:
 *   `synthesizeClosingFallback`, `urlsAreEquivalent`, `checkGoalBudget`
 */
const CAMEL_CASE = /^[a-z][a-z0-9]+[A-Z][A-Za-z0-9]*$/;

/** Backtick-delimited content capture, single identifier (no `.`, `<`,
 * `/`, `:`, space). Compound forms (member access, generics, paths,
 * line anchors) intentionally skipped — see header. */
const BACKTICK_IDENT = /`([A-Za-z_][A-Za-z0-9_]*)`/g;

/**
 * Identifiers that match a shape pattern but legitimately do not resolve
 * to a current source-corpus token. Each entry MUST carry a reason.
 * Three legitimate classes:
 *
 *   - Anticipated future symbol: the doctrine names a planned type or
 *     constant that lands later (sibling shape to `check-doctrine-citations`
 *     `PATH_ALLOWLIST` for forward-looking specs).
 *   - Historical symbol: past-tense narration of a now-removed identifier
 *     that the deletion narrative would be incoherent without naming.
 *   - Placeholder symbol: shape-only mention (`ALL_X`, `OperatorXxx`)
 *     where the doctrine uses the identifier name to describe a class of
 *     symbols, not a specific one.
 *
 * Adding to this allowlist is intentional: a typo or stale identifier
 * should be fixed in the doctrine, not waived here.
 */
const IDENTIFIER_ALLOWLIST: Record<string, string> = {
  // ----- Anticipated future symbols -----
  contextWindow:
    "anticipated future ByokVendor field — `intelligence-pluggability-contract.md` names this as the model's declared context-window size that the pre-flight admission check measures the assembled prompt against. Lands when the typed admission path replaces the current byte-budget pre-flight.",
  renderedMemoryBudget:
    "anticipated future model-aware prompt assembly field — `intelligence-pluggability-contract.md` names this in the substance-vs-representation table for memory packing. Lands with the model-aware prompt assembly arc the doctrine is the standing direction for.",
  REFERENCE_BYOK_ROUTING_POLICY:
    "anticipated future BYOK consumer-side routing policy — `auto-routing-as-protocol-primitive.md` names this as the constant a future PR 2 (BYOK consumer) might ship. Per-consumer policy is consumer-side, not protocol-side; lands when PR 2 materializes.",
  REFERENCE_ON_DEVICE_ROUTING_POLICY:
    "anticipated future on-device consumer-side routing policy — `auto-routing-as-protocol-primitive.md` names this as PR 3's potential constant, same shape as `REFERENCE_BYOK_ROUTING_POLICY` (sibling above).",
  RetentionSemiring:
    "anticipated future semiring — `retention-policy.md` names this as the semiring that lands in `@motebit/semiring` if a third consumer arrives. Until then the `max` reduction in the resolver is sufficient; the doctrine names the shape preemptively.",
  playProtectVerdict:
    "anticipated future non-canonical operator signal — `hardware-attestation.md` names this as a field a future motebit deployment might surface at the relay tier if Play Integrity were re-introduced (outside the permissive-floor crypto-leaf set). Hypothetical, not motebit-canonical.",

  // ----- Historical symbols (past-tense narrative) -----
  setSlabControlBand:
    "historical reference — `intent-gated-slab.md` narrates the deleted function name as the named anti-pattern resolved (chrome floated outside `stageEl`). The deletion narrative would be incoherent without the cited name.",
  controlBandSlotEl:
    "historical reference — sibling of `setSlabControlBand` above; same deletion narrative in `intent-gated-slab.md`.",
  episodicConsolidation:
    "historical reference — `proactive-interior.md` names this as the deleted config option (zero callers, zero effect) struck when the runtime consolidated on `consolidationCycle()` as the only proactive loop.",
  LegacyProviderConfig:
    "historical reference — `migration-cleanup.md` names this in the post-strip example row (0-holder bucket: reader returns null after the type was struck).",
  migrateLegacyProvider:
    "historical reference — `migration-cleanup.md` names this as the empirically-reclassified zero-holder migrator stripped in commit `adc87d19` on 2026-04-23. The reclassification narrative names the function as evidence.",
  ScheduledAgent:
    "historical reference — `panels-pattern.md` names this as one of web's two pre-unification goal types (recurring simple), folded into the shared `ScheduledGoal` shape on 2026-04-22 alongside `WebGoal` (sibling).",
  WebGoal:
    "historical reference — sibling of `ScheduledAgent` above; same unification narrative in `panels-pattern.md` (the one-shot plan type folded into `ScheduledGoal`).",

  // ----- Illustrative / hypothetical names in teaching prose -----
  MemoryDeletionCertificate:
    "illustrative counterexample — `retention-policy.md` §Test uses this as one of three hypothetical sibling types ('with three sibling types, the verifier must dispatch on type') to motivate the discriminated-union design that landed. The names are pedagogical, not actual exports.",
  HorizonCertificate:
    "illustrative counterexample — sibling of `MemoryDeletionCertificate` above in the same teaching paragraph.",
  FlushCertificate:
    "illustrative counterexample — sibling of `MemoryDeletionCertificate` and `HorizonCertificate` above in the same teaching paragraph.",

  // ----- External library symbols (not motebit code) -----
  copyExternalImageToTexture:
    "external library symbol — WebGPU stdlib API, named in `motebit-computer.md`'s screencast-pipeline endgame table as the GPU upload primitive opposite WebGL's `texSubImage2D`.",
  texSubImage2D:
    "external library symbol — WebGL stdlib API, sibling of `copyExternalImageToTexture` above in the same table.",
  VideoDecoder:
    "external library symbol — WebCodecs stdlib API, named in `motebit-computer.md` and `liquescentia-as-substrate.md` as the endgame frame-decoder opposite today's `<img>.decode()`.",
  WebGPURenderer:
    "external library symbol — Three.js renderer class in the `three/webgpu` namespace, named in `liquescentia-as-substrate.md` and `motebit-computer.md` as the future-renderer promotion target.",

  // ----- Naming-convention shorthand -----
  IdentityFile:
    "naming-convention shorthand — `identity-restore.md` names the suffix the desktop surface uses for restore-related methods (`importIdentityFile`, etc.), contrasted with web/mobile's `Md` suffix. The doctrine cites the suffix string, not a standalone type. The token does not appear in source as a bare identifier because every method that uses it has a prefix.",
};

interface Finding {
  doc: string;
  line: number;
  reference: string;
  context: string;
}

function tokenize(src: string, tokens: Set<string>): void {
  const matches = src.match(/[A-Za-z_][A-Za-z0-9_]*/g);
  if (matches) for (const m of matches) tokens.add(m);
}

function walkSourceTokens(
  root: string,
  allowedExts: string[],
  includeClaudeMd: boolean,
  tokens: Set<string>,
): void {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      walkSourceTokens(full, allowedExts, includeClaudeMd, tokens);
      continue;
    }
    if (!entry.isFile()) continue;
    if (EXCLUDE_FILES.has(entry.name)) continue;
    const matchesExt = allowedExts.some((ext) => entry.name.endsWith(ext));
    const matchesClaudeMd = includeClaudeMd && CLAUDE_MD_BASENAMES.has(entry.name);
    if (!matchesExt && !matchesClaudeMd) continue;
    let src: string;
    try {
      src = readFileSync(full, "utf-8");
    } catch {
      continue;
    }
    tokenize(src, tokens);
  }
}

function buildSourceTokenIndex(): Set<string> {
  const tokens = new Set<string>();
  for (const root of CODE_ROOTS) walkSourceTokens(root, CODE_EXTENSIONS, true, tokens);
  walkSourceTokens(SPEC_ROOT, SPEC_EXTENSIONS, false, tokens);
  // Root CLAUDE.md.
  const rootClaude = join(REPO_ROOT, "CLAUDE.md");
  try {
    if (statSync(rootClaude).isFile()) tokenize(readFileSync(rootClaude, "utf-8"), tokens);
  } catch {
    // ignore
  }
  return tokens;
}

function walkDoctrineMd(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(DOCTRINE_DIR, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(join(DOCTRINE_DIR, entry.name));
    }
  }
  return out;
}

function isIdentifierShaped(token: string): boolean {
  if (token.length < MIN_IDENT_LENGTH) return false;
  return PASCAL_CASE.test(token) || SCREAMING_SNAKE.test(token) || CAMEL_CASE.test(token);
}

function scanDoc(abs: string, sourceTokens: Set<string>): Finding[] {
  const rel = relative(REPO_ROOT, abs);
  const src = readFileSync(abs, "utf-8");
  const lines = src.split("\n");
  const findings: Finding[] = [];

  // Fenced code blocks: toggle on lines starting with ``` (any number of
  // backticks ≥3 followed by optional info string). Skip identifier
  // matching while inside.
  let inFence = false;
  const fenceMarker = /^\s*```/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fenceMarker.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    BACKTICK_IDENT.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = BACKTICK_IDENT.exec(line)) !== null) {
      const ident = m[1]!;
      if (!isIdentifierShaped(ident)) continue;
      if (ident in IDENTIFIER_ALLOWLIST) continue;
      if (sourceTokens.has(ident)) continue;
      findings.push({
        doc: rel,
        line: i + 1,
        reference: ident,
        context: line.trim(),
      });
    }
  }

  return findings;
}

function main(): void {
  let dirOk = true;
  try {
    statSync(DOCTRINE_DIR);
  } catch {
    dirOk = false;
  }
  if (!dirOk) {
    console.log("check-doctrine-references: docs/doctrine/ does not exist; nothing to check.");
    return;
  }

  const sourceTokens = buildSourceTokenIndex();
  const docs = walkDoctrineMd();
  const findings = docs.flatMap((d) => scanDoc(d, sourceTokens));

  console.log(
    `check-doctrine-references — scanned ${docs.length} doctrine doc(s) for backticked identifiers (PascalCase / SCREAMING_SNAKE / camelCase, min length ${MIN_IDENT_LENGTH}) against ${sourceTokens.size} source-corpus tokens\n`,
  );

  if (findings.length === 0) {
    console.log(
      "✓ Every identifier-shaped backticked reference in docs/doctrine/ resolves to a token in the source corpus.",
    );
    return;
  }

  // Group by unique identifier across the corpus — a single stale rename
  // often surfaces at many cite sites; grouping makes the fix scope
  // obvious.
  const byIdent = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byIdent.get(f.reference) ?? [];
    list.push(f);
    byIdent.set(f.reference, list);
  }

  console.log(
    `✗ ${findings.length} identifier-shaped citation(s) across ${byIdent.size} unique identifier(s) do not resolve to a source-corpus token:\n`,
  );
  const sorted = [...byIdent.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [ident, list] of sorted) {
    console.log(`  \`${ident}\``);
    for (const f of list) {
      console.log(`    ${f.doc}:${f.line}`);
      console.log(`      ${f.context}`);
    }
  }
  console.log();
  console.log(
    `  Fix: update the citation to the current symbol name, OR add an entry\n` +
      `       to IDENTIFIER_ALLOWLIST in scripts/check-doctrine-references.ts\n` +
      `       with a reason (anticipated future symbol / historical symbol /\n` +
      `       placeholder symbol). Adding an allowlist entry is intentional —\n` +
      `       a typo or stale identifier belongs in the doctrine fix, not\n` +
      `       waived here.`,
  );
  process.exit(1);
}

main();
