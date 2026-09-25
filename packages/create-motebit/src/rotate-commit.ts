/**
 * Committing a `create-motebit rotate` to disk without losing a key at any
 * failure point.
 *
 * A rotation changes three files: the config (which holds the ONLY copy of
 * the encrypted private key), `motebit.md` (which names the public key), and
 * `motebit.md.backup`. They cannot change atomically together, and unlike
 * the CLI (whose `pending-rotation.json` write-ahead holds the new key before
 * anything moves), this command had nothing holding either key while they
 * changed. The invariant here: BEFORE any file that names or holds a key is
 * replaced, both keys are durably held somewhere owner-only.
 *
 *   1. keep the current config (the OLD key) as `config.json.pre-rotation-<t>`
 *   2. write the next config (the NEW key) as `config.json.rotation-next-<t>`
 *   3. write `motebit.md.backup` (the old identity file)
 *   4. replace `motebit.md` atomically (now it names the NEW key — held by 2)
 *   5. replace the config atomically (now it holds the NEW key)
 *   6. only then remove 1 and 2 — the old key is retired on purpose, which is
 *      what a rotation is for, and 2 is now identical to the config.
 *
 * A failure at 1 or 2 changes nothing that names a key. A failure at 3, 4 or
 * 5 leaves both keys on disk and a `RotationCommitError` that names where.
 */
import { realpathSync, rmSync } from "node:fs";
import {
  backupStamp,
  currentModeOr,
  preserveAside,
  writeConfigFile,
  writeFileAtomic,
} from "./config-file.js";

export interface RotationCommitPlan {
  configPath: string;
  identityPath: string;
  /** The identity file's bytes before the rotation (written to `<identity>.backup`). */
  previousIdentity: string;
  /** The rotated identity file. */
  nextIdentity: string;
  /** The full next config — carries the NEW encrypted key. */
  nextConfig: object;
  now?: Date;
}

/** The three replacements, injectable so each failure point can be exercised. */
export interface RotationCommitOps {
  writeBackup(path: string, contents: string): void;
  writeIdentity(path: string, contents: string): void;
  writeConfig(path: string, config: object): void;
}

export const defaultRotationCommitOps: RotationCommitOps = {
  writeBackup: (p, c) => writeFileAtomic(p, c, currentModeOr(p, 0o644)),
  writeIdentity: (p, c) => writeFileAtomic(p, c, currentModeOr(p, 0o644)),
  writeConfig: (p, cfg) => {
    writeConfigFile(p, cfg);
  },
};

export type RotationCommitStep = "hold-old" | "hold-new" | "backup" | "identity" | "config";

export class RotationCommitError extends Error {
  constructor(
    readonly step: RotationCommitStep,
    /** Where the OLD key is held (the config itself, or its pre-rotation copy). */
    readonly oldKeyAt: string,
    /** Where the NEW key is held, or null if it was never written anywhere (nothing names it). */
    readonly newKeyAt: string | null,
    /** Which key `motebit.md` names now. */
    readonly identityNames: "old" | "new",
    cause: unknown,
  ) {
    super(
      `rotation stopped at "${step}": ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "RotationCommitError";
  }
}

/**
 * The one command that finishes a rotation stopped at the config step: move
 * the held next config into place. It names the config's REAL path — a `mv`
 * onto a symlinked config's name would replace the link with a regular file.
 */
export function finishRotationCommand(newKeyAt: string, configPath: string): string {
  let target = configPath;
  try {
    target = realpathSync(configPath);
  } catch {
    /* not resolvable — name it as given */
  }
  return `mv "${newKeyAt}" "${target}"`;
}

export interface RotationCommitResult {
  backupPath: string;
}

export function commitRotation(
  plan: RotationCommitPlan,
  ops: RotationCommitOps = defaultRotationCommitOps,
): RotationCommitResult {
  const now = plan.now ?? new Date();
  const backupPath = `${plan.identityPath}.backup`;

  // 1. The OLD key, kept before anything moves.
  let oldCopy: string;
  try {
    oldCopy = preserveAside(plan.configPath, ".pre-rotation-", now);
  } catch (err) {
    throw new RotationCommitError("hold-old", plan.configPath, null, "old", err);
  }

  // 2. The NEW key, held before anything names it.
  const newCopy = `${plan.configPath}.rotation-next-${backupStamp(now)}`;
  try {
    writeFileAtomic(newCopy, JSON.stringify(plan.nextConfig, null, 2) + "\n", 0o600);
  } catch (err) {
    // Nothing names the new key and the config still holds the old one: the
    // rotation did not happen. The old copy is redundant; drop it.
    rmSync(oldCopy, { force: true });
    throw new RotationCommitError("hold-new", plan.configPath, null, "old", err);
  }

  // 3–5. Both keys are held; now the files that name and hold them move.
  try {
    ops.writeBackup(backupPath, plan.previousIdentity);
  } catch (err) {
    throw new RotationCommitError("backup", oldCopy, newCopy, "old", err);
  }
  try {
    ops.writeIdentity(plan.identityPath, plan.nextIdentity);
  } catch (err) {
    throw new RotationCommitError("identity", oldCopy, newCopy, "old", err);
  }
  try {
    ops.writeConfig(plan.configPath, plan.nextConfig);
  } catch (err) {
    throw new RotationCommitError("config", oldCopy, newCopy, "new", err);
  }

  // 6. Committed. The new copy is now the config; the old key is retired.
  rmSync(newCopy, { force: true });
  rmSync(oldCopy, { force: true });
  return { backupPath };
}
