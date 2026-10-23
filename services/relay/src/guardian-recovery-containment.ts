/**
 * P0 CONTAINMENT GATE (2026-10-13) — guardian recovery is OFF on this relay.
 *
 * A guardian recovery (`KeySuccessionRecord` with `recovery` set, authorized by
 * `guardian_signature` instead of `old_key_signature`, spec identity-v1 §3.8.3)
 * re-keys an identity on the proven guardian's signature alone, with no caller
 * check. Guardian provenance (`provenGuardianOf` in `identity-keys.ts`) takes
 * the newest evidence row and ignores `set_under_key`, rotation never clears
 * that evidence, and the evidence upsert bumps `recorded_at`. Confirmed by
 * execution on main:
 *
 *  - S1: whoever holds the current key K1 registers a guardian G_a of their
 *    own; it is proven at once, the owner's guardian stops working, and G_a
 *    recovers the identity to an attacker key immediately.
 *  - S2: after the owner rotates K1 → K2, G_a is STILL proven and recovers K2
 *    to an attacker key with no current key — a persistent backdoor.
 *  - S4: a stale CLI daemon re-sends an OLD guardian attestation under the
 *    current key; the removed guardian is proven again and can recover.
 *
 * So every door that can APPLY a guardian recovery refuses it with 503 before
 * it reads guardian state or writes anything:
 *
 *  - `POST /api/v1/agents/:motebitId/rotate-key` with `recovery` set
 *    (`key-rotation.ts`);
 *  - `POST /api/v1/agents/register` carrying a `succession` with `recovery`
 *    set (`agents.ts`);
 *  - `applySuccession` (`succession-apply.ts`), the ONE writer of a recorded
 *    link, refuses a recovery record as a backstop, so a door added later
 *    cannot apply one either;
 *  - `POST /api/v1/agents/accept-migration` (the guardian-recovery chain
 *    inside a presented identity file) is already off behind
 *    `MIGRATION_ARRIVALS_ENABLED` (#1114).
 *
 * Ordinary rotation (`old_key_signature`) and guardian REGISTRATION are
 * unchanged. Refusing every recovery costs the owner who lost their key the
 * guardian path until the permanent fix lands (stated, not hidden).
 *
 * RE-ENABLE CONDITION: the permanent fix (guardian provenance bound to the key
 * it was set under, cleared or re-proven across rotation, never revived by a
 * replayed attestation) has merged AND passed a cold adversarial review. Flip
 * this to `true` in that PR and revert this containment's test edits (titles
 * prefixed `[recovery suspended]`). Typed `boolean` so the guarded code stays
 * type-checked and lint sees no constant condition.
 */
export const GUARDIAN_RECOVERY_ENABLED: boolean = false;

/** The auth-event reason a suspended recovery is recorded under (rule 6). */
export const GUARDIAN_RECOVERY_SUSPENDED_REASON = "guardian_recovery_suspended";

/**
 * Is this succession record a guardian recovery? Truthiness, exactly as the
 * verifier decides it: `verifyKeySuccession` takes the guardian branch on
 * `if (record.recovery)`, so `"yes"` or `1` is a recovery too and must be
 * gated as one.
 */
export function isGuardianRecovery(record: unknown): boolean {
  return (
    typeof record === "object" &&
    record !== null &&
    Boolean((record as { recovery?: unknown }).recovery)
  );
}

/** Should a door refuse this record under the containment? */
export function guardianRecoverySuspended(record: unknown): boolean {
  return !GUARDIAN_RECOVERY_ENABLED && isGuardianRecovery(record);
}
