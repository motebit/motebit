/**
 * The machine roster's two rotation doors on the CLI — R21 option (a) of
 * `docs/proposals/machine-roster-clients-v1.md` §2A: the capture BEFORE the
 * rotation is sent (under the old key), and the hook AFTER the local commit
 * (under the new key), which reads only that capture. `motebit rotate` calls
 * both around `performRotation`; the ports are `machine-roster.ts`'s.
 */
import * as fs from "node:fs";
import { hexToBytes, secureErase } from "@motebit/encryption";
import { verify as verifyIdentityFile } from "@motebit/identity-file";
import {
  MachineRoster,
  createRosterSigner,
  identityFileRecords,
  type RotationHookOutcome,
} from "@motebit/surface-kit";
import type { KeySuccessionRecord } from "@motebit/sdk";
import { CONFIG_DIR, loadFullConfig, type FullConfig } from "./config.js";
import { cliRosterPorts, describeEnsureOutcome, type CliRosterContext } from "./machine-roster.js";
import { loadAnyPendingRotation } from "./pending-rotation.js";
import { presentationLines } from "./subcommands/machines.js";

/**
 * The rotation hook (R21 option (a), second half), run by `motebit rotate`
 * once the rotation is COMMITTED locally — including the kit's resume
 * outcomes (`interrupted-commit-finished`, `already-held`), which all end
 * `rotated`. Under the NEW key: append the link to the replica, and enrol
 * under the new key only if the capture taken BEFORE the rotation was sent
 * says this machine was active through a line it minted itself.
 */
export async function rosterAfterRotation(
  ctx: Omit<CliRosterContext, "privateKey">,
  opts: { newPrivateKey: Uint8Array; record: KeySuccessionRecord },
): Promise<RotationHookOutcome> {
  const ports = cliRosterPorts({ ...ctx, privateKey: () => opts.newPrivateKey });
  const signer = await ports.signer();
  if (signer == null) return { kind: "no-verdict", detail: "no key" };
  if (signer.publicKeyHex !== opts.record.new_public_key) {
    return { kind: "no-verdict", detail: "the committed key is not the rotation's new key" };
  }
  return new MachineRoster(ports).afterRotation({ signer, record: opts.record });
}

/**
 * `motebit rotate`'s call into the hook: find the committed link in the
 * re-signed identity file, open the committed key, run the hook, and say
 * at most one line. Never throws — a rotation that committed is complete
 * whatever the roster step does.
 */
export async function rosterHookAfterRotate(opts: {
  identityPath: string;
  passphrase: string;
  syncUrl: string;
  newPublicKeyHex: string;
  decryptPrivateKey: (
    encrypted: NonNullable<FullConfig["cli_encrypted_key"]>,
    passphrase: string,
  ) => Promise<string>;
  loadConfig?: () => FullConfig;
  dir?: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  let key: Uint8Array | null = null;
  try {
    const config = (opts.loadConfig ?? loadFullConfig)();
    if (!config.motebit_id || !config.device_id || !config.cli_encrypted_key) return null;
    // Only a file bound to the committed key (#800): it verifies, names this
    // motebit, and its current key IS the rotation's new key.
    const chain = await identityFileRecords(
      config.motebit_id,
      fs.readFileSync(opts.identityPath, "utf-8"),
      opts.newPublicKeyHex,
      verifyIdentityFile,
    );
    const record = chain.find((r) => r.new_public_key === opts.newPublicKeyHex);
    if (record == null) return null;
    key = hexToBytes(await opts.decryptPrivateKey(config.cli_encrypted_key, opts.passphrase));
    const out = await rosterAfterRotation(
      {
        motebitId: config.motebit_id,
        deviceId: config.device_id,
        syncUrl: opts.syncUrl,
        identityPaths: [opts.identityPath],
        ...(opts.dir !== undefined ? { dir: opts.dir } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.loadConfig ? { loadConfig: opts.loadConfig } : {}),
      },
      { newPrivateKey: key, record },
    );
    if (out.kind !== "frozen") return null;
    if (out.decided == null) {
      // (c) An active capture that could not be carried: say so, and how.
      if (out.captured !== "active" || out.notCarried == null) return null;
      const why =
        out.notCarried === "read-incomplete"
          ? "the read after the rotation was incomplete"
          : out.notCarried === "prior-frozen"
            ? "an earlier run already recorded it as not active"
            : "the key chain read does not end at this rotation";
      return `  Machine roster: active before the rotation; not enrolled under the new key (${why}) — \`motebit machines enroll ${config.device_id}\``;
    }
    if (out.decided.kind === "minted") {
      return [
        "  Machine roster: enrolled under the new key",
        ...presentationLines(out.decided.presented, [out.decided.enrollmentId], "enrolment"),
      ].join("\n");
    }
    if (out.decided.kind === "active") return null;
    const line = describeEnsureOutcome(out.decided, config.device_id, "rotate");
    return line == null ? null : `  ${line}`;
  } catch (err) {
    return `  Machine roster: not updated after the rotation (${err instanceof Error ? err.message : String(err)})`;
  } finally {
    if (key) secureErase(key);
  }
}

/**
 * R21 option (a): `motebit rotate`'s call BEFORE the rotation is sent.
 * Under the OLD key, capture this machine's roster status into the
 * replica; the hook later reads only that. Skipped while a RESUMABLE
 * rotation write-ahead exists (one for this identity naming the key this
 * machine holds, on either side — the kit resumes or finishes exactly
 * those): that rotation's link may already be at the relay, so the resume
 * uses the capture its original attempt took, or none (absent: no
 * automatic mint). A STALE write-ahead (another identity, or naming neither
 * key) is set aside by the kit and a fresh rotation starts, so a fresh
 * capture is taken. An unreadable one stops the rotation, so nothing is
 * captured. Its two relay reads run in parallel. Never throws.
 */
export async function rosterCaptureBeforeRotate(opts: {
  passphrase: string;
  syncUrl: string;
  identityPath: string;
  decryptPrivateKey: (
    encrypted: NonNullable<FullConfig["cli_encrypted_key"]>,
    passphrase: string,
  ) => Promise<string>;
  loadConfig?: () => FullConfig;
  dir?: string;
  fetchImpl?: typeof fetch;
}): Promise<"captured" | "kept" | "skipped"> {
  const dir = opts.dir ?? CONFIG_DIR;
  const inFlight = loadAnyPendingRotation(dir);
  if (inFlight === "unreadable") return "kept";
  let key: Uint8Array | null = null;
  try {
    const config = (opts.loadConfig ?? loadFullConfig)();
    if (!config.motebit_id || !config.device_id || !config.cli_encrypted_key) return "skipped";
    key = hexToBytes(await opts.decryptPrivateKey(config.cli_encrypted_key, opts.passphrase));
    const held = key;
    const heldKey = (
      await createRosterSigner({ privateKey: held, authorization: () => Promise.resolve({}) })
    ).publicKeyHex;
    if (
      inFlight != null &&
      inFlight.motebit_id === config.motebit_id &&
      (inFlight.old_public_key === heldKey || inFlight.new_public_key === heldKey)
    ) {
      return "kept";
    }
    await new MachineRoster(
      cliRosterPorts({
        motebitId: config.motebit_id,
        deviceId: config.device_id,
        syncUrl: opts.syncUrl,
        privateKey: () => held,
        identityPaths: [opts.identityPath],
        dir,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
        ...(opts.loadConfig ? { loadConfig: opts.loadConfig } : {}),
      }),
    ).captureBeforeRotation();
    return "captured";
  } catch {
    // No capture is `absent` at the hook: no automatic mint, never a wrong one.
    return "skipped";
  } finally {
    if (key) secureErase(key);
  }
}
