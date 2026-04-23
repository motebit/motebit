/**
 * `motebit attest` — self-signed hardware-attestation credential.
 *
 * Produces a W3C `VerifiableCredential` (`eddsa-jcs-2022` proof) whose
 * subject carries a `hardware_attestation` claim. The CLI runs outside
 * the Tauri app process, so it cannot invoke the Rust Secure Enclave
 * bridge; this command emits a `platform: "software"` claim — truthful,
 * scorable by `HardwareAttestationSemiring` at 0.1, and compatible with
 * the full verification path. Desktop-app flows that want a
 * hardware-rooted claim (`platform: "secure_enclave"`) call
 * `mintAttestationClaim` from `apps/desktop/src/secure-enclave-attest.ts`
 * directly and embed the result in the same credential shape.
 *
 * Output:
 *   - stdout by default (pipeable: `motebit attest | motebit-verify -`)
 *   - `-o <path>` / `--output <path>` writes to a file
 *
 * Why a CLI command and not a library call: the attestation flow has
 * to load the identity's private key, decrypt with the user's
 * passphrase, sign, and write the result. That's the CLI's job. The
 * command is side-effect-free beyond stdout/file-write and does not
 * hit the relay.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

// Product-level signing surface. `@motebit/encryption` re-exports the
// `@motebit/crypto` primitives apps are allowed to consume — per the
// `check-app-primitives` drift gate, apps bind to the product
// vocabulary (Layer ≥1 BSL) rather than the MIT Layer-0 protocol
// primitives directly. The composer is the single source of truth
// shared with the desktop surface (`mintHardwareCredential`).
import {
  composeHardwareAttestationCredential,
  type HardwareAttestationCredentialSubject,
  type VerifiableCredential,
} from "@motebit/encryption";
import { openMotebitDatabase } from "@motebit/persistence";

import type { CliConfig } from "../args.js";
import { loadFullConfig, saveFullConfig } from "../config.js";
import {
  fromHex,
  bootstrapIdentity,
  decryptPrivateKey,
  encryptPrivateKey,
  promptPassphrase,
} from "../identity.js";
import { getDbPath } from "../runtime-factory.js";

export interface BuildAttestationCredentialInput {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
  readonly publicKeyHex: string;
  readonly now: number;
}

/**
 * CLI-surface wrapper around the canonical composer — hardcodes
 * `platform: "software"` because the CLI process can't reach the
 * Secure Enclave. Desktop calls the composer directly via
 * `mintHardwareCredential` with an SE-signed claim. Keeping this
 * thin wrapper preserves the CLI-local test surface while all shape
 * decisions live in `@motebit/encryption`.
 */
export async function buildAttestationCredential(
  input: BuildAttestationCredentialInput,
): Promise<VerifiableCredential<HardwareAttestationCredentialSubject>> {
  return composeHardwareAttestationCredential({
    publicKey: input.publicKey,
    publicKeyHex: input.publicKeyHex,
    privateKey: input.privateKey,
    hardwareAttestation: {
      platform: "software",
      key_exported: false,
    },
    now: input.now,
  });
}

export async function handleAttest(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    escapeCodeTimeout: 50,
  });

  // ── Passphrase resolution — mirrors the pattern in export.ts so
  //    the two commands feel identical to operators.
  const envPassphrase = process.env["MOTEBIT_PASSPHRASE"];
  let passphrase: string;

  if (fullConfig.cli_encrypted_key) {
    passphrase = envPassphrase ?? (await promptPassphrase(rl, "Passphrase: "));
    try {
      await decryptPrivateKey(fullConfig.cli_encrypted_key, passphrase);
    } catch {
      process.stderr.write("Error: incorrect passphrase.\n");
      rl.close();
      process.exit(1);
    }
  } else if (fullConfig.cli_private_key != null && fullConfig.cli_private_key !== "") {
    passphrase =
      envPassphrase ?? (await promptPassphrase(rl, "Set a passphrase for key encryption: "));
    if (passphrase === "") {
      process.stderr.write("Error: passphrase cannot be empty.\n");
      rl.close();
      process.exit(1);
    }
    fullConfig.cli_encrypted_key = await encryptPrivateKey(fullConfig.cli_private_key, passphrase);
    delete fullConfig.cli_private_key;
    saveFullConfig(fullConfig);
  } else {
    passphrase = envPassphrase ?? (await promptPassphrase(rl, "Set a passphrase: "));
    if (!passphrase) {
      process.stderr.write("Error: passphrase cannot be empty.\n");
      rl.close();
      process.exit(1);
    }
  }

  // ── Bootstrap / load identity.
  const dbPath = getDbPath(config.dbPath);
  const moteDb = await openMotebitDatabase(dbPath);
  const { motebitId } = await bootstrapIdentity(moteDb, fullConfig, passphrase);

  const updatedConfig = loadFullConfig();
  if (!updatedConfig.cli_encrypted_key) {
    process.stderr.write("Error: no encrypted key found in config.\n");
    moteDb.close();
    rl.close();
    process.exit(1);
  }
  const privKeyHex = await decryptPrivateKey(updatedConfig.cli_encrypted_key, passphrase);
  const privateKey = fromHex(privKeyHex);
  const publicKeyHex = updatedConfig.device_public_key ?? "";

  if (!publicKeyHex) {
    process.stderr.write("Error: device_public_key not set in config.\n");
    moteDb.close();
    rl.close();
    process.exit(1);
  }
  const publicKey = fromHex(publicKeyHex);

  const signed = await buildAttestationCredential({
    privateKey,
    publicKey,
    publicKeyHex,
    now: Date.now(),
  });

  moteDb.close();
  rl.close();

  // ── Output — stdout by default; file with -o.
  const json = JSON.stringify(signed, null, 2);
  if (config.output != null && config.output !== "") {
    const outPath = path.resolve(config.output);
    fs.writeFileSync(outPath, `${json}\n`, "utf-8");
    // Write a brief confirmation to stderr so `motebit attest -o file.json`
    // stays silent on stdout (scriptable).
    process.stderr.write(
      `Wrote attestation credential for ${motebitId.slice(0, 8)}… to ${outPath}\n`,
    );
  } else {
    process.stdout.write(`${json}\n`);
  }
}
