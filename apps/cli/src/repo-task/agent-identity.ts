/**
 * The agent identity A of a governed repo change (docs/proposals/governed-repo-change-v1.md,
 * "Roles"): a separate motebit identity in its own config directory, given
 * explicitly as `motebit repo-task run --agent <dir>` (the layout of a
 * `MOTEBIT_CONFIG_DIR`).
 *
 * Only identity and key material are read from `<dir>/config.json` —
 * `motebit_id`, `device_id`, `device_public_key`, `cli_encrypted_key` — never
 * a personality, governance, MCP, provider or any other field: nothing of
 * the host's interior reaches the run. The directory may not be this
 * machine's default config directory (`~/.motebit`, or `MOTEBIT_CONFIG_DIR`):
 * that is the principal's or the operator's identity, never A's, and the run
 * never reads `~/.motebit/config.json`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { FullConfig } from "../config.js";
import { isSameEntry } from "./fs-identity.js";

/** The identity and key material of A, and nothing else. */
export interface AgentIdentity {
  readonly configFile: string;
  readonly motebitId: string;
  readonly deviceId: string;
  /** As written in the config; its one spelling is judged by the caller. */
  readonly publicKeyHex: string;
  readonly encryptedKey: NonNullable<FullConfig["cli_encrypted_key"]>;
}

const MAX_CONFIG_BYTES = 1024 * 1024;

/** `p`'s real path when it exists, else its absolute spelling. */
function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * The directories `--agent` may never name: the default `~/.motebit` and the
 * process's `CONFIG_DIR` (`MOTEBIT_CONFIG_DIR`, when set).
 */
export function defaultConfigDirs(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string[] {
  const dirs = [path.join(home, ".motebit")];
  const override = env["MOTEBIT_CONFIG_DIR"];
  if (override != null && override !== "") dirs.push(override);
  return dirs.map(realOrResolved);
}

/**
 * `dir` is one of the default config directories, or its `config.json` is
 * theirs: judged by filesystem identity (fs-identity.ts), so a case alias or a
 * hard-linked config is caught; the spelling compare stays for paths that do
 * not exist yet.
 */
export function isDefaultConfigDir(dir: string, defaults: readonly string[]): boolean {
  if (defaults.includes(realOrResolved(dir))) return true;
  return defaults.some(
    (d) =>
      isSameEntry(dir, d) ||
      isSameEntry(path.join(dir, "config.json"), path.join(d, "config.json")),
  );
}

function isHexString(v: unknown): v is string {
  return typeof v === "string" && /^[0-9a-fA-F]*$/.test(v) && v.length > 0;
}

/**
 * Read A's identity from `<dir>/config.json`, picking only the identity and
 * key fields. Throws with the reason when the file is absent, not JSON, or
 * lacks an encrypted key (a plaintext legacy key is refused for A).
 */
export function readAgentIdentity(dir: string): AgentIdentity {
  const configFile = path.join(path.resolve(dir), "config.json");
  let st: fs.Stats;
  try {
    st = fs.lstatSync(configFile);
  } catch {
    throw new Error(`--agent: ${configFile} does not exist`);
  }
  if (!st.isFile() || st.size > MAX_CONFIG_BYTES) {
    throw new Error(`--agent: ${configFile} is not a regular file`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configFile, "utf8")) as unknown;
  } catch (err) {
    throw new Error(
      `--agent: ${configFile} is not JSON (${err instanceof Error ? err.message : String(err)})`,
      { cause: err },
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`--agent: ${configFile} is not a JSON object`);
  }
  const c = raw as Record<string, unknown>;
  const motebitId = c["motebit_id"];
  const deviceId = c["device_id"];
  const publicKeyHex = c["device_public_key"];
  const enc = c["cli_encrypted_key"];
  if (typeof motebitId !== "string" || motebitId === "") {
    throw new Error(`--agent: ${configFile} has no motebit_id`);
  }
  if (typeof deviceId !== "string" || deviceId === "") {
    throw new Error(`--agent: ${configFile} has no device_id`);
  }
  if (typeof publicKeyHex !== "string" || publicKeyHex === "") {
    throw new Error(`--agent: ${configFile} has no device_public_key`);
  }
  if (enc === null || typeof enc !== "object" || Array.isArray(enc)) {
    throw new Error(
      `--agent: ${configFile} has no cli_encrypted_key (the agent's key must be passphrase-encrypted)`,
    );
  }
  const e = enc as Record<string, unknown>;
  if (![e["ciphertext"], e["nonce"], e["tag"], e["salt"]].every(isHexString)) {
    throw new Error(`--agent: ${configFile} has a malformed cli_encrypted_key`);
  }
  return {
    configFile,
    motebitId,
    deviceId,
    publicKeyHex,
    encryptedKey: {
      ciphertext: e["ciphertext"] as string,
      nonce: e["nonce"] as string,
      tag: e["tag"] as string,
      salt: e["salt"] as string,
    },
  };
}

/**
 * The only shape `loadActiveSigningKey` is handed for A: the identity and key
 * fields, nothing else, so no other field of any config can reach it.
 */
export function agentKeyConfig(agent: AgentIdentity): FullConfig {
  return {
    motebit_id: agent.motebitId,
    device_id: agent.deviceId,
    device_public_key: agent.publicKeyHex,
    cli_encrypted_key: agent.encryptedKey,
  };
}
