/**
 * Whether the key a C-2 surface holds is the IDENTITY key —
 * `docs/proposals/machine-roster-surfaces-v1.md` §1A (F2, the replacement
 * of S1) and §1B (R1, R5; B1 REVERSED by #797).
 *
 * A phone, a desktop or a browser keeps one key slot. It holds the identity
 * key on a first device or after a Link Device with key transfer, and a
 * device-only key when the transfer was skipped. A device-only key anchors
 * a one-key chain of its own, so the roster it would read is true but
 * useless — and it must never sign roster entries (R1). Whether the held
 * key is the identity key is decided AFTER resolution, by this one pure
 * function every C-2 surface runs, never in the `signer()` port:
 *
 *   - **identity** — any one of:
 *       1. the resolved chain is `rooted` (it ends at a key that binds to
 *          the sovereign id: works offline, unforgeable for sovereign ids);
 *       2. resolution refused `held_key_superseded`, `duplicate_key` or
 *          `fork_at_held` — each needs a verified record naming the held
 *          key, so the held key is on the chain (the refusal renders as is);
 *       3. LEGACY id only: the relay's `current_public_key` names the held
 *          key — disclosed "identity key per the relay".
 *   - **device-key** — only on POSITIVE evidence: the relay names another
 *     key as current, no verified record on the resolved chain touches the
 *     held key, and the held key does not bind to the id.
 *   - **unconfirmed** — everything else. Counts are suppressed
 *     (`held_key_unconfirmed`), and every act is refused (R1); never worded
 *     "linked without the identity key".
 *
 * There is no local "custody" rung (#797, founder decision): a key-transfer
 * approver hands over whatever its slot holds — possibly a device-only key —
 * and nothing in the transfer proves the key is the identity's, so a local
 * record of "custody" would let a device key count and sign. A legacy
 * identity whose relay holds no proven key therefore shows lines but no
 * count on these surfaces; the CLI is unchanged (R5).
 */
import type { RosterKeyChainOk } from "@motebit/encryption";
import type { KeySuccessionRecord } from "@motebit/sdk";
import type { RosterAcquisition } from "./machine-roster.js";
import { emptyReplica, type MachineRosterReplica } from "./machine-roster-replica.js";

/** Why the held key counts as the identity key — the rung is disclosed. */
export type IdentityBasis =
  /** Route 1: the resolved chain roots at the sovereign id's genesis key. */
  | "rooted"
  /** Route 2: the refusal's own evidence names the held key. */
  | "on-chain"
  /** Route 3 (legacy ids): the relay names the held key as current. */
  | "relay";

export type HeldKeyClass =
  | { kind: "identity"; basis: IdentityBasis }
  /** Positive evidence the held key is a device-only key. */
  | { kind: "device-key" }
  | {
      kind: "unconfirmed";
      /**
       * `no-key`: nothing held; `malformed`: a malformed roster call;
       * `legacy-unproven`: a legacy id whose relay names no key for it;
       * `unrooted`: a sovereign id whose chain this device cannot root.
       */
      why: "no-key" | "malformed" | "legacy-unproven" | "unrooted";
    };

/**
 * F7 — the rotation link, as a replica fragment for the surface's merge-save
 * on `commit`: no capture, no mint. A surface with no identity file keeps
 * its own link this way when the relay loses its database.
 */
export function rotationLinkReplica(
  motebitId: string,
  record: KeySuccessionRecord,
): MachineRosterReplica {
  return { ...emptyReplica(motebitId), succession: [record] };
}

/** The classification over a resolved chain — shared by `acquire` (gated) and `classifyHeldKey`. */
export function classifyResolved(input: {
  held: string;
  chain: RosterKeyChainOk;
  /** The relay's `current_public_key` (lower-case), or `null` when not read. */
  hint: string | null;
}): HeldKeyClass {
  const { held, chain, hint } = input;
  // Route 1.
  if (chain.ancestry.kind === "rooted") return { kind: "identity", basis: "rooted" };
  // Positive device-key evidence. The resolver sees every record source
  // (replica, identity files, the relay) at once: a verified record naming
  // the held key becomes a link, a branch, or a refusal (fork_at_held,
  // held_key_superseded). The one exception, an unverifiable recovery
  // record into the held key, is minted by anyone and is evidence of
  // nothing; either answer then suppresses counts and refuses every act.
  const touches = [...chain.links, ...chain.branches.map((b) => b.record)].some(
    (r) => r.old_public_key === held || r.new_public_key === held,
  );
  if (hint != null && hint !== held && !touches) return { kind: "device-key" };
  // Route 3 — legacy ids only.
  if (!chain.sovereign_id && hint === held) return { kind: "identity", basis: "relay" };
  return { kind: "unconfirmed", why: chain.sovereign_id ? "unrooted" : "legacy-unproven" };
}

/** §1A — sort the held key of one acquisition into identity / device-key / unconfirmed. */
export function classifyHeldKey(acq: RosterAcquisition): HeldKeyClass {
  if (acq.kind === "no-key") return { kind: "unconfirmed", why: "no-key" };
  if (acq.kind === "refused") {
    // Route 2: each of these needs a verified record naming the held key.
    return acq.reason === "malformed_input"
      ? { kind: "unconfirmed", why: "malformed" }
      : { kind: "identity", basis: "on-chain" };
  }
  return classifyResolved({
    held: acq.signer.publicKeyHex,
    chain: acq.chain,
    hint: acq.succession.hint,
  });
}

/**
 * What a surface says about the held key's class — `null` when there is
 * nothing to add (a rooted chain, a refusal that renders itself, no key).
 */
export function heldKeyText(c: HeldKeyClass): string | null {
  switch (c.kind) {
    case "identity":
      return c.basis === "relay" ? "identity key per the relay" : null;
    case "device-key":
      return "this device was linked without the identity key; the roster needs a device that holds it";
    case "unconfirmed":
      switch (c.why) {
        case "legacy-unproven":
          return "no proven key for this legacy identity — counts need the CLI or a sovereign identity; nothing can be retired or enrolled from here";
        case "unrooted":
          return "this device cannot trace its key back to this identity's genesis key (the key chain it can see is incomplete), so no count is shown and nothing can be retired or enrolled from here";
        case "malformed":
          return "the roster call was malformed on this device";
        case "no-key":
          return null;
      }
  }
}
