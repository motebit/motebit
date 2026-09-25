/**
 * Key rotation for the CLI — a thin adapter over `@motebit/surface-kit`'s
 * `performKeyRotation`, the ONE state machine of
 * `docs/proposals/key-rotation-client-v1.md` §3 that web, mobile and desktop
 * also run (#709). What is CLI-specific is only plumbing, inverted into
 * ports: the private key is a passphrase-encrypted config entry, the
 * published key is the one `motebit.md` names, the write-ahead is
 * `~/.motebit/pending-rotation.json` holding the new key encrypted under the
 * same passphrase, and commit re-signs the identity file and saves the
 * config. The outcome vocabulary below is the CLI's own and is mapped from
 * the kit's; the terminal prints it.
 *
 * Everything that touches the world is injected, so the activation test
 * drives THIS function against an in-process relay with the relay half
 * applied (`docs/doctrine/composition-preserves-enforcement.md`).
 */
import * as fs from "node:fs";
import { verify, rotate as rotateIdentityFile } from "@motebit/identity-file";
import { performKeyRotation, type HeldRotation, type KeyRotationPorts } from "@motebit/surface-kit";
import { hexToBytes } from "@motebit/encryption";
import type { FullConfig } from "./config.js";
import { currentModeOr, writeFileAtomic } from "./durable-file.js";
import { decryptPrivateKey, encryptPrivateKey } from "./identity.js";
import type { PendingRotation, PendingRotationRead } from "./pending-rotation.js";

export interface RotationDeps {
  /** The motebit.md to rotate. Read, verified, rewritten only on commit. */
  identityPath: string;
  loadConfig: () => FullConfig;
  saveConfig: (config: FullConfig) => void;
  pending: {
    load: (motebitId: string, currentPublicKey: string) => PendingRotationRead;
    /** Whatever write-ahead exists, whoever it belongs to. `null` is absence only. */
    loadAny: () => PendingRotationRead;
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
  | { kind: "stale-write-ahead-cleared"; motebitId: string; oldPublicKey: string }
  | { kind: "write-ahead-discarded"; ageMs: number }
  | { kind: "interrupted-commit-finished"; newPublicKeyHex: string };

export type RotationOutcome =
  | {
      kind: "rotated";
      motebitId: string;
      newPublicKeyHex: string;
      relay: "recorded" | "already-held" | "none";
      rotations: number;
      relayKeyBefore: string | null;
      notes: RotationNote[];
    }
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
      relayKey?: string;
      notes: RotationNote[];
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
  const config = deps.loadConfig();
  if (!config.cli_encrypted_key) {
    throw new Error("no encrypted key found in config; cannot rotate without the old key");
  }

  // The CLI's write-ahead holds the new key ENCRYPTED under the passphrase;
  // the kit's holds it plain in the surface's protected medium. The port
  // translates, and remembers whether a held key failed to open so the
  // kit's "unreadable" can be named honestly below.
  let heldWouldNotOpen = false;
  const toHeld = async (p: PendingRotation): Promise<HeldRotation | "unreadable"> => {
    try {
      const hex = await decryptPrivateKey(p.encrypted_new_key, deps.passphrase);
      return {
        motebit_id: p.motebit_id,
        old_public_key: p.old_public_key,
        new_public_key: p.new_public_key,
        record: p.record,
        new_private_key_hex: hex,
        written_at: p.written_at,
      };
    } catch {
      heldWouldNotOpen = true;
      return "unreadable";
    }
  };

  const ports: KeyRotationPorts = {
    motebitId,
    deviceId: config.device_id && config.device_id !== "" ? config.device_id : "",
    syncUrl: deps.syncUrl,
    loadPrivateKeyHex: async () => {
      try {
        return await decryptPrivateKey(config.cli_encrypted_key!, deps.passphrase);
      } catch {
        throw new RotationUnlockError();
      }
    },
    // The second witness: the key motebit.md names.
    publishedPublicKeyHex: () => Promise.resolve(identity.identity.public_key),
    writeAhead: {
      load: async () => {
        // The port contract distinguishes "nothing held" from "something held
        // that cannot be read"; the kit stops on the latter and never clears it.
        const any = deps.pending.loadAny();
        if (any === "unreadable") return "unreadable";
        return any == null ? null : toHeld(any);
      },
      save: async (h) => {
        const encrypted = await encryptPrivateKey(h.new_private_key_hex, deps.passphrase);
        if (encrypted == null)
          throw new Error("could not encrypt the new key; nothing was changed");
        deps.pending.save({
          motebit_id: h.motebit_id,
          old_public_key: h.old_public_key,
          new_public_key: h.new_public_key,
          record: h.record,
          encrypted_new_key: encrypted,
          written_at: h.written_at,
        });
      },
      clear: () => Promise.resolve(deps.pending.clear()),
    },
    commit: async ({ privateKeyHex, publicKeyHex, record }) => {
      // Config (the private key) first, the identity file second; idempotent:
      // a file already on the new key is not re-signed again.
      const encrypted = await encryptPrivateKey(privateKeyHex, deps.passphrase);
      if (encrypted == null) throw new Error("could not encrypt the new key; nothing was changed");
      const next = deps.loadConfig();
      next.cli_encrypted_key = encrypted;
      next.device_public_key = publicKeyHex;
      deps.saveConfig(next);
      const current = fs.readFileSync(deps.identityPath, "utf-8");
      const onFile = await verify(current, { expectedType: "identity" });
      const fileKey =
        onFile.type === "identity" && onFile.identity ? onFile.identity.identity.public_key : null;
      if (fileKey !== publicKeyHex) {
        const rotated = await rotateIdentityFile({
          existingContent: current,
          newPublicKey: hexToBytes(publicKeyHex),
          newPrivateKey: hexToBytes(privateKeyHex),
          successionRecord: record,
        });
        const check = await verify(rotated, { expectedType: "identity" });
        if (!check.valid) {
          throw new Error(
            `rotated identity file failed self-verification; nothing was changed: ${check.errors?.[0]?.message ?? "invalid"}`,
          );
        }
        // Atomic: a torn write here would leave the only signed statement of
        // the identity's succession unparseable, after the key had moved.
        writeFileAtomic(deps.identityPath, rotated, currentModeOr(deps.identityPath, 0o644));
      }
    },
    ...(deps.reason !== undefined ? { reason: deps.reason } : {}),
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    ...(deps.now ? { now: deps.now } : {}),
  };

  const outcome = await performKeyRotation(ports);
  const notes = outcome.notes.filter((n): n is RotationNote => n.kind !== "no-relay-configured");

  switch (outcome.kind) {
    case "rotated": {
      const after = await verify(fs.readFileSync(deps.identityPath, "utf-8"), {
        expectedType: "identity",
      });
      const rotations =
        after.type === "identity" && after.identity ? (after.identity.succession?.length ?? 0) : 0;
      return {
        kind: "rotated",
        motebitId,
        newPublicKeyHex: outcome.newPublicKeyHex,
        relay: outcome.relay,
        rotations,
        relayKeyBefore: outcome.relayKeyBefore,
        notes,
      };
    }
    case "held":
      return {
        kind: "held",
        motebitId,
        newPublicKeyHex: outcome.newPublicKeyHex,
        reason: outcome.reason,
        notes,
      };
    case "stopped": {
      if (outcome.state === "inconsistent") {
        // The CLI's contract: this is not a rotation outcome but a broken
        // local state the operator must repair first.
        throw new Error(outcome.message);
      }
      if (outcome.state === "held-unreadable" || outcome.state === "held-corrupt") {
        return {
          kind: "stopped",
          motebitId,
          state: "held-unopenable",
          message: heldWouldNotOpen
            ? `a rotation this machine started is held in ${deps.pending.path}, but its new key will not open under this passphrase — this machine cannot finish or safely discard it; recover through the identity's guardian, or restore the passphrase it was written under`
            : `the write-ahead in ${deps.pending.path} could not be used (${outcome.message}); recover through the identity's guardian`,
          notes,
        };
      }
      if (outcome.state === "no-key") throw new Error(outcome.message);
      return {
        kind: "stopped",
        motebitId,
        state: outcome.state,
        message: outcome.message,
        ...(outcome.relayKey !== undefined ? { relayKey: outcome.relayKey } : {}),
        notes,
      };
    }
  }
}
