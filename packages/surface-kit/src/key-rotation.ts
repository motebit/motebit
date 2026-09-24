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
  hexToBytes,
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
  /**
   * The key this surface has PUBLISHED as current (config / localStorage /
   * keyring public-key slot; the identity file's key where one is kept). A
   * second witness: when it disagrees with the key the private key derives
   * to, a commit was interrupted between its writes, and the write-ahead is
   * what bridges the two — it is finished, never cleared as stale.
   */
  publishedPublicKeyHex?(): Promise<string | null>;
  writeAhead: {
    /** `null` = nothing held; `"unreadable"` = something is there but could not be read. Never conflate them. */
    load(): Promise<HeldRotation | null | "unreadable">;
    save(held: HeldRotation): Promise<void>;
    clear(): Promise<void>;
  };
  /**
   * Called ONLY after the relay is known (I1). Must store the key before
   * returning, and must be IDEMPOTENT: a commit interrupted between its
   * writes is finished by calling it again with the same arguments, so an
   * identity file already on the new key must not be re-signed twice.
   */
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
  | { kind: "no-relay-configured" }
  /** The last run's commit was interrupted between its writes; finished from the write-ahead. */
  | { kind: "interrupted-commit-finished"; newPublicKeyHex: string };

/**
 * Parse a stored write-ahead. `null` for nothing stored; `"unreadable"` for
 * anything present that is not a well-formed HeldRotation — a torn write, a
 * future shape, a decrypt that failed. Every adapter goes through this so an
 * unreadable slot is never mistaken for an empty one.
 */
export function parseHeldRotation(
  raw: string | null | undefined,
): HeldRotation | null | "unreadable" {
  if (raw == null || raw === "") return null;
  try {
    const h = JSON.parse(raw) as Partial<HeldRotation>;
    if (
      typeof h.motebit_id !== "string" ||
      typeof h.old_public_key !== "string" ||
      typeof h.new_public_key !== "string" ||
      typeof h.new_private_key_hex !== "string" ||
      typeof h.written_at !== "number" ||
      h.record == null
    ) {
      return "unreadable";
    }
    return h as HeldRotation;
  } catch {
    return "unreadable";
  }
}

export type KeyRotationOutcome =
  | {
      kind: "rotated";
      newPublicKeyHex: string;
      /** What the relay did: recorded this link, already held it (finished from the write-ahead), or holds nothing / was not configured. */
      relay: "recorded" | "already-held" | "none";
      /** The key the relay held before this run, or null when it held none / was not consulted. */
      relayKeyBefore: string | null;
      notes: KeyRotationNote[];
    }
  /** Outcome at the relay unknown; the write-ahead is kept and the next run resolves it by reading. */
  | { kind: "held"; newPublicKeyHex: string; reason: string; notes: KeyRotationNote[] }
  | {
      kind: "stopped";
      state:
        | "unreachable"
        | "diverged"
        | "refused"
        | "no-key"
        /** A write-ahead is present but cannot be read; nothing is guessed. */
        | "held-unreadable"
        /** The write-ahead's private key does not derive to the key it names. */
        | "held-corrupt"
        /** Published key and held key disagree with no write-ahead bridging them. */
        | "inconsistent";
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

  // 1. What this device holds IN FLIGHT — read without conflating "nothing"
  //    with "something I cannot read".
  const loaded = await ports.writeAhead.load();
  if (loaded === "unreadable") {
    return stopped(
      "held-unreadable",
      "a rotation write-ahead is present on this device but could not be read; nothing was changed — retry, and if it persists the write-ahead must be inspected before rotating again",
    );
  }
  const any: HeldRotation | null = loaded;

  // 1b. The second witness. If the key this surface PUBLISHED disagrees with
  //     the key the private key derives to, a previous commit was interrupted
  //     between its writes. The write-ahead that names BOTH keys is what
  //     bridges them: finish that commit (adapters make it idempotent) rather
  //     than clearing it as stale — clearing it would destroy the only copy
  //     of the succession record and let a fresh rotation mint on top of a
  //     torn state, corrupting the chain silently.
  const published = ports.publishedPublicKeyHex ? await ports.publishedPublicKeyHex() : null;
  if (published !== null && published !== "" && published !== oldPublicKeyHex) {
    const bridges =
      any != null &&
      any.motebit_id === ports.motebitId &&
      ((any.old_public_key === published && any.new_public_key === oldPublicKeyHex) ||
        (any.old_public_key === oldPublicKeyHex && any.new_public_key === published));
    if (!bridges) {
      return stopped(
        "inconsistent",
        `this device's published key (${published.slice(0, 16)}…) and the key it holds (${oldPublicKeyHex.slice(0, 16)}…) disagree, and no write-ahead bridges them; restore the identity before rotating`,
      );
    }
    // Which key is the NEW one is what the write-ahead says, not which
    // write happened to land.
    const target = any;
    const newPrivateKey = hexToBytes(target.new_private_key_hex);
    allocated.push(newPrivateKey);
    const derived = bytesToHex(await getPublicKeyBySuite(newPrivateKey, IDENTITY_SUITE));
    if (derived !== target.new_public_key) {
      return stopped(
        "held-corrupt",
        "the write-ahead's private key does not derive to the key it names; nothing was changed — recover through the identity's guardian",
      );
    }
    await ports.commit({
      privateKeyHex: target.new_private_key_hex,
      publicKeyHex: target.new_public_key,
      record: target.record,
    });
    await ports.writeAhead.clear();
    notes.push({ kind: "interrupted-commit-finished", newPublicKeyHex: target.new_public_key });
    return {
      kind: "rotated",
      newPublicKeyHex: target.new_public_key,
      relay: "already-held",
      relayKeyBefore: published,
      notes,
    };
  }

  // 1c. A write-ahead for another identity, or one that names neither the
  //     key this device holds nor its published key, is evidence of a
  //     different problem (an older store restored over a newer one), never
  //     an instruction: said, then cleared. One that names the held key on
  //     either side is never stale.
  let held: HeldRotation | null = null;
  if (any != null) {
    const namesHeldKey =
      any.old_public_key === oldPublicKeyHex || any.new_public_key === oldPublicKeyHex;
    if (any.motebit_id === ports.motebitId && any.old_public_key === oldPublicKeyHex) held = any;
    else if (any.motebit_id !== ports.motebitId || !namesHeldKey) {
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
    relayKeyBefore: string | null,
  ): Promise<KeyRotationOutcome> => {
    // Local state moves ONLY here, and only after the relay is known (I1).
    await ports.commit({ privateKeyHex: newPrivateKeyHex, publicKeyHex: newPublicKeyHex, record });
    await ports.writeAhead.clear();
    return { kind: "rotated", newPublicKeyHex, relay, relayKeyBefore, notes };
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
      null,
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
      {
        const newPrivateKey = hexToBytes(held.new_private_key_hex);
        allocated.push(newPrivateKey);
        const derived = bytesToHex(await getPublicKeyBySuite(newPrivateKey, IDENTITY_SUITE));
        if (derived !== held.new_public_key) {
          return stopped(
            "held-corrupt",
            "the relay already holds the new key from a rotation this device started, but the write-ahead's private key does not derive to it; this device cannot finish the rotation — recover through the identity's guardian",
          );
        }
      }
      return commit(
        held.record,
        held.new_private_key_hex,
        held.new_public_key,
        "already-held",
        oldPublicKeyHex,
      );
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
        null,
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
          relay.relayKey,
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
