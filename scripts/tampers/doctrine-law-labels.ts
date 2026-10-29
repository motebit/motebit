/**
 * Doctrine law-label proofs — the executable record behind every
 * `> **Layer:** law (<claim>; <claim>) — enforced by …` line. A law label
 * guarantees exactly the claims its scope lists, and each listed claim is
 * proven here: a `{ doc, claim, named, … }` entry in PROOFS breaks that claim
 * in the source and names the item (a test file, or the gate itself where the
 * claim is the gate's own invariant) that must go red.
 *
 * A gate's perturbation probe in scripts/check-gates-effective.ts is NOT such
 * a proof: a probe breaks the GATE's invariant, which is often narrower than
 * the doc's claim (round-3 review, 2026-10-29: six docs stayed fully green
 * while their central claim was broken). Only an entry here counts.
 *
 * `check-doctrine-layer` IMPORTS `PROOFS` (never scans this file as text, so a
 * commented-out or unused entry counts for nothing) and requires one live
 * proof per listed claim: same `doc`, same `claim`, a `named` item from the
 * law line. It also runs a static liveness check on every proof — `edits` is
 * non-empty, each edit's `from` occurs exactly once in its file, a vitest
 * proof's `red` is a test the named file declares, and a command proof runs
 * the item it names. That check proves a proof CAN bite; only running this
 * file proves it DOES.
 *
 * The proofs run with
 *
 *   node scripts/tampers/doctrine-law-labels.ts
 *
 * and CI does not run them yet: `pnpm check` runs the static check above, not
 * the tampers. Run this file before merging any change to a law line, a
 * proof, or the code a proof edits.
 *
 * Every entry is (file, text to revert, test expected red); the shared runner
 * applies each in an isolated copy of the tree.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Proof {
  /** The doc key: `docs/doctrine/<doc>.md`, or a chain doc's filename. */
  doc: string;
  /** One claim exactly as the doc's law-line scope lists it. */
  claim: string;
  /** One item the doc's law line names: a test file path or a gate name. */
  named: string;
  /** What the tamper breaks, in one line. */
  name: string;
  edits: TamperEdit[];
  /** vitest mode: the exact full name of the test in `named` that must go red. */
  red?: string;
  /** Packages to rebuild in the copy (the test reads their dist). */
  rebuild?: string[];
  /** command mode: argv + the text it prints only on failure. */
  command?: string[];
  redMarker?: string;
}

/**
 * One proof → one runner entry. A test path in `named` resolves to its
 * package (`packages/x/…` → the `name` in `packages/x/package.json`) and the
 * test path relative to it; a root `scripts/__tests__/…` test runs from the
 * root.
 */
function proof(p: Proof): TamperEntry {
  const base = { name: `${p.doc} [${p.claim}]: ${p.name}`, edits: p.edits };
  if (p.command) return { ...base, command: p.command, redMarker: p.redMarker! };
  const segs = p.named.split("/");
  if (segs[0] === "scripts") return { ...base, test: p.named, red: p.red! };
  const dir = segs.slice(0, 2).join("/");
  const pkg = (
    JSON.parse(readFileSync(path.join(ROOT, dir, "package.json"), "utf-8")) as { name: string }
  ).name;
  return {
    ...base,
    pkg,
    test: segs.slice(2).join("/"),
    red: p.red!,
    ...(p.rebuild ? { rebuild: p.rebuild } : {}),
  };
}

/** Prefix a condition with `(false as boolean) &&` so the guard never fires. */
function off(file: string, condition: string): TamperEdit {
  return {
    file,
    from: condition,
    to: condition.replace(/^(\s*(?:\} else )?if \()/, "$1(false as boolean) && "),
  };
}

const RUNTIME = "packages/runtime/src/motebit-runtime.ts";
const EGD_MAIN = "executeGrantedDelegation — deterministic granted spend, fail-closed";
const STAKES = "explorationStrengthForStakes — explore where mistakes are cheap";

export const PROOFS: Proof[] = [
  // ── auto-routing-as-protocol-primitive ───────────────────────────────────
  {
    doc: "auto-routing-as-protocol-primitive",
    claim: "the dispatcher filters the catalog by constraints",
    named: "packages/policy/src/__tests__/auto-router.test.ts",
    name: "the dispatcher ignores the jurisdiction constraint",
    red: "dispatchRouting — deny path (constraints make every entry ineligible) impossible jurisdiction → deny (all entries filtered out)",
    edits: [
      off(
        "packages/policy/src/auto-router.ts",
        "    if (constraints.jurisdiction !== undefined && cap.jurisdiction !== constraints.jurisdiction) {",
      ),
    ],
  },

  // ── chrome-as-state-render (cell coverage) ───────────────────────────────
  {
    doc: "chrome-as-state-render",
    claim: "the motebit register renders task narration",
    named: "apps/web/src/__tests__/slab-chrome.test.ts",
    name: "the motebit × virtual_browser register collapses into cobrowse chrome",
    red: "renderSlabChrome — motebit × virtual_browser narration register renders task-step narration in the middle slot when present",
    edits: [off("apps/web/src/ui/slab-chrome.ts", '  if (state.kind === "motebit") {')],
  },

  // ── commitment-bond (address binding, backing reads) ─────────────────────
  {
    doc: "commitment-bond",
    claim: "the bonded address is key-derived",
    named: "packages/crypto/src/__tests__/bond.test.ts",
    name: "the anti-sybil address binding is dropped",
    red: "signBondCommitment / verifyBondCommitment rejects a bond whose bonded_address is an arbitrary non-derived string",
    edits: [
      off(
        "packages/crypto/src/artifacts.ts",
        "  if (commitment.bonded_address !== base58btcEncode(bondedKey)) return false;",
      ),
    ],
  },
  {
    doc: "commitment-bond",
    claim: "an under-funded bond reads underbacked",
    named: "services/relay/src/__tests__/commitment-bond.test.ts",
    name: "the backing read marks every bond backed",
    red: "bond-verifier loop — RPC backing reads marks an under-funded bond underbacked",
    edits: [
      {
        file: "services/relay/src/bond-verifier.ts",
        from: 'const state = balance >= committed ? "backed" : "underbacked";',
        to: 'const state = balance >= committed || true ? "backed" : "underbacked";',
      },
    ],
  },

  // ── coverage-graduation ──────────────────────────────────────────────────
  {
    doc: "coverage-graduation",
    claim: "a past-date unmet commitment fails",
    named: "check-coverage-graduation",
    name: "a graduated floor is silently lowered past its raise-by date",
    edits: [
      {
        file: "packages/core-identity/vitest.config.ts",
        from: "  thresholds: { statements: 85, branches: 86, functions: 85, lines: 85 },",
        to: "  thresholds: { statements: 70, branches: 86, functions: 85, lines: 85 },",
      },
    ],
    command: ["npx", "tsx", "scripts/coverage-graduation.ts"],
    redMarker: "PAST target_date with the target still unmet",
  },

  // ── creature-canon (camera canon) ────────────────────────────────────────
  {
    doc: "creature-canon",
    claim: "canonical poses stay inside the orbit envelope and the backdrop dome",
    named: "packages/render-engine/src/__tests__/camera-envelope.test.ts",
    name: "the canonical front pose leaves the orbit envelope and the dome",
    red: "camera envelope × backdrop dome every canonical pose sits inside the orbit envelope and the dome",
    edits: [
      {
        file: "packages/render-engine/src/spec.ts",
        from: "  front: { fov: 45, position: [0, 0.02, 0.92], lookAt: [0, -0.015, 0] },",
        to: "  front: { fov: 45, position: [0, 0.02, 9.2], lookAt: [0, -0.015, 0] },",
      },
    ],
  },
  {
    doc: "creature-canon",
    claim: "surfaces consume the canonical camera",
    named: "check-creature-canon",
    name: "a surface re-encodes the camera instead of consuming the canon",
    edits: [
      {
        file: "apps/mobile/src/creature-webview.ts",
        from: "camera.position.set(...pose.position);",
        to: "camera.position.set(0, 0.02, 0.85);",
      },
    ],
    command: ["npx", "tsx", "scripts/check-creature-canon.ts"],
    redMarker: "re-encodes the canonical camera as a literal",
  },

  // ── daemon-desktop-unification ───────────────────────────────────────────
  {
    doc: "daemon-desktop-unification",
    claim: "attach requires a valid device signature",
    named: "packages/runtime-host/src/__tests__/attach.test.ts",
    name: "attach accepts a token whose signature does not verify",
    red: "attach handshake refuses a token signed by the wrong key",
    edits: [off("packages/runtime-host/src/server.ts", "    if (payload === null) {")],
  },

  // ── deprecation-lifecycle (deprecation annotations) ──────────────────────
  {
    doc: "deprecation-lifecycle",
    claim: "published deprecations carry a replacement and a reason",
    named: "check-deprecation-discipline",
    name: "a published @deprecated ships without a replacement pointer or Reason",
    edits: [
      {
        file: "packages/sdk/src/models.ts",
        from: "/** Default Anthropic model — the picker's `recommended` row (#654). */\nexport const DEFAULT_ANTHROPIC_MODEL",
        to: "/**\n * Default Anthropic model — the picker's `recommended` row (#654).\n * @deprecated since 1.0.0, removed in 2.0.0.\n */\nexport const DEFAULT_ANTHROPIC_MODEL",
      },
    ],
    command: ["npx", "tsx", "scripts/check-deprecation-discipline.ts"],
    redMarker: "missing replacement pointer",
  },

  // ── evidence-provenance ──────────────────────────────────────────────────
  {
    doc: "evidence-provenance",
    claim: "a digest mismatch is never reported present",
    named: "packages/crypto/src/__tests__/evidence-provenance.test.ts",
    name: "a digest mismatch still counts as present",
    red: "verifyEvidenceProvenance — law + hostile corpus digest mismatch → not present (digest_mismatch), even if the span is there",
    edits: [
      off(
        "packages/crypto/src/index.ts",
        "  if (computed.toLowerCase() !== provenance.digest.value.toLowerCase()) {",
      ),
    ],
  },

  // ── exploration-as-market-vitality ───────────────────────────────────────
  {
    doc: "exploration-as-market-vitality",
    claim: "the draw is reproducible from its seed",
    named: "packages/semiring/src/__tests__/thompson.test.ts",
    name: "the Thompson draw is not a pure function of its seed",
    red: "thompsonDraw — the auditable one-shot draw reproduces exactly from its seed (offline-verifiable)",
    edits: [
      {
        file: "packages/semiring/src/thompson.ts",
        from: "  return sampleBeta(alpha, beta, mulberry32(hashSeed(seed)));",
        to: "  return sampleBeta(alpha, beta, mulberry32(hashSeed(seed + String(Math.random()))));",
      },
    ],
  },
  {
    doc: "exploration-as-market-vitality",
    claim: "newcomers get exploration draws",
    named: "packages/semiring/src/__tests__/onramp-probability.test.ts",
    name: "no exploration draw (pure exploit — the newcomer never gets a first job)",
    red: "newcomer on-ramp probability (full exploration, micro stakes) the staging shape — Trusted incumbent 60/2 vs an Unknown newcomer — gives the newcomer a few percent per draw",
    edits: [
      {
        file: "packages/semiring/src/worker-selection.ts",
        from: "  const draw = thompsonDraw(alpha, beta, `${explore.seed}|${c.motebit_id}`);",
        to: "  const draw = alpha / (alpha + beta);",
      },
    ],
  },
  {
    doc: "exploration-as-market-vitality",
    claim: "the seed is the signed token",
    named: "packages/runtime/src/__tests__/execute-granted-delegation.test.ts",
    name: "the seed is a constant, not the signed tick token's signature",
    red: `${EGD_MAIN} a ranked paid hire MINTS a signed routing-decision transcript that verifies on both rungs`,
    edits: [
      {
        file: RUNTIME,
        from: "      const exploreSeed = params.delegation.token.signature;",
        to: '      const exploreSeed = "constant-seed";',
      },
    ],
  },
  {
    doc: "exploration-as-market-vitality",
    claim: "stakes scale exploration strength",
    named: "packages/runtime/src/__tests__/execute-granted-delegation.test.ts",
    name: "a dollar-scale hop explores at full strength",
    red: `${STAKES} pure exploit at/above the ceiling (dollar-scale hops)`,
    edits: [
      {
        file: RUNTIME,
        from: "  if (costUsd >= EXPLORE_STAKES_CEIL_USD) return 0;",
        to: "  if (costUsd >= EXPLORE_STAKES_CEIL_USD) return 1;",
      },
    ],
  },
  {
    doc: "exploration-as-market-vitality",
    claim: "stakes scale exploration strength",
    named: "packages/runtime/src/__tests__/execute-granted-delegation.test.ts",
    name: "a micro-priced hop never explores",
    red: `${STAKES} full exploration at/below the floor (micro-priced hops)`,
    edits: [
      {
        file: RUNTIME,
        from: "  if (!(costUsd > EXPLORE_STAKES_FLOOR_USD)) return 1;",
        to: "  if (!(costUsd > EXPLORE_STAKES_FLOOR_USD)) return 0;",
      },
    ],
  },

  // ── felt-accumulation (accrual basis) ────────────────────────────────────
  {
    doc: "felt-accumulation",
    claim: "a basis is minted only above the consequential bar",
    named: "packages/memory-graph/src/__tests__/accrual.test.ts",
    name: "a basis is minted for a recall below the consequential bar",
    red: "recalledMemoryBasis — the consequential-recall producer returns undefined when every match is below the consequential bar",
    edits: [
      {
        file: "packages/memory-graph/src/accrual.ts",
        from: "    if (sim >= min && (best === undefined || sim > best.sim)) {",
        to: "    if (best === undefined || sim > best.sim) {",
      },
    ],
  },

  // ── felt-interior (honesty floors) ───────────────────────────────────────
  {
    doc: "felt-interior",
    claim: "verified only when coverage holds",
    named: "packages/panels/src/__tests__/felt-consolidation.test.ts",
    name: "a candidate is shown as verified without its coverage holding",
    red: "verifyFeltCoverage — evidence regression matrix (2) bad signature → receipt_only",
    edits: [
      {
        file: "packages/panels/src/memory/felt-consolidation.ts",
        from: "      verified && manifest\n",
        to: "      manifest\n",
      },
    ],
  },

  // ── first-person-worker-routing ──────────────────────────────────────────
  {
    doc: "first-person-worker-routing",
    claim: "ranking orders by first-person trust",
    named: "packages/semiring/src/__tests__/worker-selection.test.ts",
    name: "selectWorker hires the lowest-ranked worker",
    red: "selectWorker — first-person worker selection prefers a trusted worker over an unknown one (trust-dominant)",
    edits: [
      {
        file: "packages/semiring/src/worker-selection.ts",
        from: "  return rankWorkers(selfId, candidates, opts)[0] ?? null;",
        to: "  return rankWorkers(selfId, candidates, opts).at(-1) ?? null;",
      },
    ],
  },
  {
    doc: "first-person-worker-routing",
    claim: "the delegation path hires the ranked worker",
    named: "packages/runtime/src/__tests__/relay-delegation.test.ts",
    name: "the delegation path ignores the selector (first-eligible again)",
    red: "resolveAndSubmitP2pDelegation unpinned + selector → hires the ranked worker, not the first candidate",
    edits: [
      off(
        "packages/runtime/src/relay-delegation.ts",
        "    if (params.targetWorkerId == null && params.selectWorker != null && admissible.length > 1) {",
      ),
    ],
  },

  // ── gate-repair-instructions (repair instructions) ───────────────────────
  {
    doc: "gate-repair-instructions",
    claim: "the repair contract rejects bare output",
    named: "scripts/__tests__/gate-report.test.ts",
    name: "the repair contract passes any output",
    red: "hasRepairInstruction — rejects bare output rejects: pure count",
    edits: [
      {
        file: "scripts/lib/gate-report.ts",
        from: "  if (pointer && directive) return { ok: true };",
        to: "  if (pointer || directive || true) return { ok: true };",
      },
    ],
  },

  // ── hardware-attestation ─────────────────────────────────────────────────
  {
    doc: "hardware-attestation",
    claim: "attestation never gates",
    named: "packages/market/src/__tests__/graph-routing.test.ts",
    name: "an unattested agent's trust is zeroed — attestation becomes a gate",
    red: "hardware attestation trust boost absent hardware_attestation → trust unchanged (boost factor 1.0)",
    edits: [
      {
        file: "packages/market/src/graph-routing.ts",
        from: "  return Math.min(1.0, trust * (1 + chainHwScore * HARDWARE_ATTESTATION_BOOST));",
        to: "  return chainHwScore < HW_ATTESTATION_HARDWARE ? 0 : Math.min(1.0, trust * (1 + chainHwScore * HARDWARE_ATTESTATION_BOOST));",
      },
    ],
  },

  // ── machine-roster (roster verifier) ─────────────────────────────────────
  {
    doc: "machine-roster",
    claim: "only signed entries count",
    named: "packages/crypto/src/__tests__/host-roster.test.ts",
    name: "an entry with no good signature is accepted",
    red: "the reduction — what it refuses gives ONE reason per entry, by precedence, and none for an id with a good copy",
    edits: [
      {
        file: "packages/crypto/src/host-roster.ts",
        from: "        if (await verifyBody(copy)) {",
        to: "        if ((await verifyBody(copy)) || true) {",
      },
    ],
  },
  {
    doc: "machine-roster",
    claim: "only signed entries count",
    named: "packages/crypto/src/__tests__/host-roster-properties.test.ts",
    name: "an entry with no good signature is accepted (properties)",
    red: "§6 properties P11 keyless additions — nothing a party with NO key can add moves any machine",
    edits: [
      {
        file: "packages/crypto/src/host-roster.ts",
        from: "        if (await verifyBody(copy)) {",
        to: "        if ((await verifyBody(copy)) || true) {",
      },
    ],
  },

  // ── memory-never-confers-authority ───────────────────────────────────────
  {
    doc: "memory-never-confers-authority",
    claim: "grantless R4 needs approval",
    named: "packages/policy/src/__tests__/grant-authorizes-r4.test.ts",
    name: "a grantless R4 call auto-executes under a permissive band",
    red: "approval (validate step 8c) grantless R4 requires approval even when the band would auto-execute it (8b is load-bearing)",
    edits: [
      off(
        "packages/policy/src/policy-gate.ts",
        "    if (profile.risk >= RiskLevel.R4_MONEY && !needsApproval && ctx.verifiedGrant == null) {",
      ),
    ],
  },
  {
    // The grant's own signature/expiry/revocation check runs twice: in
    // verifyGrantForTurn (`grantValid`) and again inside crypto's
    // verifyTokenAgainstGrant. Bypassing only `grantValid` is masked by the
    // second check, so the claim is broken by bypassing both.
    doc: "memory-never-confers-authority",
    claim: "the grant's signature is verified",
    named: "packages/runtime/src/__tests__/grant-verifier.test.ts",
    name: "the grant's signature is never checked (both sites)",
    red: "verifyGrantForTurn returns null for a tampered grant",
    rebuild: ["@motebit/crypto"],
    edits: [
      off("packages/runtime/src/grant-verifier.ts", "  if (!grantValid) return null;"),
      off(
        "packages/crypto/src/artifacts.ts",
        "  if (!(await verifyStandingDelegation(grant, { now, isRevoked: options?.isRevoked }))) {",
      ),
    ],
  },

  // ── memory-provenance ────────────────────────────────────────────────────
  {
    doc: "memory-provenance",
    claim: "spoofed provenance markers are escaped",
    named: "packages/ai-core/src/__tests__/index.test.ts",
    name: "a `[from:` marker inside memory content is not escaped (spoofable provenance)",
    red: "packContext escapes a spoofed [from: marker inside memory content",
    edits: [
      {
        file: "packages/ai-core/src/core.ts",
        from: '    .replace(/\\[from:/g, "[escaped-from:");',
        to: '    .replace(/\\[from-never:/g, "[escaped-from:");',
      },
    ],
  },
  {
    doc: "memory-provenance",
    claim: "the marker sits outside the data boundary",
    named: "packages/ai-core/src/__tests__/index.test.ts",
    name: "the provenance marker moves inside [MEMORY_DATA]",
    red: "packContext renders the provenance marker outside the data boundary for every source",
    edits: [
      {
        file: "packages/ai-core/src/core.ts",
        from: "[from:${marker}] [confidence=${mem.confidence.toFixed(2)}] [MEMORY_DATA]${escapeMemoryContent(mem.content)}[/MEMORY_DATA]",
        to: "[confidence=${mem.confidence.toFixed(2)}] [MEMORY_DATA][from:${marker}] ${escapeMemoryContent(mem.content)}[/MEMORY_DATA]",
      },
    ],
  },

  // ── merkle-tree-hash-versioning ──────────────────────────────────────────
  {
    doc: "merkle-tree-hash-versioning",
    claim: "leaf and node hashes are domain-separated",
    named: "packages/crypto/src/__tests__/merkle-domain-separation.test.ts",
    name: "the v2 leaf tag equals the node tag (no domain separation)",
    red: "hashLeaf — the leaf-tag dispatch primitive, pinned to the external KAT v2: hashLeaf(enc('L123456')) == HashLeaf('L123456') (0x00 leaf tag through the primitive)",
    edits: [
      {
        file: "packages/crypto/src/merkle.ts",
        from: "const LEAF_TAG_V2 = new Uint8Array([0x00]);",
        to: "const LEAF_TAG_V2 = new Uint8Array([0x01]);",
      },
    ],
  },

  // ── operator-transparency (declaration signing, anchoring, processor disclosure)
  {
    doc: "operator-transparency",
    claim: "the declaration is signed over its payload",
    named: "services/relay/src/__tests__/transparency.test.ts",
    name: "the declaration signature is not over its canonical payload",
    red: "operator transparency declaration signs the canonical payload verifiably against the relay public key",
    edits: [
      {
        file: "services/relay/src/transparency.ts",
        from: "  const sigBytes = await sign(canonicalBytes, relayIdentity.privateKey);",
        to: "  const sigBytes = await sign(new Uint8Array([0]), relayIdentity.privateKey);",
      },
    ],
  },
  {
    doc: "operator-transparency",
    claim: "the served hash is the anchored hash",
    named: "services/relay/src/__tests__/transparency.test.ts",
    name: "a different hash is anchored than the one served",
    red: "anchorTransparencyDeclaration — Stage 2 onchain anchor anchors a hash that round-trips against the verifier",
    edits: [
      {
        file: "services/relay/src/transparency.ts",
        from: "      : submitter.submitTransparencyAnchor(declaration.hash),",
        to: '      : submitter.submitTransparencyAnchor("0".repeat(64)),',
      },
    ],
  },

  // ── proactive-interior ───────────────────────────────────────────────────
  {
    doc: "proactive-interior",
    claim: "tending may call only memory tools",
    named: "packages/runtime/src/__tests__/proactive-wire.test.ts",
    name: "a tending cycle may call any user-allowed tool",
    red: "Runtime — proactive interior wire-in scoped tool registry honors proactiveCapabilities config but only for memory-mutation tools",
    edits: [
      {
        file: RUNTIME,
        from: "          return TENDING_ALLOWED_TOOLS.has(toolName);",
        to: "          return true || TENDING_ALLOWED_TOOLS.has(toolName);",
      },
    ],
  },

  // ── protocol-model (permissive floor) ────────────────────────────────────
  {
    doc: "protocol-model",
    claim: "the permissive floor declares no BSL dependency",
    named: "check-deps",
    name: "permissive-floor @motebit/sdk declares a BSL production dependency",
    edits: [
      {
        file: "packages/sdk/package.json",
        from: '  "dependencies": {\n    "@motebit/protocol": "workspace:*"\n  },',
        to: '  "dependencies": {\n    "@motebit/protocol": "workspace:*",\n    "@motebit/semiring": "workspace:*"\n  },',
      },
    ],
    command: ["npx", "tsx", "scripts/check-deps.ts"],
    redMarker: "declares a production dependency on BSL package",
  },

  // ── registry-pattern-canonical ───────────────────────────────────────────
  {
    doc: "registry-pattern-canonical",
    claim: "every registered registry exports its type guard",
    named: "check-closed-registry-canonical",
    name: "a registered registry loses its exported type guard",
    edits: [
      {
        file: "packages/protocol/src/sensitivity.ts",
        from: "export function isSensitivityLevel(value: unknown): value is SensitivityLevel {",
        to: "function isSensitivityLevel(value: unknown): value is SensitivityLevel {",
      },
    ],
    command: ["npx", "tsx", "scripts/check-closed-registry-canonical.ts"],
    redMarker: "missing_guard_export",
  },

  // ── retention-policy (store coverage, deletion certificates) ─────────────
  {
    doc: "retention-policy",
    claim: "sensitivity stores are registered for the flush",
    named: "check-retention-coverage",
    name: "a sensitivity-bearing store the flush never sees",
    edits: [
      {
        file: "packages/persistence/src/index.ts",
        from: "CREATE TABLE IF NOT EXISTS conversation_messages (\n  message_id TEXT PRIMARY KEY,",
        to: "CREATE TABLE IF NOT EXISTS shadow_notes (\n  id TEXT PRIMARY KEY,\n  sensitivity TEXT\n);\n\nCREATE TABLE IF NOT EXISTS conversation_messages (\n  message_id TEXT PRIMARY KEY,",
      },
    ],
    command: ["npx", "tsx", "scripts/check-retention-coverage.ts"],
    redMarker: "[unregistered-table]",
  },
  {
    doc: "retention-policy",
    claim: "memory deletions issue signed certificates",
    named: "packages/privacy-layer/src/__tests__/index.test.ts",
    name: "a memory deletion issues an unsigned certificate",
    red: "PrivacyLayer deleteMemory creates a signed mutable_pruning deletion certificate",
    edits: [
      {
        file: "packages/privacy-layer/src/index.ts",
        from: "    const cert = await signCertAsSubject(\n      certBody,\n      this.signer.motebitId as string,\n      this.signer.privateKey,\n    );\n\n    // Erase the memory",
        to: "    const cert: DeletionCertificate = certBody;\n\n    // Erase the memory",
      },
    ],
  },

  // ── routing-decision-transcript (emission, verification) ─────────────────
  {
    doc: "routing-decision-transcript",
    claim: "the signature binds the transcript",
    named: "packages/crypto/src/__tests__/routing-transcript.test.ts",
    name: "a bad signature verifies",
    red: "routing-transcript envelope law any field tamper invalidates the signature",
    edits: [off("packages/crypto/src/routing-transcript.ts", "  if (!valid) {")],
  },
  {
    doc: "routing-decision-transcript",
    claim: "the winner is in the frozen set",
    named: "packages/crypto/src/__tests__/routing-transcript.test.ts",
    name: "a winner outside the frozen candidate set verifies",
    red: "routing-transcript envelope law a winner outside the frozen candidate set is structurally rejected before crypto",
    edits: [
      off(
        "packages/crypto/src/routing-transcript.ts",
        "  if (!candidates.some((c) => c.motebit_id === transcript.winner_motebit_id)) {",
      ),
    ],
  },

  // ── settlement-rails (custody split) ─────────────────────────────────────
  {
    // The registry refuses a sovereign rail AT THE TYPE LEVEL: the test's
    // @ts-expect-error becomes TS2578 under the package typecheck (vitest
    // alone does not type-check).
    doc: "settlement-rails",
    claim: "the registry refuses sovereign rails",
    named: "packages/settlement-rails/src/__tests__/custody-boundary.test.ts",
    name: "the registry is widened to accept a sovereign rail",
    edits: [
      {
        file: "packages/settlement-rails/src/index.ts",
        from: "  register(rail: GuestRail): void {\n    this.rails.set(rail.name, rail);",
        to: '  register(rail: GuestRail | { custody: "agent"; name: string }): void {\n    this.rails.set(rail.name, rail as GuestRail);',
      },
    ],
    command: ["pnpm", "--filter", "@motebit/settlement-rails", "typecheck"],
    redMarker: "TS2578",
  },

  // ── surface-determinism (runtime invocation path) ────────────────────────
  {
    doc: "surface-determinism",
    claim: "capability invocation bypasses the AI loop",
    named: "packages/runtime/src/__tests__/invoke-capability.test.ts",
    name: "a capability invocation is routed through the AI loop as a prompt",
    red: "invokeCapability — surface determinism bypasses the AI loop entirely — runTurnStreaming is never called",
    edits: [
      {
        file: RUNTIME,
        from: "    yield* this.invokeCapabilityManager.invokeCapability(capability, prompt, options);",
        to: "    yield* this.sendMessageStreaming(`${capability}: ${prompt}`);",
      },
    ],
  },

  // ── task-admission ───────────────────────────────────────────────────────
  {
    doc: "task-admission",
    claim: "the worker refuses unadmitted tasks",
    named: "packages/mcp-server/src/__tests__/index.test.ts",
    name: "motebit_task runs without consulting task admission",
    red: "McpServerAdapter — task admission (dispatch_token) refuses tokens signed by a key other than the pinned relay key",
    edits: [off("packages/mcp-server/src/index.ts", "          if (this.config.taskAdmission) {")],
  },
  {
    doc: "task-admission",
    claim: "priced listings default to relay admission",
    named: "packages/molecule-runner/src/__tests__/task-admission.test.ts",
    name: "a priced, relay-registered listing defaults to open",
    red: "resolveTaskAdmission — posture priced + relay-registered with nothing configured ⇒ relay by DEFAULT (flipped 2026-09-13)",
    edits: [
      {
        file: "packages/molecule-runner/src/index.ts",
        from: '  const defaulted = priced && Boolean(config.syncUrl) ? "relay" : "open";',
        to: '  const defaulted = priced && Boolean(config.syncUrl) ? "open" : "open";',
      },
    ],
  },

  // ── typed-truth-perception ───────────────────────────────────────────────
  {
    doc: "typed-truth-perception",
    claim: "different resources are never equivalent",
    named: "services/browser-sandbox/src/__tests__/url-equivalence.test.ts",
    name: "every URL pair reads as equivalent (already_there always true)",
    red: "urlsAreEquivalent returns false for different hosts",
    edits: [
      {
        file: "services/browser-sandbox/src/url-equivalence.ts",
        from: "export function urlsAreEquivalent(a: string, b: string): boolean {\n",
        to: "export function urlsAreEquivalent(a: string, b: string): boolean {\n  if (a.length >= 0) return true;\n",
      },
    ],
  },
  {
    doc: "typed-truth-perception",
    claim: "dishonest closings are corrected",
    named: "packages/ai-core/src/__tests__/dishonest-closing.test.ts",
    name: "a dishonest closing claim is never corrected",
    red: "detectDishonestClosing — three test pins PIN 1 — each field triggers override on first-attempt failure navigation_triggered: false on click triggers correction",
    edits: [
      {
        file: "packages/ai-core/src/dishonest-closing.ts",
        from: "  const claim = classifyClosingClaim(args.finalText);\n  if (claim === null) return null;",
        to: "  const claim = classifyClosingClaim(args.finalText);\n  if (claim === null || args.finalText.length >= 0) return null;",
      },
    ],
  },
  {
    doc: "evidence-provenance",
    claim: "fail-closed projection",
    named: "packages/crypto/src/__tests__/evidence-provenance.test.ts",
    name: "a projection with no resolver reads as present (fail-open)",
    red: "verifyEvidenceProvenance — law + hostile corpus projection present + NO resolver → FAIL CLOSED (projection_unresolved) — domain-blind",
    edits: [
      {
        file: "packages/crypto/src/index.ts",
        from: '      return { present: false, reason: "projection_unresolved" };',
        to: "      return { present: true };",
      },
    ],
  },
  {
    doc: "memory-never-confers-authority",
    claim: "a grant binds its presenter",
    named: "packages/runtime/src/__tests__/grant-presenter-binding.test.ts",
    name: "a grant presented by someone other than its delegate verifies",
    red: "verifyGrantForTurn — presenter binding (finding 3) a grant for delegate A presented by B confers nothing",
    edits: [
      off(
        "packages/runtime/src/grant-verifier.ts",
        "  if (!grantDelegateIs(grant, options.presenter)) return null;",
      ),
    ],
  },
  {
    doc: "routing-decision-transcript",
    claim: "recomputation reproduces the hire",
    named: "packages/semiring/src/__tests__/worker-selection-transcript.test.ts",
    name: "recomputation accepts a substituted winner",
    red: "recomputeRoutingDecision — the faithfulness rung catches a substituted winner (winner_mismatch)",
    edits: [
      off(
        "packages/semiring/src/worker-selection.ts",
        "  if (recomputed !== basis.winner_motebit_id) {",
      ),
    ],
  },
  {
    doc: "task-admission",
    claim: "an unlisted capability prices at the listing ceiling",
    named: "services/relay/src/__tests__/task-dispatch-token.test.ts",
    name: "an unlisted capability prices a priced worker at 0 (clears the gate for free)",
    red: "getListingUnitCost — an unlisted capability never prices a priced worker at 0 prices an unknown capability at the listing ceiling; a listed one at its own price; unpriced stays 0",
    edits: [
      {
        file: "services/relay/src/tasks.ts",
        from: "      return pricing.reduce((max, p) => Math.max(max, p.unit_cost ?? 0), 0);",
        to: "      return 0;",
      },
    ],
  },
];

// Run only when invoked directly, so the entries can be read without running.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runTampers(PROOFS.map(proof), { root: ROOT }).catch((err: unknown) => {
    console.error(err);
    process.exit(2);
  });
}
