/**
 * Who may change what this relay believes an identity's key is — the
 * rules both succession doors (`/rotate-key`, and the succession path of
 * `/agents/register`) and the guardian door answer to.
 *
 * Sibling of `device-registration-guard.ts`, and for the same reason: a
 * device row is not inert. Its `public_key` is what
 * `verifySignedTokenForDevice` verifies an owner token against. Rotation
 * is the remedy for a lost or stolen machine, and it recorded the new key
 * without ending the old one — device rows kept the key they were
 * registered with, so the holder of a rotated-away key remained a full
 * first-person principal here. Three rules close that:
 *
 *  1. A succession is recorded only under the caller's OWN identity, and
 *     only when it departs from a key the identity holds at this relay.
 *  2. Recording a succession re-keys, in the same synchronous step, every
 *     device row that held the old key. A device linked WITHOUT key
 *     transfer holds its own key, which is not the identity's, and is
 *     left alone. A machine that has not yet received the new key is cut
 *     off until it does — which is what a rotation is for.
 *  3. A guardian may recover the identity to any key, so installing one
 *     is an act of the identity key: the caller's token must have been
 *     verified under it (a linked device's token proves only its own
 *     key), and an installed guardian is never REPLACED by registration.
 *
 * The functions are synchronous and read or write through `db` directly,
 * so a caller can keep a check and the write it guards in one tick.
 */
import type { DatabaseDriver } from "@motebit/persistence";

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * The key a device token was verified under — the same resolution
 * `verifySignedTokenForDevice` performs: the device row's key, else the
 * registry's. `null` when neither exists (the token could not have
 * verified, so no caller reaches this with `null` honestly).
 */
export function callerVerifiedKey(
  db: DatabaseDriver,
  motebitId: string,
  deviceId: string | undefined,
): string | null {
  if (deviceId != null && deviceId !== "") {
    const device = db
      .prepare("SELECT public_key FROM devices WHERE device_id = ? AND motebit_id = ?")
      .get(deviceId, motebitId) as { public_key: string | null } | undefined;
    if (device?.public_key != null && device.public_key !== "") return device.public_key;
  }
  const agent = db
    .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
    .get(motebitId) as { public_key: string | null } | undefined;
  return agent?.public_key != null && agent.public_key !== "" ? agent.public_key : null;
}

/** Does any device row of this identity hold `key`? */
export function identityHoldsKey(db: DatabaseDriver, motebitId: string, key: string): boolean {
  const rows = db
    .prepare("SELECT public_key FROM devices WHERE motebit_id = ? AND public_key != ''")
    .all(motebitId) as Array<{ public_key: string }>;
  return rows.some((r) => same(r.public_key, key));
}

/**
 * Rule 2. Call in the same synchronous step as the write that makes
 * `newKey` the identity's key. Returns how many rows moved.
 */
export function rekeyDevicesOnSuccession(
  db: DatabaseDriver,
  motebitId: string,
  oldKey: string,
  newKey: string,
): number {
  const written = db
    .prepare(
      "UPDATE devices SET public_key = ? WHERE motebit_id = ? AND lower(public_key) = lower(?)",
    )
    .run(newKey, motebitId, oldKey) as { changes?: number } | undefined;
  return written?.changes ?? 0;
}

export interface GuardianRefusal {
  status: 403 | 409;
  code: "GUARDIAN_NOT_IDENTITY_KEY" | "GUARDIAN_ALREADY_SET";
  message: string;
}

/**
 * Rule 3. `callerDeviceId` is `undefined` for the operator's master
 * token, which is not a first-person principal and is not judged here.
 */
export function refuseGuardianInstall(
  db: DatabaseDriver,
  req: {
    motebitId: string;
    identityKey: string;
    claimedGuardianKey: string;
    firstPerson: boolean;
    callerDeviceId: string | undefined;
  },
): GuardianRefusal | null {
  const existing = db
    .prepare("SELECT guardian_public_key FROM agent_registry WHERE motebit_id = ?")
    .get(req.motebitId) as { guardian_public_key: string | null } | undefined;
  const installed = existing?.guardian_public_key;
  if (installed != null && installed !== "" && !same(installed, req.claimedGuardianKey)) {
    return {
      status: 409,
      code: "GUARDIAN_ALREADY_SET",
      message:
        "this identity already has a guardian; registration never replaces one — a guardian can recover the identity to any key, so changing it is not a side effect of re-registering",
    };
  }
  if (req.firstPerson) {
    const verifiedUnder = callerVerifiedKey(db, req.motebitId, req.callerDeviceId);
    if (verifiedUnder == null || !same(verifiedUnder, req.identityKey)) {
      return {
        status: 403,
        code: "GUARDIAN_NOT_IDENTITY_KEY",
        message:
          "a guardian is installed by the identity key: this token was verified under a device's own key, which does not speak for the identity",
      };
    }
  }
  return null;
}
