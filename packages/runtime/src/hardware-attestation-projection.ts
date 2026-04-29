/**
 * Project the most-recent verified `hardware_attestation` claim from
 * the credential store onto an `AgentTrustRecord`.
 *
 * Why this lives here. The `agent_trust` row carries no HA column —
 * caching it would invite drift on revocation or re-attestation. The
 * authoritative source is the latest peer-issued `AgentTrustCredential`
 * whose `credentialSubject.hardware_attestation` was verified at issue
 * time by `verifyHardwareAttestationClaim` (see `agent-trust.ts`). At
 * read time we project the stored claim onto the record so the Agents
 * panel can render the per-row badge without surfaces having to
 * re-aggregate credentials themselves.
 *
 * The runtime's credential store keys credentials by their subject DID
 * (`vc.credentialSubject.id`), which `agent-trust.ts` computes as
 * `hexPublicKeyToDidKey(public_key)` when the remote agent's identity
 * key is known, falling back to `did:motebit:${remote_motebit_id}` when
 * it isn't. Both forms are queried so the projection works regardless
 * of which path issued the credential.
 *
 * The projected shape carries `score` so surfaces never need to import
 * `@motebit/semiring`. Compute path: `scoreAttestation` from
 * `@motebit/semiring/hardware-attestation.ts` — the canonical encoder.
 * Drift gate: the panel-shape `AgentHardwareAttestation` MUST stay
 * byte-aligned with `AgentTrustRecord["hardware_attestation"]` and with
 * `HW_ATTESTATION_*` constants in semiring.
 *
 * Pure read, best-effort. Parse failures, missing claims, and absent
 * stores all collapse to `null` (no badge shown) — the trust path
 * never breaks because the projection couldn't resolve a claim.
 */

import { hexPublicKeyToDidKey } from "@motebit/encryption";
import { scoreAttestation } from "@motebit/semiring";
import type {
  AgentTrustRecord,
  CredentialStoreAdapter,
  HardwareAttestationClaim,
  StoredCredential,
} from "@motebit/sdk";

const TRUST_VC_TYPE = "AgentTrustCredential";

type HardwareAttestationProjection = NonNullable<AgentTrustRecord["hardware_attestation"]>;

interface TrustVcShape {
  credentialSubject?: {
    hardware_attestation?: HardwareAttestationClaim;
  };
}

export function readLatestHardwareAttestationClaim(
  store: CredentialStoreAdapter,
  record: AgentTrustRecord,
): HardwareAttestationProjection | null {
  const candidates: StoredCredential[] = [];
  const seen = new Set<string>();
  const collect = (subjectKey: string): void => {
    let rows: StoredCredential[];
    try {
      rows = store.listBySubject(subjectKey);
    } catch {
      return;
    }
    for (const row of rows) {
      if (row.credential_type !== TRUST_VC_TYPE) continue;
      if (seen.has(row.credential_id)) continue;
      seen.add(row.credential_id);
      candidates.push(row);
    }
  };

  if (record.public_key != null && record.public_key !== "") {
    try {
      collect(hexPublicKeyToDidKey(record.public_key));
    } catch {
      // public_key may not be valid hex — fall through to the did:motebit form.
    }
  }
  collect(`did:motebit:${record.remote_motebit_id}`);

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.issued_at - a.issued_at);

  for (const row of candidates) {
    let parsed: TrustVcShape;
    try {
      parsed = JSON.parse(row.credential_json) as TrustVcShape;
    } catch {
      continue;
    }
    const claim = parsed.credentialSubject?.hardware_attestation;
    if (claim != null) {
      return {
        platform: claim.platform,
        key_exported: claim.key_exported,
        score: scoreAttestation(claim),
      };
    }
  }
  return null;
}
