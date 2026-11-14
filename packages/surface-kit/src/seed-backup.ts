/**
 * Seed-backup acknowledgment, bound to the key (and identity) it covers.
 *
 * A recovery seed IS one Ed25519 private key, and a key rotation mints a
 * new random key (`rotateIdentityKeys`). So an acknowledgment that the
 * owner wrote the seed down covers exactly one public key — the one that
 * seed derives — and nothing after it. An acknowledgment stored as a bare
 * timestamp outlived the key it covered: after a committed rotation the
 * surface kept saying "backed up" while the paper seed recovered only the
 * RETIRED key.
 *
 * The rule is structural, not a clear-at-commit step: the posture is a
 * function of (the key and identity the acknowledgment names, the
 * identity's current key and id). A committed rotation changes the current
 * key, so every surface that reads its posture through this function sees
 * "not backed up" from the moment the new key is committed — including a
 * commit finished on a later resume, and on any code path that never
 * thought about backups. An abandoned or refused rotation leaves the
 * current key where it was, so the posture is unchanged. Nothing is
 * written, so nothing is destroyed: the old acknowledgment stays as the
 * record of which (now retired) key the old paper seed recovers — still the
 * only way to sweep the retired address.
 *
 * BOUND-ONLY, by design. An acknowledgment recorded before the binding
 * existed (a timestamp with no key) is never honoured: it reads
 * `unconfirmed` and asks for one re-confirmation. Nothing on disk can prove
 * which key an unbound acknowledgment covered without trusting a wall clock
 * — every proof attempted (a sovereign id, a zero-succession identity file,
 * signed dates) was defeated by a reachable state, the last by a clock
 * stepping backward. A false alarm costs one prompt; a false "backed up"
 * can cost funds.
 *
 * Local configuration only. Never wire.
 */

/** What a surface has recorded about a seed backup. */
export interface SeedBackupAcknowledgment {
  /** When the owner confirmed writing the seed down (absent ⇒ never). */
  at?: number;
  /**
   * The public key (hex) of the seed the owner confirmed. Absent on an
   * acknowledgment recorded before the binding existed (legacy): never
   * honoured.
   */
  publicKeyHex?: string;
  /**
   * The motebit_id the owner confirmed the seed for. Absent on a bound
   * acknowledgment written before this field existed: the key comparison
   * alone decides, as before.
   */
  motebitId?: string;
}

export type SeedBackupPosture =
  /** The acknowledgment covers the identity's current key. */
  | { status: "backed_up"; at: number }
  /** Never acknowledged. */
  | { status: "not_backed_up"; reason: "never" }
  /**
   * Acknowledged for a KNOWN key of THIS identity that is not the current
   * one (a rotation since): the recorded seed recovers only that retired
   * key. The only variant a surface may describe as "a retired key".
   */
  | { status: "not_backed_up"; reason: "retired_key"; coveredPublicKeyHex: string }
  /**
   * Acknowledged for ANOTHER identity (its motebit_id differs): not backed
   * up for this one. Never described as "retired".
   */
  | { status: "not_backed_up"; reason: "other_identity" }
  /**
   * Acknowledged, but which key it covers is unknown (a legacy, unbound
   * acknowledgment, or no current key to compare). Nothing says the key is
   * retired: the honest ask is to re-confirm the seed.
   */
  | { status: "not_backed_up"; reason: "unconfirmed" };

/** The posture of a seed backup for the identity's CURRENT key and id. */
export function seedBackupPosture(input: {
  ack: SeedBackupAcknowledgment;
  currentPublicKeyHex: string | null | undefined;
  motebitId: string | null | undefined;
}): SeedBackupPosture {
  const { ack } = input;
  if (typeof ack.at !== "number") return { status: "not_backed_up", reason: "never" };
  // Unbound (legacy): never honoured — one re-confirmation, by design.
  if (typeof ack.publicKeyHex !== "string" || ack.publicKeyHex === "") {
    return { status: "not_backed_up", reason: "unconfirmed" };
  }
  const current = (input.currentPublicKeyHex ?? "").toLowerCase();
  if (current === "") return { status: "not_backed_up", reason: "unconfirmed" };
  if (typeof ack.motebitId === "string" && ack.motebitId !== "") {
    const id = input.motebitId ?? "";
    if (id === "") return { status: "not_backed_up", reason: "unconfirmed" };
    if (id.toLowerCase() !== ack.motebitId.toLowerCase()) {
      return { status: "not_backed_up", reason: "other_identity" };
    }
  }
  const covered = ack.publicKeyHex.toLowerCase();
  return covered === current
    ? { status: "backed_up", at: ack.at }
    : { status: "not_backed_up", reason: "retired_key", coveredPublicKeyHex: covered };
}

/** A seed-backup acknowledgment set aside when its identity was replaced. */
export interface SeedBackupPrior {
  at: number;
  /** The key it was bound to; null for a legacy (unbound) acknowledgment. */
  key: string | null;
  motebit_id: string | null;
}

/** The config fields that record a seed backup — scoped to the identity they were made for. */
export const SEED_BACKUP_FIELDS = [
  "seed_backed_up_at",
  "seed_backed_up_key",
  "seed_backed_up_motebit_id",
  "seed_backup_prior",
] as const;

/**
 * An identity-REPLACING write (its `motebit_id` differs from the one on
 * disk) never carries the replaced identity's seed-backup acknowledgment as
 * current: the acknowledgment on disk is moved ASIDE into
 * `seed_backup_prior` (kept — never deleted), and a carried copy is dropped
 * from the current fields. An acknowledgment the write set anew (a restore,
 * which holds the seed) stays current, and the one it overwrote is kept
 * aside too, even for the same motebit_id. A rotation keeps its
 * `motebit_id` and carries its acknowledgment: untouched, it stays bound to
 * the retired key. Mutates `write`.
 *
 * The one implementation for every writer of the shared
 * `~/.motebit/config.json` that can depend on this package (the CLI's
 * `saveFullConfig`, the desktop's identity switch). create-motebit, which
 * is standalone, keeps a twin in its `config-file.ts`.
 */
export function setAsideReplacedSeedBackup(
  onDisk: Record<string, unknown>,
  write: Record<string, unknown>,
): void {
  const at = onDisk["seed_backed_up_at"];
  if (typeof at !== "number") return;
  const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
  const key = str(onDisk["seed_backed_up_key"]);
  const ackId = str(onDisk["seed_backed_up_motebit_id"]);
  const carried =
    write["seed_backed_up_at"] === at &&
    str(write["seed_backed_up_key"]) === key &&
    str(write["seed_backed_up_motebit_id"]) === ackId;
  const identityReplaced = (write["motebit_id"] ?? null) !== (onDisk["motebit_id"] ?? null);
  // Same identity, acknowledgment carried (a rotation): nothing to move.
  if (!identityReplaced && carried) return;
  const priorOf = (c: Record<string, unknown>): SeedBackupPrior[] =>
    Array.isArray(c["seed_backup_prior"]) ? (c["seed_backup_prior"] as SeedBackupPrior[]) : [];
  const kept: SeedBackupPrior[] = [];
  const entry: SeedBackupPrior = { at, key, motebit_id: ackId ?? str(onDisk["motebit_id"]) };
  for (const p of [...priorOf(onDisk), ...priorOf(write), entry]) {
    if (!kept.some((k) => k.at === p.at && k.key === p.key && k.motebit_id === p.motebit_id)) {
      kept.push(p);
    }
  }
  write["seed_backup_prior"] = kept;
  if (identityReplaced && carried) {
    delete write["seed_backed_up_at"];
    delete write["seed_backed_up_key"];
    delete write["seed_backed_up_motebit_id"];
  }
}

/**
 * What a flat surface says, once, when a rotation commits. The recovery
 * seed is the key, so it changed; the old one still recovers the retired
 * key (and whatever its address holds), so it is kept, not thrown away.
 */
export const ROTATION_SEED_BACKUP_NOTICE =
  "Your recovery seed changed with the key. The seed you saved before recovers only the retired key — keep it, and back up the new one from Settings → Identity → Recovery seed.";
