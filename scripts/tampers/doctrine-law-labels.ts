/**
 * Doctrine law-label tamper checks — the proof behind each `> **Layer:** law`
 * line that names a TEST FILE (or a gate whose own probe does not reach the
 * doc's claim). The rule for a law call: the named enforcement must turn red
 * when the doc's central claim is broken. Each entry breaks one central claim
 * in the source and names the test that must go red.
 *
 * Law lines that name only gates are proven by those gates' perturbation
 * probes in scripts/check-gates-effective.ts (each breaks the invariant the
 * gate defends, and the full run must prove every probe red).
 *
 *   node scripts/tampers/doctrine-law-labels.ts
 *
 * Every entry is (file, text to revert, test expected red); the shared runner
 * applies each in an isolated copy of the tree.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runTampers, type TamperEdit, type TamperEntry } from "../lib/tamper-runner.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function entry(
  name: string,
  pkg: string | undefined,
  test: string,
  red: string,
  edit: TamperEdit,
): TamperEntry {
  return { name, edits: [edit], ...(pkg ? { pkg } : {}), test, red };
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
const EGD = "src/__tests__/execute-granted-delegation.test.ts";
const EGD_MAIN = "executeGrantedDelegation — deterministic granted spend, fail-closed";
const STAKES = "explorationStrengthForStakes — explore where mistakes are cheap";

const TAMPERS: TamperEntry[] = [
  // proactive-interior — the fail-closed proactive tool scope.
  entry(
    "proactive-interior: a tending cycle may call any user-allowed tool",
    "@motebit/runtime",
    "src/__tests__/proactive-wire.test.ts",
    "Runtime — proactive interior wire-in scoped tool registry honors proactiveCapabilities config but only for memory-mutation tools",
    {
      file: RUNTIME,
      from: "          return TENDING_ALLOWED_TOOLS.has(toolName);",
      to: "          return true || TENDING_ALLOWED_TOOLS.has(toolName);",
    },
  ),

  // first-person-worker-routing — the sovereign ranks; never first-eligible.
  entry(
    "first-person-worker-routing: selectWorker hires the lowest-ranked worker",
    "@motebit/semiring",
    "src/__tests__/worker-selection.test.ts",
    "selectWorker — first-person worker selection prefers a trusted worker over an unknown one (trust-dominant)",
    {
      file: "packages/semiring/src/worker-selection.ts",
      from: "  return rankWorkers(selfId, candidates, opts)[0] ?? null;",
      to: "  return rankWorkers(selfId, candidates, opts).at(-1) ?? null;",
    },
  ),
  entry(
    "first-person-worker-routing: the delegation path ignores the selector (first-eligible again)",
    "@motebit/runtime",
    "src/__tests__/relay-delegation.test.ts",
    "resolveAndSubmitP2pDelegation unpinned + selector → hires the ranked worker, not the first candidate",
    off(
      "packages/runtime/src/relay-delegation.ts",
      "    if (params.targetWorkerId == null && params.selectWorker != null && admissible.length > 1) {",
    ),
  ),

  // exploration-as-market-vitality — seeded Thompson draw, signed seed, stakes → strength.
  entry(
    "exploration: the Thompson draw is not a pure function of its seed",
    "@motebit/semiring",
    "src/__tests__/thompson.test.ts",
    "thompsonDraw — the auditable one-shot draw reproduces exactly from its seed (offline-verifiable)",
    {
      file: "packages/semiring/src/thompson.ts",
      from: "  return sampleBeta(alpha, beta, mulberry32(hashSeed(seed)));",
      to: "  return sampleBeta(alpha, beta, mulberry32(hashSeed(seed + String(Math.random()))));",
    },
  ),
  entry(
    "exploration: no exploration draw (pure exploit — the newcomer never gets a first job)",
    "@motebit/semiring",
    "src/__tests__/onramp-probability.test.ts",
    "newcomer on-ramp probability (full exploration, micro stakes) the staging shape — Trusted incumbent 60/2 vs an Unknown newcomer — gives the newcomer a few percent per draw",
    {
      file: "packages/semiring/src/worker-selection.ts",
      from: "  const draw = thompsonDraw(alpha, beta, `${explore.seed}|${c.motebit_id}`);",
      to: "  const draw = alpha / (alpha + beta);",
    },
  ),
  entry(
    "exploration: the seed is a constant, not the signed tick token's signature",
    "@motebit/runtime",
    EGD,
    `${EGD_MAIN} a ranked paid hire MINTS a signed routing-decision transcript that verifies on both rungs`,
    {
      file: RUNTIME,
      from: "      const exploreSeed = params.delegation.token.signature;",
      to: '      const exploreSeed = "constant-seed";',
    },
  ),
  entry(
    "exploration: a dollar-scale hop explores at full strength",
    "@motebit/runtime",
    EGD,
    `${STAKES} pure exploit at/above the ceiling (dollar-scale hops)`,
    {
      file: RUNTIME,
      from: "  if (costUsd >= EXPLORE_STAKES_CEIL_USD) return 0;",
      to: "  if (costUsd >= EXPLORE_STAKES_CEIL_USD) return 1;",
    },
  ),
  entry(
    "exploration: a micro-priced hop never explores",
    "@motebit/runtime",
    EGD,
    `${STAKES} full exploration at/below the floor (micro-priced hops)`,
    {
      file: RUNTIME,
      from: "  if (!(costUsd > EXPLORE_STAKES_FLOOR_USD)) return 1;",
      to: "  if (!(costUsd > EXPLORE_STAKES_FLOOR_USD)) return 0;",
    },
  ),

  // daemon-desktop-unification — the signed runtime:attach handshake.
  entry(
    "daemon-desktop-unification: attach accepts a token whose signature does not verify",
    "@motebit/runtime-host",
    "src/__tests__/attach.test.ts",
    "attach handshake refuses a token signed by the wrong key",
    off("packages/runtime-host/src/server.ts", "    if (payload === null) {"),
  ),

  // task-admission — the worker verifies the dispatch token before motebit_task runs.
  entry(
    "task-admission: motebit_task runs without consulting task admission",
    "@motebit/mcp-server",
    "src/__tests__/index.test.ts",
    "McpServerAdapter — task admission (dispatch_token) refuses tokens signed by a key other than the pinned relay key",
    off("packages/mcp-server/src/index.ts", "          if (this.config.taskAdmission) {"),
  ),

  // operator-transparency — the declaration is signed over its payload and that hash is anchored.
  entry(
    "operator-transparency: the declaration signature is not over its canonical payload",
    "@motebit/relay",
    "src/__tests__/transparency.test.ts",
    "operator transparency declaration signs the canonical payload verifiably against the relay public key",
    {
      file: "services/relay/src/transparency.ts",
      from: "  const sigBytes = await sign(canonicalBytes, relayIdentity.privateKey);",
      to: "  const sigBytes = await sign(new Uint8Array([0]), relayIdentity.privateKey);",
    },
  ),
  entry(
    "operator-transparency: a different hash is anchored than the one served",
    "@motebit/relay",
    "src/__tests__/transparency.test.ts",
    "anchorTransparencyDeclaration — Stage 2 onchain anchor anchors a hash that round-trips against the verifier",
    {
      file: "services/relay/src/transparency.ts",
      from: "      : submitter.submitTransparencyAnchor(declaration.hash),",
      to: '      : submitter.submitTransparencyAnchor("0".repeat(64)),',
    },
  ),

  // auto-routing-as-protocol-primitive — the dispatcher honours Constraints.
  entry(
    "auto-routing: the dispatcher ignores the jurisdiction constraint",
    "@motebit/policy",
    "src/__tests__/auto-router.test.ts",
    "dispatchRouting — deny path (constraints make every entry ineligible) impossible jurisdiction → deny (all entries filtered out)",
    off(
      "packages/policy/src/auto-router.ts",
      "    if (constraints.jurisdiction !== undefined && cap.jurisdiction !== constraints.jurisdiction) {",
    ),
  ),

  // routing-decision-transcript — verification.
  entry(
    "routing-decision-transcript: a bad signature verifies",
    "@motebit/crypto",
    "src/__tests__/routing-transcript.test.ts",
    "routing-transcript envelope law any field tamper invalidates the signature",
    off("packages/crypto/src/routing-transcript.ts", "  if (!valid) {"),
  ),
  entry(
    "routing-decision-transcript: a winner outside the frozen candidate set verifies",
    "@motebit/crypto",
    "src/__tests__/routing-transcript.test.ts",
    "routing-transcript envelope law a winner outside the frozen candidate set is structurally rejected before crypto",
    off(
      "packages/crypto/src/routing-transcript.ts",
      "  if (!candidates.some((c) => c.motebit_id === transcript.winner_motebit_id)) {",
    ),
  ),

  // evidence-provenance — content addressing.
  entry(
    "evidence-provenance: a digest mismatch still counts as present",
    "@motebit/crypto",
    "src/__tests__/evidence-provenance.test.ts",
    "verifyEvidenceProvenance — law + hostile corpus digest mismatch → not present (digest_mismatch), even if the span is there",
    off(
      "packages/crypto/src/index.ts",
      "  if (computed.toLowerCase() !== provenance.digest.value.toLowerCase()) {",
    ),
  ),

  // machine-roster (roster verifier) — only a good signature enrols a machine.
  entry(
    "machine-roster: an entry with no good signature is accepted",
    "@motebit/crypto",
    "src/__tests__/host-roster.test.ts",
    "the reduction — what it refuses gives ONE reason per entry, by precedence, and none for an id with a good copy",
    {
      file: "packages/crypto/src/host-roster.ts",
      from: "        if (await verifyBody(copy)) {",
      to: "        if ((await verifyBody(copy)) || true) {",
    },
  ),
  entry(
    "machine-roster: an entry with no good signature is accepted (properties)",
    "@motebit/crypto",
    "src/__tests__/host-roster-properties.test.ts",
    "§6 properties P11 keyless additions — nothing a party with NO key can add moves any machine",
    {
      file: "packages/crypto/src/host-roster.ts",
      from: "        if (await verifyBody(copy)) {",
      to: "        if ((await verifyBody(copy)) || true) {",
    },
  ),

  // gate-repair-instructions (repair instructions) — the contract rejects bare output.
  entry(
    "gate-repair-instructions: the repair contract passes any output",
    undefined,
    "scripts/__tests__/gate-report.test.ts",
    "hasRepairInstruction — rejects bare output rejects: pure count",
    {
      file: "scripts/lib/gate-report.ts",
      from: "  if (pointer && directive) return { ok: true };",
      to: "  if (pointer || directive || true) return { ok: true };",
    },
  ),

  // settlement-rails (custody split) — the registry refuses a sovereign rail AT THE
  // TYPE LEVEL: custody-boundary.test.ts's @ts-expect-error turns into TS2578 under
  // the package typecheck (vitest alone does not type-check).
  {
    name: "settlement-rails: the registry is widened to accept a sovereign rail",
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

  // protocol-model (permissive floor) — a permissive-floor package may not depend on BSL.
  {
    name: "protocol-model: permissive-floor @motebit/sdk declares a BSL production dependency",
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
];

await runTampers(TAMPERS, { root: ROOT });
