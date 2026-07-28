/**
 * `motebit restore [motebit.md]` — the CLI's identity-recovery entry point.
 *
 * The restore arc (docs/doctrine/identity-restore.md, shipped 2026-05-15)
 * built the three-layer split — `importIdentityFile` + `validateRestoreRequest`
 * in `@motebit/identity-file`, per-surface `restoreIdentity` — on web, desktop,
 * and mobile. The CLI never got its entry point, which meant the surface a
 * founder actually locks themselves out on had no recovery affordance at all
 * (#428; the 2026-07-28 near-miss). This subcommand is the CLI's layer 3,
 * consuming the existing layer 1/2 primitives verbatim.
 *
 * Two entry points, one downstream contract (doctrine § "Two entry points"):
 *   - `motebit restore path/to/motebit.md` — full-bundle restore. The id,
 *     born date, and governance ride in the signed file; works for LEGACY
 *     (pre-sovereign) ids, whose motebit_id is not derivable from the seed.
 *   - `motebit restore` (no arg) — seed-only. The motebit_id is re-derived
 *     as the sovereign commitment to the key (`synthesizeSeedRestoreMetadata`
 *     — the single source of truth; hand-copying that synthesis is how two
 *     surfaces silently regressed to random UUIDs). A legacy id CANNOT come
 *     back this way; the flow says so before asking for any confirmation.
 *
 * A third case the doctrine doesn't name, discovered live: when the pasted
 * seed derives to the CURRENT config's public key, nothing is being replaced
 * — the user forgot their passphrase while the key sat safely encrypted on
 * disk. That is a PASSPHRASE RESET: re-encrypt the same key under a new
 * passphrase, identity untouched, no REPLACE confirmation demanded. This was
 * the founder's exact situation, and demanding "REPLACE IDENTITY" for it
 * would be both hostile and wrong.
 *
 * Cross-surface invariants honored (doctrine § "Cross-surface invariants"):
 * replacing an EXISTING different identity requires BOTH the cryptographic
 * gate (validateRestoreRequest's key-match) AND the intentional gate (typed
 * "REPLACE IDENTITY") — either alone is insufficient. Hard overwrite: local
 * data keyed to the old motebit_id stays orphaned, and the flow says so.
 */

import * as fs from "node:fs";
import * as readline from "node:readline";
import {
  importIdentityFile,
  synthesizeSeedRestoreMetadata,
  validateRestoreRequest,
  type ImportedIdentityMetadata,
} from "@motebit/identity-file";

import { base58Encode } from "@motebit/sdk";
import {
  hexToBytes,
  bytesToHex,
  getPublicKeyBySuite,
  deriveSovereignMotebitId,
} from "@motebit/encryption";
import type { CliConfig } from "../args.js";
import { loadFullConfig, saveFullConfig } from "../config.js";
import { encryptPrivateKey, promptPassphrase } from "../identity.js";
import { bold, dim, error as errorColor, success, warn } from "./../colors.js";

const IDENTITY_SUITE = "motebit-jcs-ed25519-hex-v1" as const;

/** Visible (unmasked) one-line prompt — type-to-confirm must be readable. */
function askVisible(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) =>
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    }),
  );
}

/**
 * Classify what a restore with this seed would DO, given current config.
 * Pure — the whole decision surface of the flow, extracted for tests.
 */
export type RestorePlan =
  | { kind: "passphrase_reset"; motebitId: string }
  | { kind: "fresh_install"; motebitId: string }
  | { kind: "replace"; oldMotebitId: string; newMotebitId: string };

export function planRestore(
  derivedPublicKeyHex: string,
  targetMotebitId: string,
  current: { motebit_id?: string; device_public_key?: string },
): RestorePlan {
  if (
    current.device_public_key != null &&
    current.device_public_key.toLowerCase() === derivedPublicKeyHex.toLowerCase()
  ) {
    // Same key already on disk — the user is locked out, not migrating.
    return { kind: "passphrase_reset", motebitId: current.motebit_id ?? targetMotebitId };
  }
  if (current.motebit_id == null || current.motebit_id === "") {
    return { kind: "fresh_install", motebitId: targetMotebitId };
  }
  return { kind: "replace", oldMotebitId: current.motebit_id, newMotebitId: targetMotebitId };
}

/**
 * Is this metadata's id the sovereign commitment to its key? Legacy
 * (pre-sovereign) ids are not — and the copy must say what that means for
 * the user's recovery options rather than letting them find out at loss time.
 */
export async function isSovereignId(metadata: ImportedIdentityMetadata): Promise<boolean> {
  return (await deriveSovereignMotebitId(metadata.publicKey)) === metadata.motebitId;
}

export async function handleRestore(config: CliConfig): Promise<void> {
  const mdPath = config.positionals[1];

  // ── Read the .md first (fail before any prompting if it's unreadable) ──
  let mdContent: string | null = null;
  if (mdPath != null) {
    try {
      mdContent = fs.readFileSync(mdPath, "utf-8");
    } catch (err: unknown) {
      console.error(`Cannot read ${mdPath}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
  }

  let metadata: ImportedIdentityMetadata;
  let originalContent: string | undefined;
  if (mdContent != null) {
    const imported = await importIdentityFile(mdContent);
    if (!imported.valid) {
      console.error(`Identity file failed verification: ${imported.reason}`);
      console.error(dim("The signature chain must verify before a restore is attempted."));
      process.exit(1);
    }
    metadata = imported.metadata;
    originalContent = mdContent;
    console.log(`\n  Restoring ${bold(metadata.motebitId)} from ${mdPath}`);
  } else {
    console.log(`\n  ${bold("Seed-only restore")} — no motebit.md provided.`);
  }

  // ── The seed ──
  const seedHex = (await promptPassphrase("  Recovery seed (64 hex chars): ")).trim();
  if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
    console.error("\n  A recovery seed is exactly 64 hex characters (32 bytes).");
    process.exit(1);
  }
  const publicKeyHex = bytesToHex(await getPublicKeyBySuite(hexToBytes(seedHex), IDENTITY_SUITE));

  if (mdContent == null) {
    // Seed-only synthesis — the single canonical source, never hand-copied.
    metadata = await synthesizeSeedRestoreMetadata(publicKeyHex, "CLI");
  }

  // ── Layer-2 validation (cryptographic gate) ──
  const failure = await validateRestoreRequest({
    privateKeyHex: seedHex,
    metadata: metadata!,
    ...(originalContent != null ? { originalContent } : {}),
    preserveMemories: false,
  });
  if (failure != null) {
    if (failure === "key_mismatch") {
      console.error(`\n  ${errorColor("This seed does not belong to that motebit.md.")}`);
      console.error(dim("  The derived public key differs from the identity file's key."));
    } else {
      console.error(`\n  Restore validation failed: ${failure}`);
    }
    process.exit(1);
  }

  // ── Plan: reset / fresh / replace ──
  const full = loadFullConfig();
  const plan = planRestore(publicKeyHex, metadata!.motebitId, full);

  if (plan.kind === "passphrase_reset") {
    console.log(`\n  ${success("This seed matches your current identity.")}`);
    console.log(dim("  Nothing is replaced — you are setting a new passphrase for the same key."));
  } else if (plan.kind === "replace") {
    console.log(
      `\n  ${warn(bold("⚠ REPLACE"))} This machine currently holds ${bold(plan.oldMotebitId)}.`,
    );
    console.log(dim("  Restoring will overwrite it. Local data keyed to the old identity"));
    console.log(dim("  (memories, trust, ledger) stays on disk but orphaned — hard overwrite,"));
    console.log(dim("  per docs/doctrine/identity-restore.md. This cannot be undone without"));
    console.log(dim("  the OLD identity's own seed."));
    const confirm = await askVisible(`  Type ${bold("REPLACE IDENTITY")} to continue: `);
    if (confirm.trim() !== "REPLACE IDENTITY") {
      console.log("\n  Nothing changed.");
      process.exit(1);
    }
  }

  // Honesty for seed-only restores of what was a legacy identity: the
  // sovereign re-derivation CANNOT resurrect a pre-sovereign random id.
  if (mdContent == null) {
    console.log(dim("\n  Note: the motebit_id above is re-derived from the seed (sovereign"));
    console.log(dim("  minting). If your original identity had a legacy id, that id can only"));
    console.log(dim("  be recovered by restoring FROM its motebit.md — the key and wallet"));
    console.log(dim("  recover either way."));
  }

  // ── New passphrase, encrypt, write ──
  const pass1 = await promptPassphrase("  New passphrase: ");
  if (pass1 === "") {
    console.error("  Passphrase cannot be empty.");
    process.exit(1);
  }
  const pass2 = await promptPassphrase("  Confirm passphrase: ");
  if (pass1 !== pass2) {
    console.error("  Passphrases do not match. Nothing changed.");
    process.exit(1);
  }

  const encrypted = await encryptPrivateKey(seedHex, pass1);
  const next = loadFullConfig();
  next.cli_encrypted_key = encrypted;
  delete next.cli_private_key; // never leave a plaintext sibling behind
  next.device_public_key = publicKeyHex;
  if (plan.kind !== "passphrase_reset") {
    next.motebit_id = metadata!.motebitId;
    next.device_id = crypto.randomUUID();
    if (originalContent != null) {
      // Preserve the signed governance anchor, mirroring desktop's
      // `_identity_file` slot (identity-restore doctrine § entry points).
      (next as Record<string, unknown>)["_identity_file"] = originalContent;
    }
  }
  // They demonstrably HOLD the seed — that is what "backed up" means.
  next.seed_backed_up_at = Date.now();
  saveFullConfig(next);

  const wallet = base58Encode(hexToBytes(publicKeyHex));
  console.log(`\n  ${success("Restored.")} ${bold(metadata!.motebitId)}`);
  console.log(`  Sovereign wallet: ${wallet}`);
  console.log(dim("  Any funds at that address are controlled by this key again."));
  if (plan.kind !== "passphrase_reset") {
    console.log(dim("  Next: `motebit register` to (re)connect this identity to the relay."));
  }
  process.exit(0);
}
