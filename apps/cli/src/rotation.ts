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
import { bytesToHex, hexPublicKeyToDidKey, secureErase } from "@motebit/encryption";
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

export type RotationOutcome =
  | {
      kind: "rotated";
      motebitId: string;
      newPublicKeyHex: string;
      /** What the relay did: recorded this link, already held it (finished from the write-ahead), or holds nothing for this identity. */
      relay: "recorded" | "already-held" | "none";
      rotations: number;
      relayKeyBefore: string | null;
    }
  /** The outcome at the relay is unknown; the write-ahead is kept and the next run resolves it by reading. */
  | { kind: "held"; motebitId: string; newPublicKeyHex: string; reason: string }
  | {
      kind: "stopped";
      motebitId: string;
      state: "unreachable" | "diverged" | "refused" | "held-unopenable";
      message: string;
      /** For `diverged`: the key the relay holds. */
      relayKey?: string;
    };

export async function performRotation(deps: RotationDeps): Promise<RotationOutcome> {
  const existingContent = fs.readFileSync(deps.identityPath, "utf-8");
  const verified = await verify(existingContent, { expectedType: "identity" });
  if (verified.type !== "identity" || !verified.valid || !verified.identity) {
    throw new Error(
      `identity file verification failed: ${verified.errors?.[0]?.message ?? "invalid"}`,
    );
  }
  const identity = verified.identity;
  const motebitId = identity.motebit_id;
  const oldPublicKeyHex = identity.identity.public_key;

  const config = deps.loadConfig();
  if (!config.cli_encrypted_key) {
    throw new Error("no encrypted key found in config; cannot rotate without the old key");
  }
  const oldPrivateKey = fromHex(await decryptPrivateKey(config.cli_encrypted_key, deps.passphrase));
  const oldPublicKey = fromHex(oldPublicKeyHex);
  const erase = (...keys: Uint8Array[]) => keys.forEach((k) => secureErase(k));

  // 1. What does this machine hold in flight, from THIS key?
  const held = deps.pending.load(motebitId, oldPublicKeyHex);

  // 2. Where does the relay stand? Read, never assumed (D3).
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
    // The rotated file is verified before a single byte is written.
    const rotated = await rotateIdentityFile({
      existingContent,
      newPublicKey: fromHex(newPublicKeyHex),
      newPrivateKey,
      successionRecord: record,
    });
    const check = await verify(rotated, { expectedType: "identity" });
    if (!check.valid) {
      erase(oldPrivateKey, newPrivateKey);
      throw new Error(
        `rotated identity file failed self-verification; nothing was changed: ${check.errors?.[0]?.message ?? "invalid"}`,
      );
    }
    const encrypted = await encryptPrivateKey(bytesToHex(newPrivateKey), deps.passphrase);
    if (encrypted == null) {
      erase(oldPrivateKey, newPrivateKey);
      throw new Error("could not encrypt the new key; nothing was changed");
    }
    fs.writeFileSync(deps.identityPath, rotated, "utf-8");
    const next = deps.loadConfig();
    next.cli_encrypted_key = encrypted;
    next.device_public_key = newPublicKeyHex;
    deps.saveConfig(next);
    // The write-ahead goes LAST, once local state agrees with the relay;
    // the old key is erased after that.
    deps.pending.clear();
    erase(oldPrivateKey, newPrivateKey);
    return {
      kind: "rotated",
      motebitId,
      newPublicKeyHex,
      relay: relayOutcome,
      rotations: (identity.succession?.length ?? 0) + 1,
      relayKeyBefore,
    };
  };

  switch (relay.state) {
    case "unreachable": {
      // S6. Rotating now would produce (B, A) the moment the relay is back.
      // The old key stays; the write-ahead, if any, stays for the next run.
      erase(oldPrivateKey);
      return {
        kind: "stopped",
        motebitId,
        state: "unreachable",
        message: `the relay could not be read (${relay.reason}); nothing was changed — retry when it is reachable`,
      };
    }
    case "diverged": {
      // S5. Someone else rotated first, or another device did. Not ours to
      // adjudicate: guardian recovery is the remedy.
      erase(oldPrivateKey);
      return {
        kind: "stopped",
        motebitId,
        state: "diverged",
        relayKey: relay.relayKey,
        message: `the relay holds a key this machine does not (${relay.relayKey.slice(0, 16)}…); a rotation cannot depart from a key the relay has already left — recover through the identity's guardian`,
      };
    }
    case "applied": {
      // S1. The relay already holds B from a write-ahead of ours. Commit
      // from it. No token is minted; nothing is sent.
      if (held == null) {
        // Unreachable by construction (`applied` requires heldNewPublicKey),
        // but the type does not know that.
        erase(oldPrivateKey);
        return {
          kind: "stopped",
          motebitId,
          state: "diverged",
          relayKey: relay.relayKey,
          message: "the relay holds a key this machine does not",
        };
      }
      let newPrivateKey: Uint8Array;
      try {
        newPrivateKey = fromHex(await decryptPrivateKey(held.encrypted_new_key, deps.passphrase));
      } catch {
        erase(oldPrivateKey);
        return {
          kind: "stopped",
          motebitId,
          state: "held-unopenable",
          message: `the relay already holds the new key from a rotation this machine started, but its write-ahead (${deps.pending.path}) will not open under this passphrase — this machine cannot finish the rotation; recover through the identity's guardian`,
        };
      }
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
      // applied and cannot be re-timestamped, so it is discarded unused.
      if (held != null) deps.pending.clear();
      const minted = await rotateIdentityKeys({
        oldPrivateKey,
        oldPublicKey,
        ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
      });
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
      if (encryptedNewKey == null) {
        erase(oldPrivateKey, minted.newPrivateKey);
        throw new Error("could not encrypt the new key; nothing was changed");
      }
      deps.pending.save({
        motebit_id: motebitId,
        old_public_key: oldPublicKeyHex,
        new_public_key: newPublicKeyHex,
        record: minted.successionRecord,
        encrypted_new_key: encryptedNewKey,
        written_at: (deps.now ?? Date.now)(),
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
        erase(oldPrivateKey, minted.newPrivateKey);
        return {
          kind: "stopped",
          motebitId,
          state: "refused",
          message: `the relay refused the rotation — ${submitted.reason}; your current key still works and nothing was changed`,
        };
      }
      // Unknown. The relay may hold B. The write-ahead stays; the next run
      // reads the relay and either commits from it or mints afresh.
      erase(oldPrivateKey, minted.newPrivateKey);
      return {
        kind: "held",
        motebitId,
        newPublicKeyHex,
        reason: submitted.reason,
      };
    }
    default: {
      const never: never = relay;
      throw new Error(`unmodelled relay state: ${JSON.stringify(never)}`);
    }
  }
}
