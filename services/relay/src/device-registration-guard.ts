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
 */
import type { IdentityManager } from "@motebit/core-identity";
import type { DatabaseDriver } from "@motebit/persistence";

export interface DeviceRegistrationRefusal {
  code: "DEVICE_ID_TAKEN" | "DEVICE_KEY_CONFLICT" | "IDENTITY_KEY_CONFLICT";
  error: string;
  remediation: string;
}

/**
 * `null` when the registration may proceed; otherwise why not. Read-only:
 * a refusal must never be a half-registration, so nothing here writes.
 */
export async function refusePublicDeviceRegistration(
  deps: { identityManager: IdentityManager; db: DatabaseDriver },
  req: { motebitId: string; deviceId: string | undefined; publicKey: string },
): Promise<DeviceRegistrationRefusal | null> {
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

  // Every key this identity already answers to. The registry key counts:
  // a service-mode motebit registers through /agents/register and may
  // have no device row at all, and token auth falls back to the registry
  // — so "no device yet" is not "no owner yet".
  const held = new Set<string>();
  for (const d of await deps.identityManager.listDevices(req.motebitId)) {
    if (d.public_key !== "") held.add(d.public_key.toLowerCase());
  }
  const registry = deps.db
    .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
    .get(req.motebitId) as { public_key: string | null } | undefined;
  if (registry?.public_key != null && registry.public_key !== "") {
    held.add(registry.public_key.toLowerCase());
  }

  if (held.size > 0 && !held.has(key)) {
    return {
      code: "IDENTITY_KEY_CONFLICT",
      error: "identity is already registered under a different public key",
      remediation:
        "link this device from one that already holds the identity (pairing), or rotate the key via /api/v1/agents/:motebit_id/rotate-key",
    };
  }
  return null;
}
