/**
 * `motebit id` — display the identity card from local config.
 *
 * No file read, no cryptographic verification — just prints the
 * motebit_id, did:key, public key fingerprint, device_id, and config
 * path that are already known from the persisted CLI config. Sync.
 */

import { hexPublicKeyToDidKey } from "@motebit/crypto";
import { CONFIG_DIR, loadFullConfig } from "../config.js";

export function handleId(): void {
  const config = loadFullConfig();

  if (!config.motebit_id) {
    console.error("No identity found. Run `npm create motebit` or `motebit run` to create one.");
    process.exit(1);
  }

  console.log();
  console.log(`  motebit_id   ${config.motebit_id}`);

  if (config.device_public_key) {
    try {
      console.log(`  did          ${hexPublicKeyToDidKey(config.device_public_key)}`);
    } catch {
      // Non-fatal — key may be invalid
    }
    console.log(`  public_key   ${config.device_public_key.slice(0, 16)}...`);
  }

  if (config.device_id) {
    console.log(`  device_id    ${config.device_id}`);
  }

  console.log(`  config       ${CONFIG_DIR}/config.json`);
  console.log();
}
