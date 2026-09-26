/**
 * The machine roster on the CLI — ports for surface-kit's `MachineRoster`
 * (`docs/proposals/machine-roster-clients-v1.md` C2), the replica file, and
 * the three doors that use them: mint-on-announce (C3, N8), the rotation
 * hook (R21), and `motebit machines` (C4, C6; `subcommands/machines.ts`).
 *
 * The replica file is `machine-roster-file.ts`.
 *
 * Every roster request is authenticated by a DEVICE token minted with
 * `signedRelayHeaders` under the same key that signs the entries — never
 * `getRelayAuthHeaders`, which prefers the operator's master token that the
 * roster routes refuse (403).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { hexToBytes, secureErase } from "@motebit/encryption";
import { verify as verifyIdentityFile } from "@motebit/identity-file";
import {
  MachineRoster,
  createRosterSigner,
  type EnsureEnrolledOutcome,
  type MachineRosterPorts,
  type RosterRemedy,
  type RotationHookOutcome,
} from "@motebit/surface-kit";
import type { KeySuccessionRecord } from "@motebit/sdk";
import { CONFIG_DIR, loadFullConfig, type FullConfig } from "./config.js";
import { loadReplica, saveReplica, withMintLock } from "./machine-roster-file.js";
import { hasPendingRotation } from "./pending-rotation.js";
import { signedRelayHeaders } from "./relay-registration.js";

export interface CliRosterContext {
  motebitId: string;
  deviceId: string;
  syncUrl: string;
  /** The key in hand, resolved on EVERY call (R7); `null` = none. */
  privateKey: () => Uint8Array | null;
  /** Identity files named explicitly (`--identity`, the daemon's motebit.md). */
  identityPaths?: string[];
  dir?: string;
  fetchImpl?: typeof fetch;
  loadConfig?: () => FullConfig;
  cwd?: string;
}

/** motebit.md in `cwd` and every parent — the same search `motebit rotate` makes. */
function identityFileCandidates(ctx: CliRosterContext, dir: string): string[] {
  const out = [...(ctx.identityPaths ?? [])];
  let cur = ctx.cwd ?? process.cwd();
  for (;;) {
    out.push(path.join(cur, "motebit.md"));
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  out.push(path.join(dir, "identity.md"));
  return [...new Set(out.map((p) => path.resolve(p)))];
}

/**
 * Every succession record, and the guardian, from every signed identity
 * file of THIS motebit this machine can find (C1.4, C1.5): the named
 * files, `motebit.md` in the working directory and its parents,
 * `~/.motebit/identity.md`, and the config's `_identity_file` (restore's,
 * and desktop's). A file for another motebit, or one whose signature does
 * not verify, contributes nothing.
 */
async function localIdentityEvidence(
  ctx: CliRosterContext,
  dir: string,
): Promise<{ records: KeySuccessionRecord[]; guardian: string | null }> {
  const contents: string[] = [];
  for (const file of identityFileCandidates(ctx, dir)) {
    try {
      contents.push(fs.readFileSync(file, "utf-8"));
    } catch {
      // not there
    }
  }
  try {
    const embedded = (ctx.loadConfig ?? loadFullConfig)() as Record<string, unknown>;
    if (typeof embedded["_identity_file"] === "string") contents.push(embedded["_identity_file"]);
  } catch {
    // an unreadable config contributes nothing here
  }
  const records: KeySuccessionRecord[] = [];
  let guardian: string | null = null;
  for (const content of contents) {
    try {
      const v = await verifyIdentityFile(content, { expectedType: "identity" });
      if (v.type !== "identity" || !v.valid || !v.identity) continue;
      if (v.identity.motebit_id !== ctx.motebitId) continue;
      records.push(...((v.identity.succession ?? []) as KeySuccessionRecord[]));
      const g = v.identity.guardian?.public_key;
      if (guardian == null && typeof g === "string" && /^[0-9a-f]{64}$/.test(g)) guardian = g;
    } catch {
      // not an identity file
    }
  }
  return { records, guardian };
}

async function readJson(resp: Response): Promise<unknown> {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

export function cliRosterPorts(ctx: CliRosterContext): MachineRosterPorts {
  const dir = ctx.dir ?? CONFIG_DIR;
  const fetchImpl = ctx.fetchImpl ?? fetch;
  const base = ctx.syncUrl.replace(/\/+$/, "");
  const agent = `${base}/api/v1/agents/${encodeURIComponent(ctx.motebitId)}`;
  let evidence: Promise<{ records: KeySuccessionRecord[]; guardian: string | null }> | null = null;
  const local = () => (evidence ??= localIdentityEvidence(ctx, dir));
  return {
    motebitId: ctx.motebitId,
    deviceId: ctx.deviceId,
    signer: async () => {
      const key = ctx.privateKey();
      if (key == null) return null;
      return createRosterSigner({
        privateKey: key,
        // A device token under THIS key. Never the master token.
        authorization: () =>
          signedRelayHeaders(
            { motebitId: ctx.motebitId, deviceId: ctx.deviceId, privateKey: key },
            "device:auth",
          ),
      });
    },
    fetchSuccession: async () => {
      try {
        const resp = await fetchImpl(`${agent}/succession`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) return { ok: false, reason: `succession route answered ${resp.status}` };
        return { ok: true, body: await readJson(resp) };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    fetchRoster: async (signer) => {
      try {
        const resp = await fetchImpl(`${agent}/roster`, {
          headers: await signer.authorization(),
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) return { ok: false, reason: `roster route answered ${resp.status}` };
        return { ok: true, body: await readJson(resp) };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    presentRoster: async (signer, body) => {
      try {
        const resp = await fetchImpl(`${agent}/roster`, {
          method: "POST",
          headers: await signer.authorization(),
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
        return { status: resp.status, body: await readJson(resp) };
      } catch (err) {
        return { status: null, reason: err instanceof Error ? err.message : String(err) };
      }
    },
    localSuccession: async () => (await local()).records,
    pinnedGuardian: async () => (await local()).guardian,
    cache: {
      load: () => Promise.resolve(loadReplica(ctx.motebitId, dir)),
      save: (replica) => Promise.resolve(saveReplica(replica, dir)),
      exclusive: (fn) => withMintLock(fn, dir),
    },
    rotationInFlight: () => Promise.resolve(hasPendingRotation(dir)),
    storedPublicKeyHex: () => {
      try {
        return Promise.resolve((ctx.loadConfig ?? loadFullConfig)().device_public_key ?? null);
      } catch {
        return Promise.resolve(null);
      }
    },
  };
}

/** What a refusal's remedy asks the operator to do, in this CLI's commands. */
export function remedyText(remedy: RosterRemedy): string {
  switch (remedy) {
    case "finish-rotation":
      return "finish the rotation: `motebit rotate` resumes it";
    case "restart":
      return "this process holds a key the local config has rotated past; restart it";
    case "restore":
      return "this machine's key was rotated away; restore with the current key's seed or motebit.md (`motebit restore`) to rejoin";
    case "rotate":
      return "rotate to a fresh key (`motebit rotate`); the chain then resolves past it";
    case "report":
      return "this is a bug in the roster call — please report it";
  }
}

/**
 * The one line a host start says about its roster line — or nothing, when
 * nothing needs saying (calm: an active line re-presented is not news).
 */
export function describeEnsureOutcome(out: EnsureEnrolledOutcome): string | null {
  const notTaken = (p: { notTaken: unknown[]; rosterFull: string[] }): string =>
    p.rosterFull.length > 0
      ? ` (the relay's roster is full for ${p.rosterFull.length} entr${p.rosterFull.length === 1 ? "y" : "ies"}; not retried)`
      : p.notTaken.length > 0
        ? ` (${p.notTaken.length} not taken by the relay; presented again next start)`
        : "";
  switch (out.kind) {
    case "no-key":
      return null;
    case "active": {
      const n = notTaken(out.presented);
      return n === "" ? null : `Machine roster: this machine's line is active${n}`;
    }
    case "minted":
      return `Machine roster: enrolled this machine (${out.enrollmentId.slice(0, 12)}…)${notTaken(out.presented)}`;
    case "retired":
      return "Machine roster: this machine is retired from the roster but running — `motebit machines enroll <this device_id>` to rejoin, or rotate the key if the retirement was not yours";
    case "superseded":
      return "Machine roster: this machine's line is on a superseded key and not covered — `motebit machines enroll <this device_id>` to enrol it under the current key";
    case "unknown":
      return `Machine roster: not updated this start — ${out.detail}; the daemon runs regardless`;
    case "refused":
      return `Machine roster: no roster — ${remedyText(out.remedy)}`;
  }
}

/**
 * Mint-on-announce (C3, N8): every process that announces
 * `unattended_runtime` calls this after registering with its relay. It
 * never throws and never blocks the daemon — one calm line at most.
 */
export async function enrollOnAnnounce(
  ctx: CliRosterContext,
  log: (line: string) => void,
): Promise<EnsureEnrolledOutcome | null> {
  try {
    const out = await new MachineRoster(cliRosterPorts(ctx)).ensureEnrolled();
    const line = describeEnsureOutcome(out);
    if (line != null) log(line);
    return out;
  } catch (err) {
    log(
      `Machine roster: not updated this start (${err instanceof Error ? err.message : String(err)}); the daemon runs regardless`,
    );
    return null;
  }
}

/**
 * The rotation hook (R21 option b), run by `motebit rotate` once the
 * rotation is COMMITTED locally — including the kit's resume outcomes
 * (`interrupted-commit-finished`, `already-held`), which all end
 * `rotated`. Under the NEW key: append the link to the replica, freeze
 * this device's pre-rotation status, and enrol under the new key only if
 * that status was active.
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
    const onFile = await verifyIdentityFile(fs.readFileSync(opts.identityPath, "utf-8"), {
      expectedType: "identity",
    });
    const chain =
      onFile.type === "identity" && onFile.identity ? (onFile.identity.succession ?? []) : [];
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
    if (out.kind !== "frozen" || out.decided == null) return null;
    if (out.decided.kind === "minted") {
      return "  Machine roster: this machine was active, so it is enrolled under the new key";
    }
    if (out.decided.kind === "active") return null;
    const line = describeEnsureOutcome(out.decided);
    return line == null ? null : `  ${line}`;
  } catch (err) {
    return `  Machine roster: not updated after the rotation (${err instanceof Error ? err.message : String(err)})`;
  } finally {
    if (key) secureErase(key);
  }
}
