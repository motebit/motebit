/**
 * Surface-agnostic key rotation — the state machine of
 * `docs/proposals/key-rotation-client-v1.md` §3, shared by every surface.
 *
 * Four surfaces each grew their own rotation and three were wrong the same
 * way (#709): mint, store the new key locally, THEN tell the relay — with a
 * bearer signed by the key just stored, which no relay can verify, posting
 * to a route that does not exist, the refusal swallowed. Every rotation
 * left the identity on a key the relay had never heard of, with no way
 * back. The CLI was fixed first (#737, `apps/cli/src/rotation.ts`); this is
 * the same algorithm with the platform inverted into ports, so the other
 * surfaces adopt it as thin adapters instead of re-forking it.
 *
 * Two invariants, and every branch below serves one of them:
 *
 *   I1 — local state moves to the new key ONLY after the relay is known to
 *        hold it. So (local new, relay old) — the split every surface used
 *        to produce — is unreachable.
 *   I2 — the new key is durable, in the surface's protected medium, before
 *        it is ever sent. So the relay can never hold a key this device
 *        cannot produce.
 *
 * The resume path never re-signs and never replays: it READS the relay's
 * own answer to "may a rotation depart from this key" (served by the relay
 * from the rule it enforces) and classifies from that. A lost response is
 * resolved on the next run by reading.
 *
 * ### Ports (dependency inversion — the surface carries the divergence)
 *   - `loadPrivateKeyHex`  — the key this device holds (IndexedDB keystore,
 *                            SecureStore, Tauri keyring, …)
 *   - `writeAhead`         — the new key + record, held in the SAME protected
 *                            medium as the private key; this module never
 *                            encrypts, the medium is the protection
 *   - `commit`             — move local state to the new key (store it, update
 *                            the published public key, re-sign an identity
 *                            file if the surface keeps one)
 *   - `syncUrl`            — `null` when no relay is configured: rotate
 *                            locally and SAY so, never guess
 */
import { rotateIdentityKeys } from "@motebit/core-identity";
import {
  bytesToHex,
  getPublicKeyBySuite,
  hexPublicKeyToDidKey,
  secureErase,
} from "@motebit/encryption";
import type { KeySuccessionRecord } from "@motebit/sdk";
import { readSuccessionState, submitSuccessionToRelay } from "@motebit/sync-engine";

const IDENTITY_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

/** The write-ahead a surface holds between "sent" and "confirmed". */
export interface HeldRotation {
  motebit_id: string;
  /** The key this rotation departs from — it must still be the local key to matter. */
  old_public_key: string;
  new_public_key: string;
  record: KeySuccessionRecord;
  /** Plain hex; the port's medium protects it, exactly as it protects the live key. */
  new_private_key_hex: string;
  written_at: number;
}

export interface KeyRotationPorts {
  motebitId: string;
  /** The device this identity is known by at the relay; `""` ⇒ the identity's own did:key. */
  deviceId: string;
  /** Relay base URL, or `null` when none is configured. */
  syncUrl: string | null;
  loadPrivateKeyHex(): Promise<string | null>;
  writeAhead: {
    load(): Promise<HeldRotation | null>;
    save(held: HeldRotation): Promise<void>;
    clear(): Promise<void>;
  };
  /** Called ONLY after the relay is known (I1). Must store the key before returning. */
  commit(next: {
    privateKeyHex: string;
    publicKeyHex: string;
    record: KeySuccessionRecord;
  }): Promise<void>;
  reason?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export type KeyRotationNote =
  | { kind: "stale-write-ahead-cleared"; motebitId: string; oldPublicKey: string }
  | { kind: "write-ahead-discarded"; ageMs: number }
  | { kind: "no-relay-configured" };

export type KeyRotationOutcome =
  | {
      kind: "rotated";
      newPublicKeyHex: string;
      /** What the relay did: recorded this link, already held it (finished from the write-ahead), or holds nothing / was not configured. */
      relay: "recorded" | "already-held" | "none";
      notes: KeyRotationNote[];
    }
  /** Outcome at the relay unknown; the write-ahead is kept and the next run resolves it by reading. */
  | { kind: "held"; newPublicKeyHex: string; reason: string; notes: KeyRotationNote[] }
  | {
      kind: "stopped";
      state: "unreachable" | "diverged" | "refused" | "no-key";
      message: string;
      relayKey?: string;
      notes: KeyRotationNote[];
    };

/** Thrown by `rotateOrThrow` for a stop or a hold: the message is the honest next action. */
export class KeyRotationError extends Error {
  constructor(readonly outcome: Extract<KeyRotationOutcome, { kind: "stopped" | "held" }>) {
    super(
      outcome.kind === "held"
        ? `the relay's answer was lost (${outcome.reason}); your current key still works and nothing local was changed — rotate again and it finishes if the relay recorded it, or starts afresh`
        : outcome.message,
    );
    this.name = "KeyRotationError";
  }
}

export async function performKeyRotation(ports: KeyRotationPorts): Promise<KeyRotationOutcome> {
  const allocated: Uint8Array[] = [];
  try {
    return await rotateWithin(ports, allocated);
  } finally {
    for (const k of allocated) secureErase(k);
  }
}

/** The promise contract every settings screen already has: resolve on rotated, reject otherwise. */
export async function rotateOrThrow(
  ports: KeyRotationPorts,
): Promise<Extract<KeyRotationOutcome, { kind: "rotated" }>> {
  const outcome = await performKeyRotation(ports);
  if (outcome.kind !== "rotated") throw new KeyRotationError(outcome);
  return outcome;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return out;
}

async function rotateWithin(
  ports: KeyRotationPorts,
  allocated: Uint8Array[],
): Promise<KeyRotationOutcome> {
  const notes: KeyRotationNote[] = [];
  const now = ports.now ?? Date.now;
  const stopped = (
    state: Extract<KeyRotationOutcome, { kind: "stopped" }>["state"],
    message: string,
    relayKey?: string,
  ): KeyRotationOutcome => ({
    kind: "stopped",
    state,
    message,
    ...(relayKey !== undefined ? { relayKey } : {}),
    notes,
  });

  // 0. What this device HOLDS — derived from the private key, the thing
  //    actually in hand, never from a published copy that may be stale.
  const oldPrivateKeyHex = await ports.loadPrivateKeyHex();
  if (oldPrivateKeyHex == null || oldPrivateKeyHex === "") {
    return stopped("no-key", "no private key is available on this device — bootstrap first");
  }
  const oldPrivateKey = hexToBytes(oldPrivateKeyHex);
  allocated.push(oldPrivateKey);
  const oldPublicKey = await getPublicKeyBySuite(oldPrivateKey, IDENTITY_SUITE);
  const oldPublicKeyHex = bytesToHex(oldPublicKey);

  // 1. What this device holds IN FLIGHT. A write-ahead for another identity
  //    or from a key this device no longer holds is evidence of a different
  //    problem, never an instruction: said, then cleared.
  const any = await ports.writeAhead.load();
  let held: HeldRotation | null = null;
  if (any != null) {
    if (any.motebit_id === ports.motebitId && any.old_public_key === oldPublicKeyHex) held = any;
    else {
      notes.push({
        kind: "stale-write-ahead-cleared",
        motebitId: any.motebit_id,
        oldPublicKey: any.old_public_key,
      });
      await ports.writeAhead.clear();
    }
  }

  const commit = async (
    record: KeySuccessionRecord,
    newPrivateKeyHex: string,
    newPublicKeyHex: string,
    relay: "recorded" | "already-held" | "none",
  ): Promise<KeyRotationOutcome> => {
    // Local state moves ONLY here, and only after the relay is known (I1).
    await ports.commit({ privateKeyHex: newPrivateKeyHex, publicKeyHex: newPublicKeyHex, record });
    await ports.writeAhead.clear();
    return { kind: "rotated", newPublicKeyHex, relay, notes };
  };

  const mintFresh = async () => {
    if (held != null) {
      notes.push({ kind: "write-ahead-discarded", ageMs: Math.max(0, now() - held.written_at) });
      await ports.writeAhead.clear();
    }
    const minted = await rotateIdentityKeys({
      oldPrivateKey,
      oldPublicKey,
      ...(ports.reason !== undefined ? { reason: ports.reason } : {}),
    });
    allocated.push(minted.newPrivateKey);
    return minted;
  };

  // No relay configured: there is nothing to read and nothing to record.
  // Said in the outcome, never a flag the caller sets.
  if (ports.syncUrl == null || ports.syncUrl === "") {
    notes.push({ kind: "no-relay-configured" });
    const minted = await mintFresh();
    return commit(
      minted.successionRecord,
      bytesToHex(minted.newPrivateKey),
      minted.newPublicKeyHex,
      "none",
    );
  }

  // 2. Where does the relay stand? Read as the relay's own answer.
  const relay = await readSuccessionState({
    syncUrl: ports.syncUrl,
    motebitId: ports.motebitId,
    localPublicKey: oldPublicKeyHex,
    ...(held ? { heldNewPublicKey: held.new_public_key } : {}),
    ...(ports.fetchImpl ? { fetchImpl: ports.fetchImpl } : {}),
  });

  switch (relay.state) {
    case "unreachable":
      // S6. Rotating now would produce the split the moment the relay is
      // back. The old key stays; the write-ahead, if any, stays too.
      return stopped(
        "unreachable",
        `the relay could not be read (${relay.reason}); nothing was changed — retry when it is reachable`,
      );
    case "diverged":
      // S5. Someone else rotated first. Guardian recovery is the remedy.
      return stopped(
        "diverged",
        `the relay holds a key this device does not (${relay.relayKey.slice(0, 16)}…); a rotation cannot depart from a key the relay has already left — recover through the identity's guardian`,
        relay.relayKey,
      );
    case "applied": {
      // S1. The relay already holds B from a write-ahead of ours. Commit
      // from it; nothing is sent.
      /* c8 ignore start -- unreachable by construction: `applied` is only
         returned when `heldNewPublicKey` was sent, which requires `held`.
         Kept so the type narrows and a future classifier change fails
         closed here instead of committing from a write-ahead that is not
         there. */
      if (held == null) {
        return stopped("diverged", "the relay holds a key this device does not", relay.relayKey);
      }
      /* c8 ignore stop */
      return commit(held.record, held.new_private_key_hex, held.new_public_key, "already-held");
    }
    case "unregistered": {
      // S4. The relay has no key to update and no chain to extend. Read,
      // not declared. A later registration introduces the new key.
      const minted = await mintFresh();
      return commit(
        minted.successionRecord,
        bytesToHex(minted.newPrivateKey),
        minted.newPublicKeyHex,
        "none",
      );
    }
    case "current": {
      // S0. Write-ahead FIRST (I2), then submit signed by the RETIRING key,
      // then commit.
      const minted = await mintFresh();
      const newPrivateKeyHex = bytesToHex(minted.newPrivateKey);
      await ports.writeAhead.save({
        motebit_id: ports.motebitId,
        old_public_key: oldPublicKeyHex,
        new_public_key: minted.newPublicKeyHex,
        record: minted.successionRecord,
        new_private_key_hex: newPrivateKeyHex,
        written_at: now(),
      });
      const submitted = await submitSuccessionToRelay({
        syncUrl: ports.syncUrl,
        motebitId: ports.motebitId,
        deviceId: ports.deviceId !== "" ? ports.deviceId : hexPublicKeyToDidKey(oldPublicKeyHex),
        signingKey: oldPrivateKey,
        record: minted.successionRecord,
        ...(ports.fetchImpl ? { fetchImpl: ports.fetchImpl } : {}),
      });
      if (submitted.ok) {
        return commit(
          minted.successionRecord,
          newPrivateKeyHex,
          minted.newPublicKeyHex,
          submitted.applied ? "recorded" : "already-held",
        );
      }
      if (submitted.kind === "refused") {
        // The relay said no. Nothing local changed; the write-ahead is for
        // a rotation that will never land.
        await ports.writeAhead.clear();
        return stopped(
          "refused",
          `the relay refused the rotation — ${submitted.reason}; your current key still works and nothing was changed`,
        );
      }
      // Unknown. The relay may hold B. The write-ahead stays.
      return {
        kind: "held",
        newPublicKeyHex: minted.newPublicKeyHex,
        reason: submitted.reason,
        notes,
      };
    }
    /* c8 ignore start -- exhaustiveness: every RelaySuccessionState is handled above; this is the compile-time guard against a new state arriving unmodelled. */
    default: {
      const never: never = relay;
      throw new Error(`unmodelled relay state: ${JSON.stringify(never)}`);
    }
    /* c8 ignore stop */
  }
}
