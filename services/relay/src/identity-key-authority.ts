/**
 * Who may change what this relay believes an identity's key is — the
 * rules both succession doors (the rotate-key route, and the succession
 * path of agent registration), the guardian door and first registration
 * answer to.
 *
 * Sibling of `device-registration-guard.ts`, and for the same reason: a
 * device row is not inert. Its `public_key` is what
 * `verifySignedTokenForDevice` verifies an owner token against. Rotation
 * is the remedy for a lost or stolen machine, and it recorded the new key
 * without ending the old one — device rows kept the key they were
 * registered with, so the holder of a rotated-away key remained a full
 * first-person principal here.
 *
 * Everything below turns on ONE definition, because a device linked
 * without key transfer is a first-person caller holding a key that is
 * NOT the identity's:
 *
 *   The identity key, as far as this relay can PROVE it, is — in order —
 *   the registry's key; else the head of the recorded succession; else a
 *   key the `motebit_id` itself commits to (`verifySovereignBinding`);
 *   else, for an id that commits to nothing, the one key EVERY keyed
 *   device row agrees on. Where rows disagree and nothing else decides,
 *   the relay cannot tell the identity's key from a linked device's, and
 *   says so rather than guess — `registered_at` is refreshed on every
 *   re-registration, so "the first device" is not a fact it holds. The
 *   operator's master token is the recourse for an identity stuck there.
 *
 * The rules:
 *
 *  1. A succession is recorded only under the caller's OWN identity, and
 *     only when it departs from the provable identity key.
 *  2. Recording a succession re-keys, in the same transaction, every
 *     device row that held the old key, and ends the identity's open
 *     sockets (they were authenticated under it). A device linked under
 *     its own key is left alone. A machine that has not yet received the
 *     new key is refused until it does — which is what a rotation is for.
 *  3. A guardian may recover the identity to any key, so installing one
 *     is an act of the identity key: the key the caller's token VERIFIED
 *     UNDER must be it, and an installed guardian is never REPLACED by
 *     registration.
 *  4. A first-person caller may establish a registry key only if it is
 *     the provable identity key and the key its own token verified under.
 *  5. Pairing's key-transfer door takes no bearer, and needs none: the
 *     ONLY key it may write to a device row is the provable identity key.
 *     Without that it was a standing, unauthenticated way to set a device
 *     row back to a rotated-away key — undoing rule 2.
 *
 * A caller is judged by the key captured when its token was verified
 * (`callerVerifiedKey` in request context), never by re-reading a row at
 * handler time, and a caller whose captured key is no longer what that
 * row holds is refused outright: a request can be held open across a
 * rotation.
 */
import type { DatabaseDriver } from "@motebit/persistence";
import { verifySovereignBinding } from "@motebit/crypto";

const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** A first-person caller as the auth middleware left it; `null` for the operator's master token. */
export interface FirstPersonCaller {
  deviceId: string | undefined;
  /** The key the token verified under, captured at verification. */
  verifiedKey: string | undefined;
}

/** The key a token for this device would verify under NOW — the verifier's own resolution. */
function currentCredentialKey(
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

/**
 * Is the key this caller proved STILL a credential? Synchronous — call it
 * in the same tick as the write it guards, after the handler's last await.
 */
export function callerIsStillCurrent(
  db: DatabaseDriver,
  motebitId: string,
  caller: FirstPersonCaller,
): boolean {
  if (caller.verifiedKey == null || caller.verifiedKey === "") return false;
  const now = currentCredentialKey(db, motebitId, caller.deviceId);
  return now != null && same(now, caller.verifiedKey);
}

export type IdentityKeyBasis = "registry" | "succession" | "sovereign_binding" | "sole_device_key";

/**
 * Is `candidate` the identity's key, provably? Returns the basis, or
 * `null`. See the module doc for the order and why it stops where it does.
 */
export async function provableIdentityKey(
  db: DatabaseDriver,
  motebitId: string,
  candidate: string,
  /**
   * A device whose row is ABOUT to take `candidate` (pairing's key
   * transfer): its present key is the one being replaced, so it has no
   * say in whether the others agree.
   */
  exceptDeviceId?: string,
): Promise<IdentityKeyBasis | null> {
  const agent = db
    .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
    .get(motebitId) as { public_key: string | null } | undefined;
  if (agent?.public_key != null && agent.public_key !== "") {
    return same(agent.public_key, candidate) ? "registry" : null;
  }
  const head = db
    .prepare(
      "SELECT new_public_key FROM relay_key_successions WHERE motebit_id = ? ORDER BY id DESC LIMIT 1",
    )
    .get(motebitId) as { new_public_key: string } | undefined;
  if (head != null) return same(head.new_public_key, candidate) ? "succession" : null;
  if (await verifySovereignBinding(motebitId, candidate)) return "sovereign_binding";
  const keys = new Set(
    (
      db
        .prepare(
          "SELECT public_key FROM devices WHERE motebit_id = ? AND public_key != '' AND device_id != ?",
        )
        .all(motebitId, exceptDeviceId ?? "") as Array<{ public_key: string }>
    ).map((r) => r.public_key.toLowerCase()),
  );
  return keys.size === 1 && keys.has(candidate.toLowerCase()) ? "sole_device_key" : null;
}

/**
 * Rule 2's write. Call INSIDE the transaction that makes `newKey` the
 * identity's key. Returns how many rows moved.
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

/** WebSocket close code: the key this session authenticated under has been rotated away. */
export const WS_CLOSE_KEY_ROTATED = 4401;

/**
 * Rule 2's other half. A socket is authenticated once, at connect, so
 * re-keying the rows does nothing to one already open under the old key.
 * Every socket of the identity is closed; a machine holding the new key
 * reconnects, one that does not cannot.
 */
export function endSessionsOnSuccession(
  connections: Map<string, Array<{ ws: { close(code?: number, reason?: string): void } }>>,
  motebitId: string,
): number {
  const peers = [...(connections.get(motebitId) ?? [])];
  for (const peer of peers) {
    try {
      peer.ws.close(WS_CLOSE_KEY_ROTATED, "identity key rotated — reconnect with the new key");
    } catch {
      /* already closing */
    }
  }
  return peers.length;
}

export interface AuthorityRefusal {
  status: 401 | 403 | 409;
  code:
    | "CALLER_KEY_NOT_CURRENT"
    | "GUARDIAN_NOT_IDENTITY_KEY"
    | "GUARDIAN_ALREADY_SET"
    | "REGISTRATION_NOT_IDENTITY_KEY"
    | "IDENTITY_KEY_UNPROVABLE";
  message: string;
}

/** Rule 3. Synchronous and read-only; `caller` is `null` for the master token, which is not judged. */
export function refuseGuardianInstall(
  db: DatabaseDriver,
  req: {
    motebitId: string;
    /** The key whose holder must be asking: the registry's, or mid-rotation the one being rotated AWAY from. */
    identityKey: string;
    claimedGuardianKey: string;
    caller: FirstPersonCaller | null;
  },
): AuthorityRefusal | null {
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
  if (req.caller != null) {
    const proved = req.caller.verifiedKey;
    if (proved == null || !same(proved, req.identityKey)) {
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

/**
 * Rule 4. A first-person caller establishing a registry key where the
 * relay holds none. Async (sovereign binding hashes); the caller re-checks
 * `callerIsStillCurrent` in the tick it writes.
 */
export async function refuseFirstRegistrationKey(
  db: DatabaseDriver,
  req: { motebitId: string; publicKey: string; caller: FirstPersonCaller },
): Promise<AuthorityRefusal | null> {
  if (req.caller.verifiedKey == null || !same(req.caller.verifiedKey, req.publicKey)) {
    return {
      status: 403,
      code: "REGISTRATION_NOT_IDENTITY_KEY",
      message:
        "the key being registered is not the key this token was verified under: a caller establishes only a key it has proved",
    };
  }
  if ((await provableIdentityKey(db, req.motebitId, req.publicKey)) == null) {
    return {
      status: 409,
      code: "IDENTITY_KEY_UNPROVABLE",
      message:
        "this relay cannot tell this identity's key from a linked device's: its devices hold different keys and its id commits to none of them",
    };
  }
  return null;
}

/** The stored shape of a succession record — what both doors persist. */
export interface RecordedSuccession {
  old_public_key: string;
  new_public_key: string;
  timestamp: number;
  reason?: string | null;
  old_key_signature?: string | null;
  new_key_signature: string;
  recovery?: boolean;
  guardian_signature?: string | null;
}

/**
 * Rule 2, as ONE write both succession doors share: the succession row,
 * whatever makes the new key the registry's (`writeRegistry`), and the
 * device re-key — in one transaction, so no crash or throw can leave the
 * registry saying K2 while device rows still verify tokens under K1. A
 * retry could never repair that state: the record's old key would no
 * longer match.
 *
 * Re-checks, inside the transaction, that the record still departs from
 * the identity's CURRENT key: every check before this point sat before an
 * await, and two rotations from one key must not both land (a branched
 * history). Returns `false`, having written nothing, when it no longer
 * does. Sessions are ended after the commit.
 */
export function recordSuccession(
  db: DatabaseDriver,
  connections: Parameters<typeof endSessionsOnSuccession>[0] | undefined,
  motebitId: string,
  record: RecordedSuccession,
  writeRegistry: () => void,
): boolean {
  const landed = db.transaction(() => {
    const agent = db
      .prepare("SELECT public_key FROM agent_registry WHERE motebit_id = ?")
      .get(motebitId) as { public_key: string | null } | undefined;
    const head = db
      .prepare(
        "SELECT new_public_key FROM relay_key_successions WHERE motebit_id = ? ORDER BY id DESC LIMIT 1",
      )
      .get(motebitId) as { new_public_key: string } | undefined;
    const current =
      agent?.public_key != null && agent.public_key !== ""
        ? agent.public_key
        : (head?.new_public_key ?? null);
    if (current != null && !same(current, record.old_public_key)) return false;

    db.prepare(
      `INSERT INTO relay_key_successions (motebit_id, old_public_key, new_public_key, timestamp, reason, old_key_signature, new_key_signature, recovery, guardian_signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      motebitId,
      record.old_public_key,
      record.new_public_key,
      record.timestamp,
      record.reason ?? null,
      record.old_key_signature ?? null,
      record.new_key_signature,
      record.recovery === true ? 1 : 0,
      record.guardian_signature ?? null,
    );
    writeRegistry();
    rekeyDevicesOnSuccession(db, motebitId, record.old_public_key, record.new_public_key);
    return true;
  });
  if (landed && connections != null) endSessionsOnSuccession(connections, motebitId);
  return landed;
}
