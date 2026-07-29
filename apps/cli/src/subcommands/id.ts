/**
 * `motebit id` — display the identity card from local config.
 *
 * No file read, no cryptographic verification — just prints the
 * motebit_id, did:key, public key fingerprint, device_id, and config
 * path that are already known from the persisted CLI config. Sync.
 */

import { hexPublicKeyToDidKey } from "@motebit/encryption";
import { CONFIG_DIR, loadFullConfig } from "../config.js";
import { NO_IDENTITY_MESSAGE } from "./_helpers.js";

/**
 * Pure render of the identity card, shared by the shell subcommand and
 * the REPL's `/id` slash (surface-determinism: the same capability, two
 * deterministic entry points). Returns null when no identity exists so
 * each surface picks its own failure posture (shell exits 1, REPL stays).
 */
export function renderIdentityCard(config: {
  motebit_id?: string;
  device_public_key?: string;
  device_id?: string;
}): string[] | null {
  if (!config.motebit_id) return null;

  const lines: string[] = [""];
  lines.push(`  motebit_id   ${config.motebit_id}`);

  if (config.device_public_key) {
    try {
      lines.push(`  did          ${hexPublicKeyToDidKey(config.device_public_key)}`);
    } catch {
      // Non-fatal — key may be invalid
    }
    lines.push(`  public_key   ${config.device_public_key.slice(0, 16)}...`);
  }

  if (config.device_id) {
    lines.push(`  device_id    ${config.device_id}`);
  }

  lines.push(`  config       ${CONFIG_DIR}/config.json`);
  lines.push("");
  return lines;
}

export function handleId(): void {
  const lines = renderIdentityCard(loadFullConfig());

  if (lines == null) {
    console.error(NO_IDENTITY_MESSAGE);
    process.exit(1);
  }

  for (const line of lines) console.log(line);
}
