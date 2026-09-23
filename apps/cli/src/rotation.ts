/**
 * Key rotation as a state machine — `docs/proposals/key-rotation-client-v1.md`.
 *
 * Two holders matter: this machine (L) and the relay (R). A rotation is the
 * move (A, A) → (B, B). The states the relay can be in are READ from its
 * public succession route before anything is minted, and every decision
 * below serves one of two invariants:
 *
 *   I1 — L moves to B only after R is known to hold B. So (B, A), the state
 *        every shipped client used to leave behind, is unreachable.
 *   I2 — B is durable (encrypted, on disk) before it is ever sent. So R can
 *        never hold a key L cannot produce.
 *
 * The resume path never re-signs and never replays. It reads: if the relay
 * already holds B, it commits from the write-ahead and mints no token at
 * all — which is why the two tests that sank #710 ("the retry carries the
 * new key" / "the new key is unverifiable") were both describing this state
 * and both wrong about what the retry carries. It carries nothing.
 *
 * Everything that touches the world is injected, so the activation test
 * drives THIS function against an in-process relay with the relay half
 * applied (`docs/doctrine/composition-preserves-enforcement.md`).
 */
import * as fs from "node:fs";
import { verify, rotate as rotateIdentityFile } from "@motebit/identity-file";
import { rotateIdentityKeys } from "@motebit/core-identity";
import { readSuccessionState, submitSuccessionToRelay } from "@motebit/sync-engine";
import type { KeySuccessionRecord } from "@motebit/sdk";
import {
  bytesToHex,
  getPublicKeyBySuite,
  hexPublicKeyToDidKey,
  secureErase,
} from "@motebit/encryption";
import type { FullConfig } from "./config.js";
import { decryptPrivateKey, encryptPrivateKey, fromHex } from "./identity.js";
import type { PendingRotation } from "./pending-rotation.js";

export interface RotationDeps {
  /** The motebit.md to rotate. Read, verified, rewritten only on commit. */
  identityPath: string;
  loadConfig: () => FullConfig;
  saveConfig: (config: FullConfig) => void;
  pending: {
    load: (motebitId: string, currentPublicKey: string) => PendingRotation | null;
    /** Whatever write-ahead exists, whoever it belongs to — for reconciliation and for naming a stale one. */
    loadAny: () => PendingRotation | null;
    save: (pending: PendingRotation) => void;
    clear: () => void;
    /** For messages that name the file. */
    path: string;
  };
  passphrase: string;
  reason?: string;
  syncUrl: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** The passphrase did not open the identity's key. Distinguished by TYPE, never by message text. */
export class RotationUnlockError extends Error {
  constructor() {
    super("incorrect passphrase");
    this.name = "RotationUnlockError";
  }
}

/** Something this run noticed on the way and dealt with; each is said, never silent. */
export type RotationNote =
  /** A write-ahead for another identity or another key: cleared. */
  | { kind: "stale-write-ahead-cleared"; motebitId: string; oldPublicKey: string }
  /** A write-ahead the relay never applied: discarded unused, this old. */
  | { kind: "write-ahead-discarded"; ageMs: number }
  /** The last run's commit was interrupted between its two local writes; finished from the write-ahead. */
  | { kind: "interrupted-commit-finished"; newPublicKeyHex: string };

export type RotationOutcome =
  | {
      kind: "rotated";
      motebitId: string;
      newPublicKeyHex: string;
      /** What the relay did: recorded this link, already held it (finished from the write-ahead), or holds nothing for this identity. */
      relay: "recorded" | "already-held" | "none";
      rotations: number;
      relayKeyBefore: string | null;
      notes: RotationNote[];
    }
  /** The outcome at the relay is unknown; the write-ahead is kept and the next run resolves it by reading. */
  | {
      kind: "held";
      motebitId: string;
      newPublicKeyHex: string;
      reason: string;
      notes: RotationNote[];
    }
  | {
      kind: "stopped";
      motebitId: string;
      state: "unreachable" | "diverged" | "refused" | "held-unopenable";
      message: string;
      /** For `diverged`: the key the relay holds. */
      relayKey?: string;
      notes: RotationNote[];
    };

export async function performRotation(deps: RotationDeps): Promise<RotationOutcome> {
  // Every key allocated on any path is erased on every path — including a
  // throw from a primitive this function did not anticipate.
  const allocated: Uint8Array[] = [];
  try {
    return await rotateWithin(deps, allocated);
  } finally {
    for (const k of allocated) secureErase(k);
  }
}

async function rotateWithin(deps: RotationDeps, allocated: Uint8Array[]): Promise<RotationOutcome> {
  const notes: RotationNote[] = [];
  const now = deps.now ?? Date.now;

  // 0. What this machine HOLDS: the key the config's encrypted private key
  //    derives to. The identity file names a key too, and the two agree
  //    except in one state — a crash between the two local writes of a
  //    previous commit — which is reconciled below from the write-ahead.
  //    Taking the departing key from the FILE while signing with the CONFIG's
  //    key would, in that state, mint a record signed by A that names B, get
  //    refused, and then clear the only copy of B.
  const config = deps.loadConfig();
  if (!config.cli_encrypted_key) {
    throw new Error("no encrypted key found in config; cannot rotate without the old key");
  }
  let oldPrivateKey: Uint8Array;
  try {
    oldPrivateKey = fromHex(await decryptPrivateKey(config.cli_encrypted_key, deps.passphrase));
  } catch {
    throw new RotationUnlockError();
  }
  allocated.push(oldPrivateKey);
  const oldPublicKey = await getPublicKeyBySuite(oldPrivateKey, "motebit-jcs-ed25519-hex-v1");
  const oldPublicKeyHex = bytesToHex(oldPublicKey);

  const existingContent = fs.readFileSync(deps.identityPath, "utf-8");
  const verified = await verify(existingContent, { expectedType: "identity" });
  if (verified.type !== "identity" || !verified.valid || !verified.identity) {
    throw new Error(
      `identity file verification failed: ${verified.errors?.[0]?.message ?? "invalid"}`,
    );
  }
  const motebitId = verified.identity.motebit_id;

  // 1. What this machine holds IN FLIGHT.
  const anyPending = deps.pending.loadAny();
  const fileKey = verified.identity.identity.public_key;
  if (fileKey !== oldPublicKeyHex) {
    // The two local writes of a commit disagree. Only a write-ahead of ours
    // that bridges them makes this a known state; anything else is not for
    // this command to guess at.
    if (
      anyPending != null &&
      anyPending.motebit_id === motebitId &&
      anyPending.new_public_key === fileKey &&
      anyPending.old_public_key === oldPublicKeyHex
    ) {
      // File is on B, config still on A: the config write did not land.
      let newPrivateKey: Uint8Array;
      try {
        newPrivateKey = fromHex(
          await decryptPrivateKey(anyPending.encrypted_new_key, deps.passphrase),
        );
      } catch {
        return stopped(
          motebitId,
          "held-unopenable",
          `the identity file is already on a new key but the write-ahead (${deps.pending.path}) holding that key will not open under this passphrase — recover through the identity's guardian`,
          notes,
        );
      }
      allocated.push(newPrivateKey);
      const encrypted = await encryptPrivateKey(bytesToHex(newPrivateKey), deps.passphrase);
      if (encrypted == null) throw new Error("could not encrypt the new key; nothing was changed");
      const next = deps.loadConfig();
      next.cli_encrypted_key = encrypted;
      next.device_public_key = fileKey;
      deps.saveConfig(next);
      deps.pending.clear();
      notes.push({ kind: "interrupted-commit-finished", newPublicKeyHex: fileKey });
      return {
        kind: "rotated",
        motebitId,
        newPublicKeyHex: fileKey,
        relay: "already-held",
        rotations: verified.identity.succession?.length ?? 1,
        relayKeyBefore: oldPublicKeyHex,
        notes,
      };
    }
    if (
      anyPending != null &&
      anyPending.motebit_id === motebitId &&
      anyPending.new_public_key === oldPublicKeyHex &&
      anyPending.old_public_key === fileKey
    ) {
      // Config is on B, file still on A: the file write did not land. The
      // config's key IS B (just decrypted), so the file is re-signed from
      // the held record and the rotation is finished.
      const rotated = await rotateIdentityFile({
        existingContent,
        newPublicKey: oldPublicKey,
        newPrivateKey: oldPrivateKey,
        successionRecord: anyPending.record,
      });
      const check = await verify(rotated, { expectedType: "identity" });
      if (!check.valid) {
        throw new Error(
          `the identity file could not be re-signed from the write-ahead: ${check.errors?.[0]?.message ?? "invalid"}`,
        );
      }
      fs.writeFileSync(deps.identityPath, rotated, "utf-8");
      deps.pending.clear();
      notes.push({ kind: "interrupted-commit-finished", newPublicKeyHex: oldPublicKeyHex });
      return {
        kind: "rotated",
        motebitId,
        newPublicKeyHex: oldPublicKeyHex,
        relay: "already-held",
        rotations: (verified.identity.succession?.length ?? 0) + 1,
        relayKeyBefore: fileKey,
        notes,
      };
    }
    throw new Error(
      `the identity file names key ${fileKey.slice(0, 16)}… but the config's key is ${oldPublicKeyHex.slice(0, 16)}…, and no write-ahead bridges them; restore the identity from its seed or motebit.md before rotating`,
    );
  }
  // A write-ahead for another identity, or from a key this machine no
  // longer holds, is evidence of a different problem — an older config
  // restored over a newer one — never an instruction. Said, then cleared,
  // so it can neither be finished by mistake nor block a passphrase change.
  if (
    anyPending != null &&
    (anyPending.motebit_id !== motebitId || anyPending.old_public_key !== oldPublicKeyHex)
  ) {
    notes.push({
      kind: "stale-write-ahead-cleared",
      motebitId: anyPending.motebit_id,
      oldPublicKey: anyPending.old_public_key,
    });
    deps.pending.clear();
  }
  const held = deps.pending.load(motebitId, oldPublicKeyHex);

  // 2. Where does the relay stand? Read, never assumed (D3) — and read as the
  //    relay's own answer to "may a rotation depart from this key", so a key
  //    held only on a device row is not misread as "unregistered".
  const relay = await readSuccessionState({
    syncUrl: deps.syncUrl,
    motebitId,
    localPublicKey: oldPublicKeyHex,
    ...(held ? { heldNewPublicKey: held.new_public_key } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  const commit = async (
    record: KeySuccessionRecord,
    newPrivateKey: Uint8Array,
    newPublicKeyHex: string,
    relayOutcome: "recorded" | "already-held" | "none",
    relayKeyBefore: string | null,
  ): Promise<RotationOutcome> => {
    // Local state moves ONLY here, and only after the relay is known (I1).
    // The rotated file is verified before a single byte is written. Order:
    // the CONFIG (the private key) first, the identity file second, the
    // write-ahead cleared last — so a crash after any one write leaves a
    // state the next run reconciles from the write-ahead (above).
    const rotated = await rotateIdentityFile({
      existingContent,
      newPublicKey: fromHex(newPublicKeyHex),
      newPrivateKey,
      successionRecord: record,
    });
    const check = await verify(rotated, { expectedType: "identity" });
    if (!check.valid) {
      throw new Error(
        `rotated identity file failed self-verification; nothing was changed: ${check.errors?.[0]?.message ?? "invalid"}`,
      );
    }
    const encrypted = await encryptPrivateKey(bytesToHex(newPrivateKey), deps.passphrase);
    if (encrypted == null) throw new Error("could not encrypt the new key; nothing was changed");
    const next = deps.loadConfig();
    next.cli_encrypted_key = encrypted;
    next.device_public_key = newPublicKeyHex;
    deps.saveConfig(next);
    fs.writeFileSync(deps.identityPath, rotated, "utf-8");
    deps.pending.clear();
    return {
      kind: "rotated",
      motebitId,
      newPublicKeyHex,
      relay: relayOutcome,
      rotations: (verified.identity!.succession?.length ?? 0) + 1,
      relayKeyBefore,
      notes,
    };
  };

  switch (relay.state) {
    case "unreachable": {
      // S6. Rotating now would produce (B, A) the moment the relay is back.
      // The old key stays; the write-ahead, if any, stays for the next run.
      return stopped(
        motebitId,
        "unreachable",
        `the relay could not be read (${relay.reason}); nothing was changed — retry when it is reachable`,
        notes,
      );
    }
    case "diverged": {
      // S5. Someone else rotated first, or another device did. Not ours to
      // adjudicate: guardian recovery is the remedy.
      return {
        ...stopped(
          motebitId,
          "diverged",
          `the relay holds a key this machine does not (${relay.relayKey.slice(0, 16)}…); a rotation cannot depart from a key the relay has already left — recover through the identity's guardian`,
          notes,
        ),
        relayKey: relay.relayKey,
      };
    }
    case "applied": {
      // S1. The relay already holds B from a write-ahead of ours. Commit
      // from it. No token is minted; nothing is sent.
      if (held == null) {
        return {
          ...stopped(motebitId, "diverged", "the relay holds a key this machine does not", notes),
          relayKey: relay.relayKey,
        };
      }
      let newPrivateKey: Uint8Array;
      try {
        newPrivateKey = fromHex(await decryptPrivateKey(held.encrypted_new_key, deps.passphrase));
      } catch {
        return stopped(
          motebitId,
          "held-unopenable",
          `the relay already holds the new key from a rotation this machine started, but its write-ahead (${deps.pending.path}) will not open under this passphrase — this machine cannot finish the rotation; recover through the identity's guardian`,
          notes,
        );
      }
      allocated.push(newPrivateKey);
      return commit(
        held.record,
        newPrivateKey,
        held.new_public_key,
        "already-held",
        oldPublicKeyHex,
      );
    }
    case "unregistered":
    case "current": {
      // S4 or S0. Either way a FRESH record: a held one (if any) was never
      // applied and cannot be re-timestamped, so it is discarded unused —
      // and its age is said.
      if (held != null) {
        notes.push({ kind: "write-ahead-discarded", ageMs: Math.max(0, now() - held.written_at) });
        deps.pending.clear();
      }
      const minted = await rotateIdentityKeys({
        oldPrivateKey,
        oldPublicKey,
        ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
      });
      allocated.push(minted.newPrivateKey);
      const newPublicKeyHex = minted.newPublicKeyHex;

      if (relay.state === "unregistered") {
        // S4. The relay has no key to update and no chain to extend (D5).
        // Said, never a flag. A later `motebit up` registers B by the normal path.
        return commit(minted.successionRecord, minted.newPrivateKey, newPublicKeyHex, "none", null);
      }

      // S0. Write-ahead FIRST (I2), then submit signed by A, then commit.
      const encryptedNewKey = await encryptPrivateKey(
        bytesToHex(minted.newPrivateKey),
        deps.passphrase,
      );
      if (encryptedNewKey == null)
        throw new Error("could not encrypt the new key; nothing was changed");
      deps.pending.save({
        motebit_id: motebitId,
        old_public_key: oldPublicKeyHex,
        new_public_key: newPublicKeyHex,
        record: minted.successionRecord,
        encrypted_new_key: encryptedNewKey,
        written_at: now(),
      });

      const submitted = await submitSuccessionToRelay({
        syncUrl: deps.syncUrl,
        motebitId,
        // The device this identity is known by at the relay; else its own
        // did:key, which the relay resolves through its registry fallback (D8).
        deviceId:
          config.device_id && config.device_id !== ""
            ? config.device_id
            : hexPublicKeyToDidKey(oldPublicKeyHex),
        signingKey: oldPrivateKey,
        record: minted.successionRecord,
        ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      });

      if (submitted.ok) {
        return commit(
          minted.successionRecord,
          minted.newPrivateKey,
          newPublicKeyHex,
          submitted.applied ? "recorded" : "already-held",
          relay.relayKey,
        );
      }
      if (submitted.kind === "refused") {
        // The relay said no. R is still A. Nothing local changed; the
        // write-ahead is for a rotation that will never land.
        deps.pending.clear();
        return stopped(
          motebitId,
          "refused",
          `the relay refused the rotation — ${submitted.reason}; your current key still works and nothing was changed`,
          notes,
        );
      }
      // Unknown. The relay may hold B. The write-ahead stays; the next run
      // reads the relay and either commits from it or mints afresh.
      return { kind: "held", motebitId, newPublicKeyHex, reason: submitted.reason, notes };
    }
    default: {
      const never: never = relay;
      throw new Error(`unmodelled relay state: ${JSON.stringify(never)}`);
    }
  }
}

function stopped(
  motebitId: string,
  state: Extract<RotationOutcome, { kind: "stopped" }>["state"],
  message: string,
  notes: RotationNote[],
): Extract<RotationOutcome, { kind: "stopped" }> {
  return { kind: "stopped", motebitId, state, message, notes };
}
