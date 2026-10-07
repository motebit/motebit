/**
 * A hardware-attestation claim about S is admitted only when S published it.
 *
 * `/credentials/submit` is public — a credential's issuer signature is its
 * auth — so a peer `AgentTrustCredential` can be issued and submitted by
 * anyone about anyone. Its `hardware_attestation` claim feeds the discover
 * badge and the routing aggregate (`docs/doctrine/hardware-attestation.md`:
 * scoring, never a gate). A `secure_enclave` receipt has no vendor chain —
 * any P-256 key can sign a body naming S's identity key — so verifying the
 * receipt alone cannot tell S's hardware from a stranger's forgery.
 *
 * The anchor is S itself. The legitimate peer flow (runtime `agent-trust.ts`)
 * re-issues a claim S attached to its OWN device record through
 * `POST /api/v1/agents/:motebitId/devices/:deviceId/hardware-attestation`, a
 * request signed under that device's key. So a peer claim is admitted only
 * when it is exactly one of S's published claims, and — where the relay can
 * verify the receipt in-package (`secure_enclave`) — the receipt verifies
 * against the key of the device that published it. Platform-chain
 * verification for the injected-verifier platforms stays the issuer's job.
 */
import { verifyHardwareAttestationClaim } from "@motebit/crypto";
import type { DatabaseDriver } from "@motebit/persistence";

/** Why a credential's hardware claim was refused. */
export type HardwareClaimRefusal =
  | "hardware_claim:malformed"
  | "hardware_claim:not_published_by_subject"
  | "hardware_claim:receipt_invalid";

interface ClaimShape {
  platform: string;
  attestation_receipt?: unknown;
  key_exported?: unknown;
}

function asClaim(raw: unknown): ClaimShape | null {
  if (raw == null || typeof raw !== "object") return null;
  const platform = (raw as { platform?: unknown }).platform;
  return typeof platform === "string" ? (raw as ClaimShape) : null;
}

function sameClaim(a: ClaimShape, b: ClaimShape): boolean {
  return (
    a.platform === b.platform &&
    (a.attestation_receipt ?? null) === (b.attestation_receipt ?? null) &&
    (a.key_exported === true) === (b.key_exported === true)
  );
}

/** The `hardware_attestation` claim a credential carries, if any (`undefined` = none). */
export function hardwareClaimOf(vc: { credentialSubject?: unknown }): unknown {
  const subject = vc.credentialSubject;
  if (subject == null || typeof subject !== "object") return undefined;
  return (subject as { hardware_attestation?: unknown }).hardware_attestation;
}

/**
 * Admit `rawClaim` as a claim about `motebitId` only if one of the identity's
 * device rows published exactly this claim (and, for `secure_enclave`, the
 * receipt verifies against that device's key).
 */
export function admitHardwareClaim(
  db: DatabaseDriver,
  motebitId: string,
  rawClaim: unknown,
): { ok: true } | { refused: HardwareClaimRefusal } {
  const claim = asClaim(rawClaim);
  if (!claim) return { refused: "hardware_claim:malformed" };

  const rows = db
    .prepare(
      "SELECT public_key, hardware_attestation_credential FROM devices WHERE motebit_id = ? AND hardware_attestation_credential IS NOT NULL",
    )
    .all(motebitId) as Array<{ public_key: string; hardware_attestation_credential: string }>;

  let receiptFailed = false;
  for (const row of rows) {
    let published: ClaimShape | null;
    try {
      published = asClaim(
        hardwareClaimOf(
          JSON.parse(row.hardware_attestation_credential) as { credentialSubject?: unknown },
        ),
      );
    } catch {
      continue;
    }
    if (!published || !sameClaim(published, claim)) continue;
    if (claim.platform === "secure_enclave") {
      // No `verifiers` argument: secure_enclave verifies in-package and synchronously.
      const result = verifyHardwareAttestationClaim(
        claim as Parameters<typeof verifyHardwareAttestationClaim>[0],
        row.public_key,
      );
      if ("then" in result || !result.valid) {
        receiptFailed = true;
        continue;
      }
    }
    return { ok: true };
  }
  return {
    refused: receiptFailed
      ? "hardware_claim:receipt_invalid"
      : "hardware_claim:not_published_by_subject",
  };
}
