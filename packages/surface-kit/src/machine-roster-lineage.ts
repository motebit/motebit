/**
 * The one persistence step a surface runs after it adopts an identity —
 * Device B once a pairing is accepted (`OpenedPairingKeyTransfer.succession`),
 * and a motebit.md restore (the file's chain): the VERIFIED lineage to the key
 * this device now holds joins its roster replica. The replica is what the
 * device seals into its own key transfer when it later approves another
 * device (Device A), so an identity rotated offline — whose chain is on no
 * relay — stays pairable past the first hop.
 *
 * Fail-closed on admission: the records are re-verified here
 * (`verifiedIdentityLineage`), whatever the caller passes, so only a
 * continuous, signature-verified chain from the genesis key the id commits to
 * to the held key is ever written. Idempotent: the replica is a union keyed by
 * each record's canonical bytes (`mergeReplicas`, which every surface's
 * `saveReplica` runs). Best-effort: the identity is already adopted, so a
 * failed write never fails the caller.
 */
import { verifiedIdentityLineage } from "@motebit/encryption";
import { identityFileRecords } from "./machine-roster-identity-file.js";
import { emptyReplica, type MachineRosterReplica } from "./machine-roster-replica.js";

/**
 * Persist the verified lineage among `records` to `publicKeyHex` for
 * `motebitId` through `save` (a surface's merge-on-write `saveReplica`).
 * Returns the number of records written — 0 when none verify, the id commits
 * to no lineage, or the write failed. Never throws.
 */
export async function persistVerifiedLineage(
  save: (replica: MachineRosterReplica) => Promise<void>,
  input: { motebitId: string; publicKeyHex: string; records: readonly unknown[] },
): Promise<number> {
  try {
    const lineage = await verifiedIdentityLineage(input);
    if (lineage.length === 0) return 0;
    await save({ ...emptyReplica(input.motebitId), succession: lineage });
    return lineage.length;
  } catch {
    return 0;
  }
}

/**
 * Restore from a motebit.md: persist the file's chain — only when the file
 * verifies (signature AND chain), names `motebitId`, and its current key is
 * `publicKeyHex` (`identityFileRecords`, #800) — and then only its verified
 * lineage ({@link persistVerifiedLineage}). A surface whose bootstrap
 * regenerates the identity file (web keeps none at all) otherwise loses the
 * chain, and with it the ability to be Device A for an offline-rotated
 * identity. Returns the number of records written. Never throws.
 */
export async function persistIdentityFileLineage(
  save: (replica: MachineRosterReplica) => Promise<void>,
  input: { motebitId: string; publicKeyHex: string; content: string | null | undefined },
): Promise<number> {
  try {
    const records = await identityFileRecords(
      input.motebitId,
      input.content ?? null,
      input.publicKeyHex,
    );
    return await persistVerifiedLineage(save, {
      motebitId: input.motebitId,
      publicKeyHex: input.publicKeyHex,
      records,
    });
  } catch {
    return 0;
  }
}
