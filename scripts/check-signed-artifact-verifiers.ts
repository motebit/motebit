/**
 * check-signed-artifact-verifiers — the self-attesting moat as a structural
 * invariant: every signed motebit protocol artifact must have a verifier, or be
 * an explicitly-tracked gap.
 *
 * The doctrine ([`docs/doctrine/self-attesting-system.md`]) holds that "a claim
 * is self-attesting only if a third party can verify it." A signed wire artifact
 * that ships no verifier silently breaks that — exactly the gap that hid in
 * `GoalExecutionManifest` (signed by `replayGoal`, spec §6 promised verification,
 * but no verifier existed) until 2026-05-24.
 *
 * This gate makes the invariant enforceable. It discovers every exported type
 * carrying a `*signature` field in `@motebit/protocol` AND in the verification
 * packages themselves (`@motebit/crypto` / `encryption` / `state-export-client`)
 * and requires each to be classified in `REGISTRY` as one of:
 *
 *   - `verifier`  — a dedicated portable verify* function (in @motebit/crypto /
 *                   encryption / state-export-client) verifies it standalone.
 *   - `within`    — it is a nested / sub-signature verified as part of a parent
 *                   artifact's verifier (named here).
 *   - `precursor` — a signing-input mirror (`Signable*`) or field-helper
 *                   (`*Fields`) for a registered artifact; not standalone.
 *   - `gap`       — KNOWN: signed but no portable verifier yet. Visible,
 *                   enumerated debt — NOT silent. A third party cannot
 *                   self-verify these with the verification packages alone.
 *
 * Scope note: a signed artifact typed *outside* both — i.e. in a service or a
 * non-verification package — is still invisible to this gate. By doctrine a
 * signed WIRE artifact belongs in `@motebit/protocol`, so the only legitimate
 * out-of-scope signed types are relay-INTERNAL records whose signature never
 * crosses the wire (e.g. `IdentityLogAnchorRecord` in
 * `services/relay/src/identity-log-anchoring.ts` — the relay's own anchor-liveness
 * sig, persisted locally; the `anchored` rung verifies via the on-chain Merkle
 * root + sovereign succession chain, never this signature). Those need no
 * portable verifier and are deliberately not tracked here.
 *
 * Fail-closed behavior (exit 1):
 *   1. A discovered signed type is NOT in REGISTRY — a NEW signed artifact was
 *      added without deciding its verification story. Add a verifier (preferred)
 *      or register it as a tracked `gap` with a reason.
 *   2. A REGISTRY entry is no longer discovered — stale entry; remove it.
 *   3. A `verifier`/`within` entry names a function that is not exported by the
 *      verification packages — the verifier was removed/renamed.
 *
 * `gap` entries do not fail the gate; they are the tracked backlog (printed each
 * run so the count is visible). Closing one means building its verifier and
 * flipping its classification to `verifier`.
 *
 * Run: `tsx scripts/check-signed-artifact-verifiers.ts` (exit 1 on violation).
 */
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const PROTOCOL_SRC = join(ROOT, "packages/protocol/src");
const VERIFIER_PKG_SRCS = [
  join(ROOT, "packages/crypto/src"),
  join(ROOT, "packages/encryption/src"),
  join(ROOT, "packages/state-export-client/src"),
];

export type Classification =
  | { kind: "verifier"; verifier: string }
  | { kind: "within"; verifier: string; note: string }
  | { kind: "gap"; note: string }
  // A signing-input mirror or field-helper for a registered wire artifact — not
  // a standalone artifact. Surfaced once discovery widened to the verification
  // packages (crypto/encryption/state-export-client), where the `Signable*`
  // precursors and `*Fields` bundles live alongside the canonical types they
  // feed. `canonical` names the registered REGISTRY artifact whose verifier
  // covers these bytes; the gate asserts it resolves so a precursor can't dangle.
  | { kind: "precursor"; canonical: string; note: string }
  // The `signature` field is NOT a motebit cryptographic signature — it is a
  // chain transaction identifier (Solana calls a tx id its "signature"). Such a
  // field is not a signed-artifact surface and needs no verifier. Requires a
  // note so the false-positive class is documented, not silently allowlisted.
  | { kind: "exempt"; note: string };

/**
 * Canonical mapping of every signed `@motebit/protocol` wire artifact to how it
 * is verified. Adding a signed type? Add it here. Closing a gap? Flip it to
 * `verifier`. Keyed by the exact exported type name in `packages/protocol/src`.
 *
 * Exported as the single source of truth: `check-signed-artifact-consumed-verified`
 * (#108) reads the `verifier`-kind function names to know which verifiers a relay
 * inbound consumer must actually CALL — #107 proves the verifier exists, #108
 * proves it is invoked.
 */
export const REGISTRY: Record<string, Classification> = {
  // ── A: dedicated portable verifier ──────────────────────────────────────
  AgentSettlementAnchorProof: { kind: "verifier", verifier: "verifyAgentSettlementAnchor" },
  // Federation settlement anchoring (PR6, the RFC 6962 arc-closer). The
  // inter-relay peer-audit analogue of the per-agent pair above: the signed
  // record is the verbatim leaf, the proof is the portable inclusion proof.
  FederationSettlementAnchorProof: {
    kind: "verifier",
    verifier: "verifyFederationSettlementAnchor",
  },
  // Wire artifacts defined in @motebit/crypto (not protocol/src) — discovered
  // since the scan widened to the verification packages 2026-05-30. Both cross
  // the wire and ship a portable verifier; the gate now tracks them.
  ContentArtifactManifest: { kind: "verifier", verifier: "verifyContentArtifact" },
  RevocationAnchorProof: { kind: "verifier", verifier: "verifyRevocationAnchor" },
  ComputerSessionReceipt: { kind: "verifier", verifier: "verifyComputerSessionReceipt" },
  CredentialAnchorProof: { kind: "verifier", verifier: "verifyCredentialAnchor" },
  AdjudicatorVote: { kind: "verifier", verifier: "verifyAdjudicatorVote" },
  ApprovalDecision: { kind: "verifier", verifier: "verifyApprovalDecision" },
  DisputeAppeal: { kind: "verifier", verifier: "verifyDisputeAppeal" },
  DisputeEvidence: { kind: "verifier", verifier: "verifyDisputeEvidence" },
  DisputeRequest: { kind: "verifier", verifier: "verifyDisputeRequest" },
  DisputeResolution: { kind: "verifier", verifier: "verifyDisputeResolution" },
  WitnessOmissionDispute: { kind: "verifier", verifier: "verifyWitnessOmissionDispute" },
  CollaborativeReceipt: { kind: "verifier", verifier: "verifyCollaborativeReceipt" },
  ConsolidationReceipt: { kind: "verifier", verifier: "verifyConsolidationReceipt" },
  ConsolidationMutationManifest: {
    kind: "verifier",
    verifier: "verifyConsolidationMutationManifest",
  },
  DelegationToken: { kind: "verifier", verifier: "verifyDelegation" },
  StandingDelegation: { kind: "verifier", verifier: "verifyStandingDelegation" },
  DelegationRevocation: { kind: "verifier", verifier: "verifyDelegationRevocation" },
  SignedRequestEnvelope: { kind: "verifier", verifier: "verifyRequestEnvelope" },
  DeviceRegistrationRequest: { kind: "verifier", verifier: "verifyDeviceRegistration" },
  ExecutionReceipt: { kind: "verifier", verifier: "verifyExecutionReceipt" },
  GoalExecutionManifest: { kind: "verifier", verifier: "verifyGoalExecutionManifest" },
  KeySuccessionRecord: { kind: "verifier", verifier: "verifyKeySuccession" },
  SettlementRecord: { kind: "verifier", verifier: "verifySettlement" },
  FederationSettlementRecord: { kind: "verifier", verifier: "verifyFederationSettlement" },
  ToolInvocationReceipt: { kind: "verifier", verifier: "verifyToolInvocationReceipt" },
  BalanceWaiver: { kind: "verifier", verifier: "verifyBalanceWaiver" },
  DeletionCertificate: { kind: "verifier", verifier: "verifyDeletionCertificate" },
  RetentionManifest: { kind: "verifier", verifier: "verifyRetentionManifest" },
  WitnessSolicitationRequest: {
    kind: "verifier",
    verifier: "verifyHorizonWitnessRequestSignature",
  },
  WitnessSolicitationResponse: {
    kind: "verifier",
    verifier: "verifyHorizonWitnessRequestSignature",
  },
  SkillEnvelope: { kind: "verifier", verifier: "verifySkillEnvelope" },
  SignedTransparencyDeclaration: { kind: "verifier", verifier: "verifyTransparencyDeclaration" },
  // Agent-revocation family (spec/agent-revocation-v1.md) — portable verifiers
  // in @motebit/state-export-client, against the same pinned relay key as the
  // transparency declaration. The operator's de-list power, sovereign-verifiable.
  AgentRevocationRecord: { kind: "verifier", verifier: "verifyAgentRevocationRecord" },
  AgentRevocationFeed: { kind: "verifier", verifier: "verifyAgentRevocationFeed" },
  // Migration family (spec/migration-v1.md) — portable verifiers added
  // 2026-05-24 alongside the relay hex→base64url encoding fix.
  MigrationRequest: { kind: "verifier", verifier: "verifyMigrationRequest" },
  MigrationToken: { kind: "verifier", verifier: "verifyMigrationToken" },
  DepartureAttestation: { kind: "verifier", verifier: "verifyDepartureAttestation" },
  MigrationPresentation: { kind: "verifier", verifier: "verifyMigrationPresentation" },
  CredentialBundle: { kind: "verifier", verifier: "verifyCredentialBundle" },
  // Relay discovery metadata — verifier added 2026-05-24 with the migration
  // trust-root hardening (accept-migration now verifies the source relay's
  // metadata rather than trusting a bare well-known fetch).
  RelayMetadata: { kind: "verifier", verifier: "verifyRelayMetadata" },

  // ── B: verified within a parent artifact's verifier ─────────────────────
  AgentSettlementAnchorBatch: {
    kind: "within",
    verifier: "verifyAgentSettlementAnchor",
    note: "the batch root + signature are reconstructed and verified inside verifyAgentSettlementAnchor (step 3); the Batch type is never passed standalone — the proof carries the batch fields",
  },
  CredentialAnchorBatch: {
    kind: "within",
    verifier: "verifyCredentialAnchor",
    note: "batch signature reconstructed + verified inside verifyCredentialAnchor; the Batch type is never passed standalone",
  },
  SubjectSignature: {
    kind: "within",
    verifier: "verifyDeletionCertificate",
    note: "per-role signature block verified in the verifyDeletionCertificate subject arm",
  },
  OperatorSignature: {
    kind: "within",
    verifier: "verifyDeletionCertificate",
    note: "per-role signature block verified in the verifyDeletionCertificate operator arm",
  },
  DelegateSignature: {
    kind: "within",
    verifier: "verifyDeletionCertificate",
    note: "per-role signature block verified in the verifyDeletionCertificate delegate arm",
  },
  GuardianSignature: {
    kind: "within",
    verifier: "verifyDeletionCertificate",
    note: "per-role signature block verified in the verifyDeletionCertificate guardian arm",
  },
  HorizonWitness: {
    kind: "within",
    verifier: "verifyDeletionCertificate",
    note: "witness .signature verified in the horizon-cert witness loop inside verifyDeletionCertificate",
  },
  SkillManifestMotebit: {
    kind: "within",
    verifier: "verifySkillManifest",
    note: "the `motebit` block whose optional signature is verified inside verifySkillManifest",
  },
  SkillLoadPayload: {
    kind: "within",
    verifier: "verifySkillEnvelope",
    note: "audit record carrying a copy of the envelope signature value (skill_signature); verified via the envelope, not independently signed",
  },

  // ── C: KNOWN GAP — signed but no portable verifier yet (tracked backlog) ─
  VoteRequest: {
    kind: "gap",
    note: "verified inline in services/relay/src/federation.ts (verify() over canonical JSON), not via a portable verify* — a third party cannot self-verify with @motebit/crypto alone",
  },
  ProposalResponse: {
    kind: "gap",
    note: "collaboration proposal response carries a signature but has no verifier",
  },
  // (migration family closed 2026-05-24 — moved to the verifier section above)
  SolvencyProof: { kind: "gap", note: "settlement-mode solvency proof; no verifier" },

  // ── D: EXEMPT — a `signature` field that is not a cryptographic signature ─
  SovereignSendResult: {
    kind: "exempt",
    note: "the `signature` field is a chain transaction id (Solana's term for a tx hash) returned by a sovereign-rail send, not a motebit Ed25519 signature over the object — no signed-artifact verifier applies",
  },

  // ── E: PRECURSOR — signing-input mirror / field-helper in @motebit/crypto ─
  // Surfaced by the 2026-05-30 scan widen to the verification packages. Each is
  // the unsigned-or-mirror input the crypto signer builds, or a field bundle the
  // canonical proof embeds — never passed standalone over the wire. The bytes are
  // covered by `canonical`'s registered verifier.
  SignableReceipt: {
    kind: "precursor",
    canonical: "ExecutionReceipt",
    note: "crypto signing-input mirror of the wire ExecutionReceipt; verified by verifyExecutionReceipt",
  },
  SignableDeviceRegistration: {
    kind: "precursor",
    canonical: "DeviceRegistrationRequest",
    note: "crypto signing-input mirror of DeviceRegistrationRequest; verified by verifyDeviceRegistration",
  },
  SignableMotebitAnnouncement: { kind: "verifier", verifier: "verifyMotebitAnnouncement" },
  SignableCollaborativeReceipt: {
    kind: "precursor",
    canonical: "CollaborativeReceipt",
    note: "crypto signing-input mirror of CollaborativeReceipt; verified by verifyCollaborativeReceipt",
  },
  SignableToolInvocationReceipt: {
    kind: "precursor",
    canonical: "ToolInvocationReceipt",
    note: "crypto signing-input mirror of ToolInvocationReceipt; verified by verifyToolInvocationReceipt",
  },
  CredentialAnchorProofFields: {
    kind: "precursor",
    canonical: "CredentialAnchorProof",
    note: "the field bundle whose batch_signature the parent CredentialAnchorProof embeds; verified inside verifyCredentialAnchor",
  },
  AgentSettlementAnchorProofFields: {
    kind: "precursor",
    canonical: "AgentSettlementAnchorProof",
    note: "the field bundle whose batch_signature the parent AgentSettlementAnchorProof embeds; verified inside verifyAgentSettlementAnchor",
  },
  FederationSettlementAnchorProofFields: {
    kind: "precursor",
    canonical: "FederationSettlementAnchorProof",
    note: "the field bundle whose batch_signature the parent FederationSettlementAnchorProof embeds; verified inside verifyFederationSettlementAnchor",
  },
  SuccessionRecord: {
    kind: "precursor",
    canonical: "KeySuccessionRecord",
    note: "the per-link succession-chain record (old/new/guardian key signatures); the chain is verified within key-binding verification — same artifact family as the registered KeySuccessionRecord",
  },
};

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "__tests__" || e.name === "dist" || e.name === "node_modules") return [];
      return tsFiles(full);
    }
    return e.name.endsWith(".ts") && !e.name.endsWith(".d.ts") ? [full] : [];
  });
}

/** Discover exported types carrying a `*signature` field. Mirrors the catalog
 *  scan: an exported interface/type whose body has a line declaring a field
 *  ending in `signature`. Scans `@motebit/protocol` (the canonical wire-type
 *  home) AND the verification packages, where `Signable*` precursors, `*Fields`
 *  bundles, and a few wire artifacts authored in crypto-by-exception
 *  (`ContentArtifactManifest`, `RevocationAnchorProof`) live. A name found in
 *  more than one tree keeps its first (protocol-preferred) attribution. */
function discoverSignedTypes(): Map<string, string> {
  const found = new Map<string, string>();
  for (const root of [PROTOCOL_SRC, ...VERIFIER_PKG_SRCS]) {
    for (const file of tsFiles(root)) {
      const rel = file.slice(ROOT.length + 1);
      let name: string | null = null;
      let open = false;
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const m = line.match(/^export (?:interface|type) (\w+)/);
        if (m) {
          name = m[1] ?? null;
          open = true;
        } else if (open && name && /signature\??\s*:/.test(line)) {
          // Substring (not \b): catches `signature`, `issuer_signature`,
          // `skill_signature`, … — every field whose name ends in `signature`.
          if (!found.has(name)) found.set(name, rel);
          open = false;
        } else if (/^\}/.test(line)) {
          open = false;
        }
      }
    }
  }
  return found;
}

/** Exported function + const names across the verification packages. */
function collectVerifierExports(): Set<string> {
  const names = new Set<string>();
  for (const root of VERIFIER_PKG_SRCS) {
    for (const file of tsFiles(root)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/export (?:async )?function (\w+)/g)) names.add(m[1]!);
      for (const m of src.matchAll(/export const (\w+)\s*=/g)) names.add(m[1]!);
    }
  }
  return names;
}

function main(): void {
  const discovered = discoverSignedTypes();
  const exports = collectVerifierExports();
  const errors: string[] = [];

  // 1. Every discovered signed type must be classified.
  for (const [type, file] of discovered) {
    if (!(type in REGISTRY)) {
      errors.push(
        `${type} (${file}) carries a signature field but is not classified in REGISTRY. ` +
          `Add a portable verifier (preferred) and register it as { kind: "verifier", verifier: "verifyX" }, ` +
          `or — if it is verified inside a parent — { kind: "within", ... }, ` +
          `or — if it is a Signable*/.*Fields signing-input for a registered artifact — ` +
          `{ kind: "precursor", canonical: "X", ... }, ` +
          `or explicitly track it as { kind: "gap", note: "..." }.`,
      );
    }
  }

  // 2. No stale registry entries.
  for (const type of Object.keys(REGISTRY)) {
    if (!discovered.has(type)) {
      errors.push(
        `${type} is in REGISTRY but no longer has a signature field in @motebit/protocol or a ` +
          `verification package — remove the stale entry.`,
      );
    }
  }

  // 3. Named verifiers must exist as exports.
  for (const [type, c] of Object.entries(REGISTRY)) {
    if ((c.kind === "verifier" || c.kind === "within") && !exports.has(c.verifier)) {
      errors.push(
        `${type} → ${c.verifier} is not an exported function of @motebit/crypto / encryption / state-export-client. ` +
          `The verifier was removed or renamed.`,
      );
    }
  }

  // 4. Every precursor's `canonical` must resolve to a registered artifact whose
  //    bytes are actually verified (verifier/within) — a precursor can't dangle.
  for (const [type, c] of Object.entries(REGISTRY)) {
    if (c.kind !== "precursor") continue;
    const target = REGISTRY[c.canonical];
    if (!target || (target.kind !== "verifier" && target.kind !== "within")) {
      errors.push(
        `${type} is a precursor naming canonical "${c.canonical}", but that is not a ` +
          `verifier/within REGISTRY entry — point it at the registered artifact whose verifier covers these bytes.`,
      );
    }
  }

  const gaps = Object.entries(REGISTRY).filter(([, c]) => c.kind === "gap");
  const verified = Object.values(REGISTRY).filter(
    (c) => c.kind === "verifier" || c.kind === "within",
  ).length;
  const precursors = Object.values(REGISTRY).filter((c) => c.kind === "precursor").length;

  process.stdout.write(
    `\n▸ check-signed-artifact-verifiers — every signed @motebit/protocol artifact must have a verifier ` +
      `(or be an explicitly-tracked gap). The self-attesting moat as a structural invariant: a third party ` +
      `verifies a claim with the verification packages + a public key, no relay.\n`,
  );
  process.stdout.write(
    `  scanned ${discovered.size} signed types — ${verified} verified, ${precursors} precursors, ${gaps.length} tracked gaps.\n`,
  );
  if (gaps.length > 0) {
    process.stdout.write(`  tracked gaps (no portable verifier yet — backlog):\n`);
    for (const [type, c] of gaps) {
      process.stdout.write(`    • ${type} — ${(c as { note: string }).note}\n`);
    }
  }

  if (errors.length > 0) {
    process.stderr.write(`\n✗ check-signed-artifact-verifiers failed:\n`);
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
  process.stdout.write(`✓ check-signed-artifact-verifiers: every signed type is classified.\n`);
}

// Run only when invoked directly — #108 imports REGISTRY from this module.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
