/**
 * What a local identity file (motebit.md) may contribute to the machine
 * roster — the one rule every surface applies (#800; #799 W1;
 * `docs/proposals/machine-roster-surfaces-v1.md` §1A F2).
 *
 * An identity file is self-signed: its signature proves possession of the
 * key it names, never that the key speaks for the identity. A file found on
 * disk or in storage — left behind by another identity, or planted in a
 * parent directory — can name any motebit_id, any guardian and any
 * "succession". So a file is BOUND, and contributes anything at all, only
 * when all three hold:
 *
 *   1. its signature verifies (`verify` from `@motebit/identity-file`, called
 *      here — never a verifier a surface hands in);
 *   2. it names THIS motebit_id;
 *   3. its current public key is exactly the key this surface HOLDS — so the
 *      file was signed by the very key in hand, and whoever wrote it is
 *      this device.
 *
 * Anything else contributes nothing: no records and no guardian. The
 * records of a bound file are self-verifying evidence for the resolver,
 * never a class. Whether a surface also PINS the bound file's guardian is
 * the surface's decision (the phone and the desktop never do; the CLI does,
 * from a bound file only).
 */
import { verify as verifyIdentityFile } from "@motebit/identity-file";
import type { KeySuccessionRecord } from "@motebit/sdk";

const HEX_32 = /^[0-9a-f]{64}$/;

/** A file that passed all three conditions. */
export interface BoundIdentityFile {
  /** The file's current key — equal to the held key, lowercased. */
  publicKeyHex: string;
  records: KeySuccessionRecord[];
  /** The guardian the file names, when it is a well-formed (lowercase hex) key; else null. */
  guardian: string | null;
}

/**
 * The file, when it verifies, names `motebitId` and its current key is
 * `heldPublicKeyHex`; otherwise null. Never throws.
 */
export async function boundIdentityFile(
  motebitId: string,
  content: string | null,
  heldPublicKeyHex: string | null,
): Promise<BoundIdentityFile | null> {
  if (content == null || content === "" || heldPublicKeyHex == null) return null;
  const held = heldPublicKeyHex.toLowerCase();
  if (!HEX_32.test(held)) return null;
  try {
    const v = await verifyIdentityFile(content, { expectedType: "identity" });
    if (v.type !== "identity" || v.valid !== true || v.identity == null) return null;
    if (v.identity.motebit_id !== motebitId) return null;
    const key = v.identity.identity?.public_key;
    if (typeof key !== "string" || key.toLowerCase() !== held) return null;
    const g = v.identity.guardian?.public_key;
    return {
      publicKeyHex: held,
      records: [...(v.identity.succession ?? [])],
      guardian: typeof g === "string" && HEX_32.test(g) ? g : null,
    };
  } catch {
    return null;
  }
}

/**
 * The succession records of a bound file (see `boundIdentityFile`); `[]` for
 * any file that is not bound. Never a guardian.
 */
export async function identityFileRecords(
  motebitId: string,
  content: string | null,
  heldPublicKeyHex: string | null,
): Promise<KeySuccessionRecord[]> {
  return (await boundIdentityFile(motebitId, content, heldPublicKeyHex))?.records ?? [];
}
