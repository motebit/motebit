/**
 * Whether the key a C-2 surface holds is the IDENTITY key —
 * `docs/proposals/machine-roster-surfaces-v1.md` §1A (F2, the replacement
 * of S1) and §1B (B1, the custody flag; R1; R5).
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
 *          key — disclosed "identity key per the relay";
 *       4. LEGACY id only: this device's custody flag names the held key
 *          (B1) — disclosed "identity key per this device's custody record".
 *   - **device-key** — only on POSITIVE evidence: the relay names another
 *     key as current, no verified record touches the held key, and the held
 *     key does not bind to the id. Checked before routes 3 and 4, so the
 *     custody flag never overrides it.
 *   - **unconfirmed** — everything else. Counts are suppressed
 *     (`held_key_unconfirmed`); never worded "linked without the identity key".
 *
 * The CLI does not run this (R5): it is a host with its own evidence.
 *
 * The custody flag is a LOCAL record, set only by the two code paths that
 * establish custody — the surface minting the identity (keypair and id
 * generated together at first launch), and a Link Device WITH key transfer
 * completing — and MOVED (never set) by a rotation commit. It counts only
 * when it names the key the surface holds now.
 */
import { bytesToHex, getPublicKeyBySuite, type RosterKeyChainOk } from "@motebit/encryption";
import type { KeySuccessionRecord } from "@motebit/sdk";
import type { RosterAcquisition } from "./machine-roster.js";
import { emptyReplica, type MachineRosterReplica } from "./machine-roster-replica.js";

const KEY_SUITE = "motebit-jcs-ed25519-hex-v1" as const;
const HEX_32 = /^[0-9a-f]{64}$/;

/** Why the held key counts as the identity key — the rung is disclosed. */
export type IdentityBasis =
  /** Route 1: the resolved chain roots at the sovereign id's genesis key. */
  | "rooted"
  /** Route 2: the refusal's own evidence names the held key. */
  | "on-chain"
  /** Route 3 (legacy ids): the relay names the held key as current. */
  | "relay"
  /** Route 4 (legacy ids): this device's custody flag names the held key (B1). */
  | "custody-record";

export type HeldKeyClass =
  | { kind: "identity"; basis: IdentityBasis }
  /** Positive evidence the held key is a device-only key. */
  | { kind: "device-key" }
  | {
      kind: "unconfirmed";
      /** `no-key`: nothing held; `malformed`: a malformed roster call; `no-evidence`: nothing proves it either way. */
      why: "no-key" | "malformed" | "no-evidence";
    };

/** B1 — the local custody record. Keyed by `(motebit_id, public_key)`. */
export interface CustodyFlag {
  motebit_id: string;
  /** The key custody was established for — derived from the private key, never copied. */
  public_key: string;
  set_at: number;
  /** The code path that established custody (a rotation only moves it). */
  reason: "minted" | "key-transfer";
}

/** A stored custody flag, or `null` when the value is not one. */
export function parseCustodyFlag(raw: unknown): CustodyFlag | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const f = raw as Record<string, unknown>;
  if (typeof f.motebit_id !== "string" || f.motebit_id === "") return null;
  if (typeof f.public_key !== "string" || !HEX_32.test(f.public_key)) return null;
  if (typeof f.set_at !== "number") return null;
  if (f.reason !== "minted" && f.reason !== "key-transfer") return null;
  return {
    motebit_id: f.motebit_id,
    public_key: f.public_key,
    set_at: f.set_at,
    reason: f.reason,
  };
}

/**
 * The custody flag for a key just placed in the slot by one of the two
 * custody paths. The public key is DERIVED from the private key here, so a
 * flag can never name a key other than the one the slot holds.
 */
export async function custodyFlagFor(opts: {
  motebitId: string;
  privateKey: Uint8Array;
  reason: CustodyFlag["reason"];
  now: number;
}): Promise<CustodyFlag> {
  const public_key = bytesToHex(await getPublicKeyBySuite(opts.privateKey, KEY_SUITE));
  return { motebit_id: opts.motebitId, public_key, set_at: opts.now, reason: opts.reason };
}

/**
 * B1 — a rotation MOVES the flag: when it names the rotation's old key (for
 * this motebit), it is rewritten to the new key. Anything else — no flag,
 * another motebit's, one naming neither key, one already moved — returns
 * `null` (nothing to write), so a commit re-run is idempotent and a device
 * that never had custody never gains it by rotating.
 */
export function custodyAfterRotation(
  flag: CustodyFlag | null,
  opts: { motebitId: string; record: KeySuccessionRecord; newPublicKeyHex: string; now: number },
): CustodyFlag | null {
  if (flag == null || flag.motebit_id !== opts.motebitId) return null;
  const newKey = opts.newPublicKeyHex.toLowerCase();
  if (opts.record.new_public_key !== newKey) return null;
  if (flag.public_key !== opts.record.old_public_key) return null;
  return { ...flag, public_key: newKey, set_at: opts.now };
}

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
  motebitId: string;
  held: string;
  chain: RosterKeyChainOk;
  /** The relay's `current_public_key` (lower-case), or `null` when not read. */
  hint: string | null;
  /** Every verified record this surface holds (the replica's). */
  succession: readonly KeySuccessionRecord[];
  custodyFlag?: CustodyFlag | null;
}): HeldKeyClass {
  const { held, chain, hint } = input;
  // Route 1.
  if (chain.ancestry.kind === "rooted") return { kind: "identity", basis: "rooted" };
  // Positive device-key evidence — before routes 3 and 4, so neither the
  // relay's word nor the custody flag can override it.
  const touches = [
    ...chain.links,
    ...chain.branches.map((b) => b.record),
    ...input.succession,
  ].some((r) => r.old_public_key === held || r.new_public_key === held);
  if (hint != null && hint !== held && !touches) return { kind: "device-key" };
  if (!chain.sovereign_id) {
    // Route 3.
    if (hint === held) return { kind: "identity", basis: "relay" };
    // Route 4 (B1).
    const f = input.custodyFlag;
    if (f != null && f.motebit_id === input.motebitId && f.public_key === held) {
      return { kind: "identity", basis: "custody-record" };
    }
  }
  return { kind: "unconfirmed", why: "no-evidence" };
}

/** §1A — sort the held key of one acquisition into identity / device-key / unconfirmed. */
export function classifyHeldKey(
  acq: RosterAcquisition,
  opts: { custodyFlag?: CustodyFlag | null } = {},
): HeldKeyClass {
  if (acq.kind === "no-key") return { kind: "unconfirmed", why: "no-key" };
  if (acq.kind === "refused") {
    // Route 2: each of these needs a verified record naming the held key.
    return acq.reason === "malformed_input"
      ? { kind: "unconfirmed", why: "malformed" }
      : { kind: "identity", basis: "on-chain" };
  }
  return classifyResolved({
    motebitId: acq.motebitId,
    held: acq.signer.publicKeyHex,
    chain: acq.chain,
    hint: acq.succession.hint,
    succession: acq.replica.succession,
    custodyFlag: opts.custodyFlag ?? null,
  });
}

/**
 * What a surface says about the held key's class — `null` when there is
 * nothing to add (a rooted chain, a refusal that renders itself, no key).
 */
export function heldKeyText(c: HeldKeyClass): string | null {
  switch (c.kind) {
    case "identity":
      return c.basis === "relay"
        ? "identity key per the relay"
        : c.basis === "custody-record"
          ? "identity key per this device's custody record"
          : null;
    case "device-key":
      return "this device was linked without the identity key; the roster needs a device that holds it";
    case "unconfirmed":
      return c.why === "no-evidence"
        ? "this device cannot confirm it holds the identity key, so no count is shown and nothing can be retired or enrolled from here — if it was set up before this check existed, re-pair it with a key transfer from a device that holds the identity key"
        : c.why === "malformed"
          ? "the roster call was malformed on this device"
          : null;
  }
}
