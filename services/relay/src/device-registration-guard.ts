/**
 * Who may add a device to an identity — the one rule both PUBLIC
 * registration doors answer to.
 *
 * `POST /api/v1/devices/register-self` and `POST /api/v1/agents/bootstrap`
 * take no bearer: the request is its own auth. That is right for an
 * identity's first moment (`spec/device-self-registration-v1.md` §2 —
 * registration is cheap because trust is earned) and wrong for every
 * moment after it, because a device row is not inert. Its `public_key`
 * is what `verifySignedTokenForDevice` verifies an owner token against,
 * so whoever can add a row under an identity can mint that identity's
 * tokens.
 *
 * `bootstrap` carried a hijack check and `register-self`, written later,
 * checked for a conflict only on the SAME device id — so a new device id
 * under an existing identity was accepted with any key. Two doors, two
 * rules, and the weaker one was the door. They now share this function,
 * so a third door cannot be built without it being the obvious thing to
 * call.
 *
 * The rule: once an identity holds a key, a public registration under it
 * must present a key it ALREADY holds. A second machine after Link
 * Device's key transfer, and a restore from seed, both do — same
 * identity key, fresh device id. Adding a device with a NEW key is the
 * authenticated pairing flow's job (an existing device approves it), and
 * replacing a key is `/rotate-key`'s (the current key signs the new one).
 *
 * Before an identity holds a key (#875): both doors prove possession of the
 * key they name (`verifyKeyPossession` — bootstrap was unsigned until
 * then), and an id shaped as a sovereign commitment may take only the key
 * it commits to (`refuseSovereignIdSquat`). `/agents/register` asks the
 * same two questions of its body key.
 */
import type { IdentityManager } from "@motebit/core-identity";
import type { DatabaseDriver } from "@motebit/persistence";
import { verifyDeviceRegistration, type SignableDeviceRegistration } from "@motebit/encryption";
import {
  claimsSovereignId,
  keysHeldBy,
  proveSovereignFirstKey,
  sovereignLineage,
} from "./identity-keys.js";

/**
 * What a client must do when a key arrives without proof of possession —
 * the one repair instruction both writers (#875) return.
 */
export const KEY_PROOF_REMEDIATION =
  "sign the request with the private key of public_key: a device-registration signature " +
  "(signDeviceRegistration in @motebit/crypto — JCS + Ed25519 over {motebit_id, device_id, " +
  "public_key, timestamp, suite}, spec/device-self-registration-v1.md) within 5 minutes of " +
  "the relay's clock. An older client that sends no signature must be upgraded.";

export type KeyPossessionResult =
  | { proven: true }
  | {
      proven: false;
      reason:
        | "missing"
        | "malformed"
        | "stale"
        | "unsupported_suite"
        | "bad_signature"
        | "motebit_id_mismatch"
        | "public_key_mismatch";
    };

/**
 * Proof of possession (#875): `proof` is a device-registration request
 * (`spec/device-self-registration-v1.md`) signed by the key it names, fresh
 * within the same ±5-minute window as `register-self`, and naming EXACTLY
 * the identity and key the door is about to write. The key is proven by its
 * own signature — `verifyDeviceRegistration` from `@motebit/crypto`, the
 * one verifier register-self uses; nothing here trusts the presenter.
 * Read-only.
 */
export async function verifyKeyPossession(
  proof: unknown,
  expected: { motebitId: string; publicKey: string },
  now: number = Date.now(),
): Promise<KeyPossessionResult> {
  if (proof == null) return { proven: false, reason: "missing" };
  if (typeof proof !== "object" || Array.isArray(proof)) {
    return { proven: false, reason: "malformed" };
  }
  const signed = proof as SignableDeviceRegistration;
  if (signed.signature === undefined && signed.suite === undefined) {
    return { proven: false, reason: "missing" };
  }
  const verdict = await verifyDeviceRegistration(signed, now);
  if (!verdict.valid) return { proven: false, reason: verdict.reason };
  if (signed.motebit_id !== expected.motebitId) {
    return { proven: false, reason: "motebit_id_mismatch" };
  }
  if (signed.public_key !== expected.publicKey) {
    return { proven: false, reason: "public_key_mismatch" };
  }
  return { proven: true };
}

export interface DeviceRegistrationRefusal {
  code:
    | "DEVICE_ID_TAKEN"
    | "DEVICE_KEY_CONFLICT"
    | "IDENTITY_KEY_CONFLICT"
    | "SOVEREIGN_ID_KEY_MISMATCH";
  error: string;
  remediation: string;
}

export { claimsSovereignId };

/**
 * The pre-registration squat (#875): an id that CLAIMS to be the sovereign
 * commitment to a key may take its FIRST key only when it is exactly that
 * commitment to the presented key (`proveSovereignFirstKey`, DA3 — the same
 * arithmetic E-sov uses). Proof of possession alone does not close the
 * squat: X proves possession of X's OWN key, and would otherwise take V's
 * not-yet-registered `deriveSovereignMotebitId(K_V)` under it. `null` when
 * the first key may proceed. Asked of an identity that holds no STANDING
 * key (`sovereignLineage`) — once one does, the held-key rule answers. A
 * pre-#875 squat row is not a standing key, so it never turns this check off
 * (#875 review F1).
 */
export async function refuseSovereignIdSquat(
  motebitId: string,
  publicKey: string,
): Promise<DeviceRegistrationRefusal | null> {
  if (!claimsSovereignId(motebitId)) return null;
  if ((await proveSovereignFirstKey(motebitId, publicKey)) !== null) return null;
  return {
    code: "SOVEREIGN_ID_KEY_MISMATCH",
    error: "motebit_id is a sovereign id that is not the commitment to this public_key",
    remediation:
      "a sovereign motebit_id must equal deriveSovereignMotebitId(public_key) of its genesis key — register with the genesis key, or arrive through migration",
  };
}

/**
 * `null` when the registration may proceed; otherwise why not. Read-only:
 * a refusal must never be a half-registration, so nothing here writes.
 */
export async function refusePublicDeviceRegistration(
  deps: { identityManager: IdentityManager; db: DatabaseDriver },
  req: { motebitId: string; deviceId: string | undefined; publicKey: string },
): Promise<DeviceRegistrationRefusal | null> {
  // Case-folded, exactly as main (#758 review): an exact guard refused a
  // lowercase K joining a legacy UPPER(K) identity that main admits. The risk
  // the exact guard targeted — a second-spelling row a rotation misses — is
  // closed where it lives: rotation retires device rows case-insensitively
  // (DB4, `applySuccession`).
  const key = req.publicKey.toLowerCase();

  if (req.deviceId != null) {
    // The device table is keyed by device_id ALONE and written with
    // INSERT OR REPLACE, so a lookup scoped to the claimed motebit_id
    // misses a row that belongs to someone else — and the write then
    // replaces it, moving another identity's device under this one.
    const holder = await deps.identityManager.getDevice(req.deviceId);
    if (holder != null && holder.motebit_id !== req.motebitId) {
      return {
        code: "DEVICE_ID_TAKEN",
        error: "device_id is already registered to a different identity",
        remediation: "mint a fresh device_id for this machine",
      };
    }
    if (holder != null && holder.public_key !== "" && holder.public_key.toLowerCase() !== key) {
      return {
        code: "DEVICE_KEY_CONFLICT",
        error: "device exists with a different public key",
        remediation: "use /api/v1/agents/:motebit_id/rotate-key",
      };
    }
  }

  // Every key this identity already answers to (Q-held, §5b), from the one
  // function whose law is that it contains whatever auth will verify against
  // (L1): the holder's key, the registry's (a service-mode motebit registers
  // through /agents/register and may have no device row — "no device yet" is
  // not "no owner yet"), the chain head's, and every keyed device row's. The first build left
  // the holder out of this set (§5a A1), so a stranger's key passed for an
  // identity whose registry key was blank while its holder still answered.
  //
  // For a SOVEREIGN-shaped id only keys that STAND are owners
  // (`sovereignLineage`, #875 review F1): a key a relay before #875 let X
  // plant under V's `deriveSovereignMotebitId(K_V)` is a squat, not an owner,
  // so it neither admits X's own registration nor blocks V's. The presented
  // key must itself stand; with no standing key on file the identity is
  // fresh, and the door parks the squat rows (`parkSovereignSquat`).
  const lineage = await sovereignLineage(deps.db, req.motebitId, req.publicKey);
  const standing = lineage === null ? null : new Set([...lineage].map((k) => k.toLowerCase()));
  const held = new Set(
    [...keysHeldBy(deps.db, req.motebitId)]
      .map((k) => k.toLowerCase())
      .filter((k) => standing === null || standing.has(k)),
  );

  if (lineage !== null && !lineage.has(req.publicKey)) {
    return held.size === 0
      ? refuseSovereignIdSquat(req.motebitId, req.publicKey)
      : identityKeyConflict();
  }

  // A fresh identity: nothing is on file, so the one question left is
  // whether the id itself names a DIFFERENT key (#875).
  if (held.size === 0) {
    return refuseSovereignIdSquat(req.motebitId, req.publicKey);
  }

  if (!held.has(key)) return identityKeyConflict();
  return null;
}

function identityKeyConflict(): DeviceRegistrationRefusal {
  return {
    code: "IDENTITY_KEY_CONFLICT",
    error: "identity is already registered under a different public key",
    remediation:
      "link this device from one that already holds the identity (pairing), or rotate the key via /api/v1/agents/:motebit_id/rotate-key",
  };
}
