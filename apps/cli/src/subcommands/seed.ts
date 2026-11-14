/**
 * `motebit seed` — recovery-seed backup status and passphrase-gated reveal.
 *
 * The other half of restore (#428): `motebit restore` is worthless if the
 * user never recorded the seed while they still could. Sovereignty means no
 * operator can recover the key — so the self-recovery door has to be lit
 * BEFORE loss, not found missing at loss time (the 2026-07-28 founder
 * near-miss: no seed recorded, no guardian, no keyring copy; recovery came
 * down to guessing a passphrase).
 *
 *   motebit seed          — backup status + what the seed does/doesn't recover
 *   motebit seed reveal   — passphrase-gated, prints the seed ONCE for
 *                           transcription to paper; records acknowledgment
 *                           only after an explicit "I wrote it down" confirm
 *
 * Honesty is identity-type-dependent and stated up front (identity-restore
 * doctrine § "Two entry points"): a SOVEREIGN id is the commitment to the
 * key, so the seed alone re-derives the full identity. A LEGACY id was
 * minted independently of the key — the seed recovers the key and wallet,
 * but the id itself rides only in motebit.md, so the backup instruction is
 * "seed + motebit.md, together".
 *
 * The acknowledgment (`seed_backed_up_at`) is self-reported by design — we
 * cannot verify paper. It exists to make the nudge (doctor + one dim REPL
 * line) dismissible by the honest act it asks for, not to prove anything.
 */

import * as readline from "node:readline";

import { base58Encode } from "@motebit/sdk";
import {
  bytesToHex,
  getPublicKeyBySuite,
  hexToBytes,
  deriveSovereignMotebitId,
} from "@motebit/encryption";
import { seedBackupPosture, type SeedBackupPosture } from "@motebit/surface-kit";
import type { CliConfig } from "../args.js";
import { loadFullConfig, saveFullConfig, type FullConfig } from "../config.js";
import { decryptPrivateKey, promptPassphrase } from "../identity.js";
import { bold, dim, success, warn } from "../colors.js";

/** The config fields the seed-backup posture reads. */
export interface SeedBackupConfig {
  cli_encrypted_key?: unknown;
  seed_backed_up_at?: number;
  seed_backed_up_key?: string;
  seed_backed_up_motebit_id?: string;
  device_public_key?: string;
  motebit_id?: string;
}

/**
 * The seed-backup posture of a config, for status/doctor/nudge/keychain.
 * The acknowledgment covers the key and identity it names
 * (`seed_backed_up_key`, `seed_backed_up_motebit_id`), never a later key: a
 * committed rotation moves `device_public_key`, so this reads
 * "not_backed_up" from that moment on, whichever path committed it. An
 * unbound (legacy) acknowledgment is never honoured: one re-confirmation,
 * by design (see `seedBackupPosture` in `@motebit/surface-kit`).
 */
export function seedBackupPostureOf(
  config: SeedBackupConfig,
): { status: "no_identity" } | SeedBackupPosture {
  if (config.cli_encrypted_key == null) return { status: "no_identity" };
  return seedBackupPosture({
    ack: {
      ...(config.seed_backed_up_at !== undefined ? { at: config.seed_backed_up_at } : {}),
      ...(config.seed_backed_up_key !== undefined
        ? { publicKeyHex: config.seed_backed_up_key }
        : {}),
      ...(config.seed_backed_up_motebit_id !== undefined
        ? { motebitId: config.seed_backed_up_motebit_id }
        : {}),
    },
    currentPublicKeyHex: config.device_public_key,
    motebitId: config.motebit_id,
  });
}

/**
 * Record that the owner wrote the seed down — for the identity and key
 * captured WHEN THE SEED WAS SHOWN, never "whatever is current now". The
 * config is re-read first: if another process (a `motebit rotate`, a
 * restore, create-motebit, the desktop) changed the identity or key while
 * the seed was on screen, nothing is recorded — the seed shown may not be
 * the current one.
 */
export async function recordSeedAcknowledgment(input: {
  /** What the config said when the seed was revealed. */
  shown: { motebitId: string | undefined; publicKeyHex: string | undefined };
  seedHex: string;
  load?: () => FullConfig;
  save?: (config: FullConfig) => unknown;
  now?: () => number;
}): Promise<{ recorded: true } | { recorded: false; reason: string }> {
  const load = input.load ?? loadFullConfig;
  const save = input.save ?? saveFullConfig;
  const next = load();
  if (
    next.motebit_id !== input.shown.motebitId ||
    next.device_public_key !== input.shown.publicKeyHex
  ) {
    return {
      recorded: false,
      reason:
        "the identity or key on this machine changed while the seed was on screen (another motebit process ran); nothing was recorded — run `motebit seed reveal` again",
    };
  }
  next.seed_backed_up_at = (input.now ?? Date.now)();
  // Bound to the key THIS seed derives and the identity it was shown for:
  // a later rotation reads "retired key", another identity "not backed up
  // for this identity" — without anyone clearing anything.
  next.seed_backed_up_key = await seedPublicKeyHex(input.seedHex);
  if (next.motebit_id !== undefined) next.seed_backed_up_motebit_id = next.motebit_id;
  save(next);
  return { recorded: true };
}

/**
 * What every CLI reader says about a posture that is not backed up. Says
 * "retired key" ONLY when the acknowledgment names a known key that is not
 * the current one; an acknowledgment whose key is unknown asks for a
 * re-confirmation and claims nothing about any key.
 */
export function seedBackupWording(posture: { status: string; reason?: string }): {
  /** One dim startup line. */
  nudge: string;
  /** `motebit doctor`'s detail. */
  doctor: string;
  /** `motebit seed`'s explanation (empty when nothing more to say). */
  detail: string;
  /** `motebit keychain enroll`'s headline. */
  keychain: string;
} {
  if (posture.status === "not_backed_up" && posture.reason === "retired_key") {
    return {
      nudge:
        "recovery seed not backed up for the current key — `motebit seed reveal` (once, on paper)",
      doctor: "recorded for a retired key; not recorded for the current one",
      keychain: "Your recovery seed is not backed up for the current key.",
      detail:
        "  The seed you recorded is for a retired key. Keep it — it still recovers that key\n" +
        "  and anything left at its address — and record the current one.",
    };
  }
  if (posture.status === "not_backed_up" && posture.reason === "other_identity") {
    return {
      nudge:
        "recovery seed not backed up for this identity — `motebit seed reveal` (once, on paper)",
      doctor: "not backed up for this identity",
      keychain: "Your recovery seed is not backed up for this identity.",
      detail: "  The backup recorded on this machine was for another identity.",
    };
  }
  if (posture.status === "not_backed_up" && posture.reason === "unconfirmed") {
    return {
      nudge: "please re-confirm your recovery seed — `motebit seed reveal` (once, on paper)",
      doctor: "please re-confirm your recovery seed",
      keychain: "Please re-confirm your recovery seed.",
      detail:
        "  Please re-confirm your recovery seed: the backup recorded earlier does not say\n" +
        "  which key it covers, so it is asked for once more.",
    };
  }
  return {
    nudge: "recovery seed not backed up — `motebit seed reveal` (once, on paper)",
    doctor: posture.status === "backed_up" ? "recovery seed recorded" : "not recorded",
    keychain: "Your recovery seed is still not backed up.",
    detail: "",
  };
}

/** The public key (hex) a recovery seed derives — what an acknowledgment of it covers. */
export async function seedPublicKeyHex(seedHex: string): Promise<string> {
  return bytesToHex(await getPublicKeyBySuite(hexToBytes(seedHex), "motebit-jcs-ed25519-hex-v1"));
}

/**
 * What `motebit rotate` says, once, after a committed rotation: the seed IS
 * the key, so it changed. The startup line and `motebit doctor` keep the
 * reminder until the new seed is recorded.
 */
export const ROTATION_SEED_NOTICE_LINES = [
  "Recovery seed: changed with the key. The seed you recorded before recovers only the",
  "  retired key — keep it (it still reaches anything left at that address), and record",
  "  the new one: motebit seed reveal",
] as const;

export async function handleSeed(config: CliConfig): Promise<void> {
  const sub = config.positionals[1];
  const full = loadFullConfig();

  const posture = seedBackupPostureOf(full);
  const status = posture.status;
  if (posture.status === "no_identity") {
    console.log("\n  No identity on this machine. Run `motebit init` or `motebit restore`.");
    process.exit(1);
  }

  const sovereign =
    full.motebit_id != null &&
    full.device_public_key != null &&
    (await deriveSovereignMotebitId(full.device_public_key)) === full.motebit_id;

  if (sub !== "reveal") {
    // ── Status ──
    console.log(`\n  Identity     ${full.motebit_id ?? "?"}`);
    console.log(
      `  Seed backup  ${
        posture.status === "backed_up"
          ? success(`recorded ${new Date(posture.at).toISOString().slice(0, 10)}`)
          : warn("NOT recorded")
      }`,
    );
    const { detail } = seedBackupWording(posture);
    if (detail !== "") console.log(dim(detail));
    console.log(
      dim(
        sovereign
          ? "  Sovereign id: the seed alone recovers your full identity, wallet, and id."
          : "  Legacy id: the seed recovers your key and wallet; your motebit_id rides only\n" +
              "  in motebit.md — back up BOTH (seed on paper, motebit.md anywhere durable).",
      ),
    );
    if (status === "not_backed_up") {
      console.log(
        `\n  ${bold("motebit seed reveal")} ${dim("— show it once, write it on paper.")}`,
      );
      console.log(dim("  No operator can recover this key for you. That is the point."));
    }
    process.exit(0);
  }

  // ── Reveal ──
  if (!full.cli_encrypted_key) {
    console.error("  No encrypted key in config.");
    process.exit(1);
  }
  const passphrase = await promptPassphrase("  Passphrase: ");
  let seedHex: string;
  try {
    seedHex = await decryptPrivateKey(full.cli_encrypted_key, passphrase);
  } catch {
    console.error("\n  Incorrect passphrase. (Attempts are offline and unlimited.)");
    process.exit(1);
  }

  const wallet = full.device_public_key
    ? base58Encode(hexToBytes(full.device_public_key))
    : "(unknown)";

  console.log(`\n  ${warn(bold("Write this down on paper. It IS your identity."))}`);
  console.log(dim("  Anyone holding it controls the identity and the wallet below."));
  console.log(dim("  Do not store it in a screenshot, a chat, or an unencrypted file.\n"));
  console.log(`    ${bold(seedHex!)}\n`);
  console.log(
    `  Identity  ${full.motebit_id ?? "?"}${sovereign ? dim(" (sovereign — seed alone recovers it)") : dim(" (legacy — keep motebit.md WITH the seed)")}`,
  );
  console.log(`  Wallet    ${wallet}`);
  console.log(
    dim(`\n  Recover later with: motebit restore${sovereign ? "" : " path/to/motebit.md"}`),
  );

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ack = await new Promise<string>((resolve) =>
    rl.question(
      `\n  Type ${bold("y")} once it is written down (anything else records nothing): `,
      (a) => {
        rl.close();
        resolve(a);
      },
    ),
  );
  if (ack.trim().toLowerCase() === "y") {
    // For the identity and key the seed was shown for (`full`, read before
    // the reveal) — refused if either changed meanwhile.
    const result = await recordSeedAcknowledgment({
      shown: { motebitId: full.motebit_id, publicKeyHex: full.device_public_key },
      seedHex: seedHex!,
    });
    if (!result.recorded) {
      console.error(`\n  ${warn("Not recorded:")} ${result.reason}.`);
      process.exit(1);
    }
    console.log(`\n  ${success("Recorded.")} ${dim("The startup reminder is gone.")}`);
  } else {
    console.log(dim("\n  Not recorded — the reminder stays until you confirm a backup."));
  }
  process.exit(0);
}
