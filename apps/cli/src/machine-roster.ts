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
import { bytesToHex, getPublicKeyBySuite } from "@motebit/encryption";
import {
  MachineRoster,
  boundIdentityFile,
  createRosterSigner,
  type EnsureEnrolledOutcome,
  type PresentReport,
  type MachineRosterPorts,
  type RosterRemedy,
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
 * Every succession record, and the guardian, from every identity file of
 * THIS motebit this machine can find (C1.4, C1.5): the named files,
 * `motebit.md` in the working directory and its parents,
 * `~/.motebit/identity.md`, and the config's `_identity_file` (restore's,
 * and desktop's).
 *
 * A file contributes only when it is BOUND (#800; surface-kit's
 * `boundIdentityFile`): it verifies, names this motebit, AND its current
 * key is the key this CLI holds. A self-signed file proves possession of
 * ITS key, never that it speaks for the identity — so a file planted in a
 * parent directory, or left by another identity, contributes no record and
 * no guardian. The guardian is pinned only from a bound file: that file was
 * signed by the very key in hand, so its guardian is this key's own
 * declaration, never a third party's (machine-roster-surfaces-v1.md, #800).
 */
async function localIdentityEvidence(
  ctx: CliRosterContext,
  dir: string,
  heldPublicKeyHex: string,
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
    const bound = await boundIdentityFile(ctx.motebitId, content, heldPublicKeyHex);
    if (bound == null) continue;
    records.push(...bound.records);
    if (guardian == null) guardian = bound.guardian;
  }
  return { records, guardian };
}

/** The public key of the key in hand now, or null. */
async function heldPublicKeyHex(ctx: CliRosterContext): Promise<string | null> {
  const key = ctx.privateKey();
  if (key == null) return null;
  try {
    return bytesToHex(await getPublicKeyBySuite(key, "motebit-jcs-ed25519-hex-v1"));
  } catch {
    return null;
  }
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
  // Memoised per held key: the key is resolved on every call (R7), and
  // evidence bound to one key is never reused under another.
  type Evidence = { records: KeySuccessionRecord[]; guardian: string | null };
  const evidence = new Map<string, Promise<Evidence>>();
  const local = async (): Promise<Evidence> => {
    const held = await heldPublicKeyHex(ctx);
    if (held == null) return { records: [], guardian: null };
    let e = evidence.get(held);
    if (e == null) {
      e = localIdentityEvidence(ctx, dir, held);
      evidence.set(held, e);
    }
    return e;
  };
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
        const body = await readJson(resp);
        // Not the succession shape (unparseable, `null`, a list, no `chain`
        // list): a failed read, never an empty chain — the same strictness
        // `parseServedRoster` holds the roster body to.
        if (
          typeof body !== "object" ||
          body === null ||
          Array.isArray(body) ||
          !Array.isArray((body as { chain?: unknown }).chain)
        ) {
          return { ok: false, reason: "the succession route's answer was not a key chain" };
        }
        return { ok: true, body };
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
      return "a rotation is in flight — `motebit rotate` finishes it";
    case "restart":
      return "the local config holds this key's successor — restart this process";
    case "restore":
      return "this device's key was rotated away — `motebit restore` with the current motebit.md or a key transfer";
    case "rotate":
      return "`motebit rotate`";
    case "report":
      return "a malformed roster call — report it";
  }
}

/**
 * The one line a host start says about its roster line — or nothing, when
 * nothing needs saying (calm: an active line re-presented is not news).
 */
export function describeEnsureOutcome(
  out: EnsureEnrolledOutcome,
  deviceId: string,
  context: "start" | "rotate" = "start",
): string | null {
  const when = context === "rotate" ? "after the rotation" : "this start";
  const enroll = `\`motebit machines enroll ${deviceId}\``;
  // Only what may yet be taken is "presented again" (#802).
  const notTaken = (p: PresentReport): string => {
    const parts: string[] = [];
    if (p.rosterFull.length > 0) {
      parts.push(`relay roster full: ${p.rosterFull.length} not taken, not retried`);
    }
    if (p.willNotHold.length > 0) {
      const why = [...new Set(p.willNotHold.map((w) => w.reason))].join(", ");
      parts.push(`the relay will not hold ${p.willNotHold.length}: ${why}; not presented again`);
    }
    if (p.notTaken.length > 0) {
      parts.push(`${p.notTaken.length} not taken by the relay; presented again`);
    }
    return parts.length > 0 ? ` (${parts.join("; ")})` : "";
  };
  switch (out.kind) {
    case "no-key":
      return null;
    case "active": {
      if (out.confirmed === false) {
        return `Machine roster: not updated ${when} — the relay could not be read; this device's copy shows this machine active`;
      }
      const n = notTaken(out.presented);
      return n === "" ? null : `Machine roster: this machine's line is active${n}`;
    }
    case "minted":
      return `Machine roster: enrolled this machine (${out.enrollmentId.slice(0, 12)}…)${notTaken(out.presented)}`;
    case "retired":
      if (out.confirmed === false) {
        return `Machine roster: not updated ${when} — the relay could not be read; this device's copy shows this machine retired — ${enroll} to rejoin`;
      }
      return context === "rotate"
        ? `Machine roster: this machine is retired; not enrolled under the new key — ${enroll} to rejoin`
        : `Machine roster: this machine is retired — ${enroll} to rejoin; \`motebit rotate\` if you did not retire it`;
    case "superseded":
      if (out.confirmed === false) {
        return `Machine roster: not updated ${when} — the relay could not be read; this device's copy shows this machine's line on a superseded key — ${enroll}`;
      }
      return `Machine roster: this machine's line is on a superseded key; not covered — ${enroll}`;
    case "unplaced":
      return `Machine roster: this machine's entries are under keys this device cannot place, or unverified; not updated ${when} — ${enroll} if it should host`;
    case "unknown":
      return `Machine roster: not updated ${when} — ${out.detail}`;
    case "entry-too-large":
      return `Machine roster: not enrolled ${when} — this machine's entry would be ${out.bytes} bytes, and a relay holds at most ${out.limit}; nothing was kept`;
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
    const line = describeEnsureOutcome(out, ctx.deviceId);
    if (line != null) log(line);
    return out;
  } catch (err) {
    log(
      `Machine roster: not updated this start (${err instanceof Error ? err.message : String(err)}); the daemon runs regardless`,
    );
    return null;
  }
}
