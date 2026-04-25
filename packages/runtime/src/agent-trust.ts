/**
 * Agent Trust — trust record management and trust-level transitions.
 *
 * Extracted from MotebitRuntime. Handles trust accumulation from
 * verified receipts, trust-level transitions with credential issuance,
 * and MCP interaction recording.
 */

import { EventType, AgentTrustLevel } from "@motebit/sdk";
import type {
  ExecutionReceipt,
  AgentTrustRecord,
  AgentTrustStoreAdapter,
  HardwareAttestationClaim,
} from "@motebit/sdk";
import type { EventStore } from "@motebit/event-log";
import {
  issueTrustCredential,
  issueReputationCredential,
  hexPublicKeyToDidKey,
  verifyVerifiableCredential,
} from "@motebit/encryption";
import { verifyHardwareAttestationClaim, type HardwareAttestationVerifiers } from "@motebit/crypto";
import { evaluateTrustTransition } from "@motebit/semiring";
import type { AgentGraphManager } from "./agent-graph.js";

// === Types ===

/**
 * Callback the runtime injects to resolve a peer's published self-issued
 * AgentTrustCredential bearing a `hardware_attestation` claim. Returns
 * the per-device list (one peer may register multiple devices, each with
 * its own hardware attestation). The hook fires after a successful
 * delegation interaction; the local motebit verifies one of the returned
 * credentials and issues a peer AgentTrustCredential about the worker
 * carrying the verified claim — Phase 1 of the hardware-attestation
 * peer flow.
 *
 * Implementation typically hits `GET /agent/:motebitId/capabilities`
 * and returns `response.hardware_attestations`. Tests inject in-memory
 * resolvers. A null return ≡ no claim observed (the truthful absence
 * case, distinct from `platform: "software"`).
 */
export type HardwareAttestationFetcher = (remoteMotebitId: string) => Promise<
  ReadonlyArray<{
    device_id: string;
    public_key: string;
    hardware_attestation_credential?: string;
  }>
>;

export interface AgentTrustDeps {
  motebitId: string;
  agentTrustStore: AgentTrustStoreAdapter | null;
  events: EventStore;
  agentGraph: AgentGraphManager;
  signingKeys: { privateKey: Uint8Array; publicKey: Uint8Array } | null;
  onCredentialIssued?: (
    vc: import("@motebit/encryption").VerifiableCredential<unknown>,
    subjectMotebitId: string,
  ) => void;
  /**
   * Optional fetcher for the peer's self-issued hardware-attestation
   * credentials. When provided, after the existing reputation-credential
   * issuance fires, the runtime pulls the peer's claims, verifies them
   * via `verifyHardwareAttestationClaim`, and issues an
   * `AgentTrustCredential` carrying the verified claim. Best-effort:
   * any failure (network, parse, signature, hardware verification) is
   * swallowed and the trust path proceeds without a hardware credential.
   */
  getRemoteHardwareAttestations?: HardwareAttestationFetcher;
  /**
   * Optional injected platform verifiers. When provided, peer hardware
   * claims of platform `device_check` / `tpm` / `play_integrity` /
   * `webauthn` route through the matching adapter (each pinned to a
   * vendor trust root). Surfaces typically inject this via
   * `MotebitRuntime.setHardwareAttestationVerifiers(buildHardwareVerifiers())`
   * from `@motebit/verify` at boot. Without it, only `secure_enclave`
   * (verified in-package via P-256) and the `software` sentinel produce
   * valid outcomes; the four external platforms fall through to "verifier
   * not wired" and are dropped before peer-credential issuance.
   *
   * Phase 1 of the hardware-attestation peer flow shipped without this
   * field. Phase 2 added it to unblock the four external platforms.
   */
  hardwareAttestationVerifiers?: HardwareAttestationVerifiers;
}

// === Trust from Receipt ===

/**
 * Update trust for a remote agent based on a verified execution receipt.
 * Trust progression: Unknown → FirstContact (on first interaction) → Verified (after 5+ verified).
 * Never auto-promotes to Trusted — requires explicit owner action.
 */
export async function bumpTrustFromReceipt(
  deps: AgentTrustDeps,
  receipt: ExecutionReceipt,
  verified: boolean,
): Promise<void> {
  const {
    motebitId,
    agentTrustStore,
    events,
    agentGraph,
    signingKeys,
    onCredentialIssued,
    getRemoteHardwareAttestations,
    hardwareAttestationVerifiers,
  } = deps;

  if (agentTrustStore == null) return;
  if (!verified) return; // Unverified receipts don't affect trust

  const remoteMotebitId = receipt.motebit_id;
  const now = Date.now();
  const existing = await agentTrustStore.getAgentTrust(motebitId, remoteMotebitId);

  const taskSucceeded = receipt.status === "completed";
  const taskFailed = receipt.status === "failed";

  // Quality gate: a "completed" receipt with very low quality (empty result,
  // no tool usage) is reclassified as a failure. Distinguishes "good work"
  // from "merely valid work."
  let resultQuality = 1.0;
  if (taskSucceeded) {
    const resultStr = typeof receipt.result === "string" ? receipt.result : "";
    const lengthScore = Math.min(resultStr.length, 500) / 500;
    const toolScore = Math.min(receipt.tools_used?.length ?? 0, 3) / 3;
    const latencyMs = (receipt.completed_at ?? 0) - (receipt.submitted_at ?? 0);
    const latencyScore = latencyMs > 0 ? Math.min(Math.max(latencyMs, 500), 5000) / 5000 : 0.5;
    resultQuality = 0.6 * lengthScore + 0.3 * toolScore + 0.1 * latencyScore;
  }
  const effectiveSuccess = taskSucceeded && resultQuality >= 0.2;
  const effectiveFailure = taskFailed || (taskSucceeded && resultQuality < 0.2);

  if (existing != null) {
    // Quality EMA update
    const alpha = 0.3;
    const prevQuality = existing.avg_quality ?? 1.0;
    const newQuality = alpha * resultQuality + (1 - alpha) * prevQuality;

    const updated: AgentTrustRecord = {
      ...existing,
      last_seen_at: now,
      interaction_count: existing.interaction_count + 1,
      successful_tasks: (existing.successful_tasks ?? 0) + (effectiveSuccess ? 1 : 0),
      failed_tasks: (existing.failed_tasks ?? 0) + (effectiveFailure ? 1 : 0),
      avg_quality: newQuality,
      quality_sample_count: (existing.quality_sample_count ?? 0) + 1,
    };
    // Evaluate trust level transition (promotion or demotion)
    const newLevel = evaluateTrustTransition(updated);
    if (newLevel != null) {
      const previousLevel = updated.trust_level;
      updated.trust_level = newLevel;
      // Emit trust transition event for audit trail
      try {
        await events.appendWithClock({
          event_id: crypto.randomUUID(),
          motebit_id: motebitId,
          timestamp: now,
          event_type: EventType.TrustLevelChanged,
          payload: {
            remote_motebit_id: remoteMotebitId,
            previous_level: previousLevel,
            new_level: newLevel,
            successful_tasks: updated.successful_tasks,
            failed_tasks: updated.failed_tasks,
          },
          tombstoned: false,
        });
      } catch {
        // Event emission is best-effort
      }
      // Issue trust credential for the transition (best-effort)
      if (signingKeys) {
        try {
          let subjectDid = `did:motebit:${remoteMotebitId}`;
          if (updated.public_key) {
            try {
              subjectDid = hexPublicKeyToDidKey(updated.public_key);
            } catch {
              // public_key may not be hex — fall back to did:motebit
            }
          }
          const vc = await issueTrustCredential(
            {
              trust_level: updated.trust_level,
              interaction_count: updated.interaction_count,
              successful_tasks: updated.successful_tasks,
              failed_tasks: updated.failed_tasks,
              first_seen_at: updated.first_seen_at,
              last_seen_at: updated.last_seen_at,
            },
            signingKeys.privateKey,
            signingKeys.publicKey,
            subjectDid,
          );
          onCredentialIssued?.(vc, remoteMotebitId);
        } catch {
          // Credential issuance is best-effort
        }
      }
    }
    await agentTrustStore.setAgentTrust(updated);
    agentGraph.invalidate();

    // Issue peer reputation credential on every completed receipt (best-effort).
    // Skip self-delegation: if the delegating agent IS the worker, the credential
    // is self-attestation and carries no trust signal. This prevents sybil farming
    // where an operator delegates tasks between their own agents at zero cost.
    if (signingKeys && effectiveSuccess && remoteMotebitId !== motebitId) {
      try {
        let subjectDid = `did:motebit:${remoteMotebitId}`;
        if (updated.public_key) {
          try {
            subjectDid = hexPublicKeyToDidKey(updated.public_key);
          } catch {
            // public_key may not be hex — fall back to did:motebit
          }
        }
        const successful = updated.successful_tasks ?? 0;
        const failed = updated.failed_tasks ?? 0;
        const successRate = successful / Math.max(1, successful + failed);
        const avgLatency =
          receipt.completed_at && receipt.submitted_at
            ? receipt.completed_at - receipt.submitted_at
            : 0;
        const vc = await issueReputationCredential(
          {
            success_rate: successRate,
            avg_latency_ms: avgLatency,
            task_count: updated.interaction_count,
            trust_score: successRate,
            availability: 1.0,
            measured_at: now,
          },
          signingKeys.privateKey,
          signingKeys.publicKey,
          subjectDid,
        );
        onCredentialIssued?.(vc, remoteMotebitId);

        // Hardware-attestation peer flow — Phase 1.
        //
        // After issuing the reputation credential, pull the worker's
        // self-published hardware-attestation credentials, verify, and
        // issue a peer AgentTrustCredential carrying the verified claim.
        // This is what makes hardware attestation visible to routing —
        // the cascade-mint produced self-issued credentials are inert
        // until a peer (us, here) verifies and re-issues them as peer
        // credentials. See lesson_hardware_attestation_self_issued_dead_drop.md.
        //
        // Best-effort: any failure (network, parse, signature, hardware
        // claim verification) leaves the reputation credential standing
        // alone. The trust path doesn't break.
        if (getRemoteHardwareAttestations && updated.public_key) {
          try {
            const remoteAttestations = await getRemoteHardwareAttestations(remoteMotebitId);
            // Pick the first credential whose subject identity_public_key
            // matches the worker's identity key. The cascade-mint always
            // sets identity_public_key to the device's identity Ed25519
            // public key, so this is the right binding check.
            const matching = remoteAttestations.find(
              (entry) =>
                entry.public_key.toLowerCase() === (updated.public_key ?? "").toLowerCase() &&
                entry.hardware_attestation_credential != null,
            );
            if (matching && matching.hardware_attestation_credential) {
              let parsedVc: import("@motebit/encryption").VerifiableCredential<{
                hardware_attestation?: HardwareAttestationClaim;
              }>;
              try {
                parsedVc = JSON.parse(matching.hardware_attestation_credential) as typeof parsedVc;
              } catch {
                return; // Best-effort: malformed credential is the no-claim case.
              }
              const vcSignatureValid = await verifyVerifiableCredential(parsedVc);
              if (vcSignatureValid) {
                const claim = parsedVc.credentialSubject.hardware_attestation;
                if (claim) {
                  // Run the platform-aware verifier facade. Phase 1 passes
                  // no `verifiers` argument — the software sentinel returns
                  // a truthful `valid: false, platform: "software"` outcome,
                  // and we still fold it into the issued credential because
                  // "software-only" IS information the routing graph wants.
                  // Phase 2 wires real platform adapters and changes the
                  // accept rule.
                  const hwResult = await verifyHardwareAttestationClaim(
                    claim,
                    updated.public_key,
                    hardwareAttestationVerifiers,
                  );
                  // Accept rule:
                  //   - `valid: true` from any platform → real verified hardware claim
                  //   - `platform: "software"` → truthful no-hardware sentinel
                  //     (`valid: false` by spec design — the facade's
                  //      "no hardware verification channel" message is the
                  //      correct outcome, NOT an error). Issuer still folds
                  //      it forward; the routing semiring scores it as 0.1.
                  // Anything else (`device_check`/`tpm`/`play_integrity`/
                  // `webauthn` with `valid: false`) is dropped — these
                  // platforms require a verifier, and a falsy result means
                  // either the verifier wasn't injected or the claim
                  // failed verification. Both are non-acceptance cases.
                  const accepted = hwResult.valid || claim.platform === "software";
                  if (accepted) {
                    const trustVc = await issueTrustCredential(
                      {
                        trust_level: updated.trust_level,
                        interaction_count: updated.interaction_count,
                        successful_tasks: updated.successful_tasks ?? 0,
                        failed_tasks: updated.failed_tasks ?? 0,
                        first_seen_at: updated.first_seen_at,
                        last_seen_at: updated.last_seen_at,
                        hardware_attestation: claim,
                      },
                      signingKeys.privateKey,
                      signingKeys.publicKey,
                      subjectDid,
                    );
                    onCredentialIssued?.(trustVc, remoteMotebitId);
                  }
                }
              }
            }
          } catch {
            // Hardware-attestation peer flow is best-effort.
          }
        }
      } catch {
        // Credential issuance is best-effort
      }
    }
  } else {
    // First interaction — create at FirstContact
    const record: AgentTrustRecord = {
      motebit_id: motebitId,
      remote_motebit_id: remoteMotebitId,
      trust_level: AgentTrustLevel.FirstContact,
      first_seen_at: now,
      last_seen_at: now,
      interaction_count: 1,
      successful_tasks: effectiveSuccess ? 1 : 0,
      failed_tasks: effectiveFailure ? 1 : 0,
      avg_quality: resultQuality,
      quality_sample_count: 1,
    };
    await agentTrustStore.setAgentTrust(record);
    agentGraph.invalidate();

    // Issue peer reputation credential on first completed receipt (best-effort).
    // Skip self-delegation — same sybil defense as the existing-trust path.
    if (signingKeys && effectiveSuccess && remoteMotebitId !== motebitId) {
      try {
        const subjectDid = `did:motebit:${remoteMotebitId}`;
        const avgLatency =
          receipt.completed_at && receipt.submitted_at
            ? receipt.completed_at - receipt.submitted_at
            : 0;
        const vc = await issueReputationCredential(
          {
            success_rate: 1.0,
            avg_latency_ms: avgLatency,
            task_count: 1,
            trust_score: 1.0,
            availability: 1.0,
            measured_at: now,
          },
          signingKeys.privateKey,
          signingKeys.publicKey,
          subjectDid,
        );
        onCredentialIssued?.(vc, remoteMotebitId);
      } catch {
        // Credential issuance is best-effort
      }
    }
  }
}

// === MCP Interaction Recording ===

/**
 * Record or update trust for a remote motebit after an MCP interaction.
 * If no record exists, creates one at FirstContact level.
 */
export async function recordAgentInteraction(
  deps: AgentTrustDeps,
  remoteMotebitId: string,
  publicKey?: string,
  motebitType?: string,
): Promise<AgentTrustRecord | null> {
  const { motebitId, agentTrustStore, agentGraph } = deps;

  if (agentTrustStore == null) return null;
  const now = Date.now();
  const existing = await agentTrustStore.getAgentTrust(motebitId, remoteMotebitId);
  if (existing != null) {
    const updated: AgentTrustRecord = {
      ...existing,
      last_seen_at: now,
      interaction_count: existing.interaction_count + 1,
      public_key: publicKey ?? existing.public_key,
      notes: motebitType ? `type:${motebitType}` : existing.notes,
    };
    await agentTrustStore.setAgentTrust(updated);
    agentGraph.invalidate();
    return updated;
  }
  const record: AgentTrustRecord = {
    motebit_id: motebitId,
    remote_motebit_id: remoteMotebitId,
    trust_level: AgentTrustLevel.FirstContact,
    public_key: publicKey,
    first_seen_at: now,
    last_seen_at: now,
    interaction_count: 1,
    notes: motebitType ? `type:${motebitType}` : undefined,
  };
  await agentTrustStore.setAgentTrust(record);
  agentGraph.invalidate();
  return record;
}
