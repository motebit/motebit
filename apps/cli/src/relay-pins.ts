/**
 * The per-relay record of relay keys, and the one resolver the money path
 * reads it through.
 *
 * `config.json` holds a single `relay_public_key` with no relay beside it,
 * so a session on relay B could use relay A's key: a paid peer-to-peer
 * delegation then derives the fee destination from A's key, the client
 * broadcasts, and B rejects the task — the owner has paid for nothing.
 *
 * This module keeps one key PER RELAY URL in `relay-pins.json`, and the
 * three money-path readers (REPL startup, `delegate --sovereign`, the grant
 * pre-flight) use only `resolveRelayKey`: one answer per process and relay,
 * never the legacy field.
 *
 * An entry is written one way only (`bindRelayPin`): the relay proved a key
 * for that URL (its signed metadata names the URL, and its signed
 * transparency declaration names the same key and relay id), AND that key is
 * the legacy key this install already held. An entry is only ever added,
 * never replaced: `addRelayPin` is the only writer and the only guard.
 *
 * `register`'s legacy pin (`relay_public_key`), its PIN MISMATCH rule,
 * `verify-release` and `create-motebit rotate` are untouched and still read
 * the legacy field.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  relayPinKey,
  verifyRelayMetadataForUrl,
  type RelayMetadataForUrlFailure,
} from "@motebit/runtime";
import { verifyTransparencyDeclaration } from "@motebit/state-export-client";
import { sanitizeRelayText } from "@motebit/sync-engine";
import { CONFIG_DIR, loadFullConfig } from "./config.js";
import { isTrulyAbsent, mkdirOwnerOnly, withFileLock, writeFileAtomic } from "./durable-file.js";
import { normalizeRelayUrl } from "./sync-opt-in.js";

// ── The file ────────────────────────────────────────────────────────────────

/** One relay's recorded key. */
export interface RelayPinEntry {
  /** 64 hex characters, lowercase. */
  public_key: string;
  relay_id: string;
  /** When this install recorded it (ms since the epoch). */
  pinned_at: number;
}

/** The per-relay record's path: `relay-pins.json` in the config directory. */
export function relayPinsPath(): string {
  return path.join(CONFIG_DIR, "relay-pins.json");
}

/**
 * What reading the record produced. A damaged file is "pins unknown", never
 * "no pins": no reader gets a key from it and nothing writes it.
 */
export type RelayPinsRead =
  | { status: "ok"; pins: Record<string, RelayPinEntry> }
  | {
      status: "damaged";
      /** `newer_version`: written by a newer CLI. `damaged`: anything else. */
      damage: "newer_version" | "damaged";
      cause: string;
    };

const damaged = (cause: string): RelayPinsRead => ({ status: "damaged", damage: "damaged", cause });

/** Read the per-relay record. An absent file is an empty record. Never throws. */
export function readRelayPins(file: string = relayPinsPath()): RelayPinsRead {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && isTrulyAbsent(file)) return { status: "ok", pins: {} };
    return damaged(`it cannot be read: ${code ?? "error"}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return damaged("it is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return damaged("it is not a JSON object");
  }
  const doc = parsed as Record<string, unknown>;
  if (!("version" in doc)) return damaged("it has no version");
  if (doc["version"] !== 1) {
    const version = doc["version"];
    if (typeof version === "number" && Number.isInteger(version) && version > 1) {
      return {
        status: "damaged",
        damage: "newer_version",
        cause: `it is version ${version}, and this motebit reads version 1`,
      };
    }
    return damaged("its version is not one this motebit knows");
  }
  const pins = doc["pins"];
  if (typeof pins !== "object" || pins === null || Array.isArray(pins)) {
    return damaged("its `pins` is not an object");
  }
  const out: Record<string, RelayPinEntry> = {};
  for (const [key, value] of Object.entries(pins as Record<string, unknown>)) {
    const entry = value as Partial<RelayPinEntry> | null;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.public_key !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.public_key) ||
      typeof entry.relay_id !== "string" ||
      typeof entry.pinned_at !== "number"
    ) {
      return damaged("an entry has the wrong shape");
    }
    out[key] = {
      public_key: entry.public_key,
      relay_id: entry.relay_id,
      pinned_at: entry.pinned_at,
    };
  }
  return { status: "ok", pins: out };
}

/** What `addRelayPin` did. */
export type AddRelayPinResult =
  | { result: "added" }
  | { result: "already_present" }
  | { result: "conflict" }
  | { result: "unavailable"; cause: string };

/**
 * Record `entry` for `pinKey` — the ONLY writer of the per-relay record, and
 * the only guard against replacing an entry. It never overwrites.
 *
 * It reads the file exactly once, INSIDE the lock: no entry → writes and
 * returns `added`; an entry with the same key → `already_present`, nothing
 * written; an entry with a different key → `conflict`, nothing written. When
 * the lock cannot be taken (five seconds unless `lockTimeoutMs` says
 * otherwise), the file cannot be read or written, or the file is damaged, it
 * returns `unavailable` with the cause and writes nothing. It does not throw.
 *
 * Callers do their network work BEFORE calling it.
 */
export function addRelayPin(
  pinKey: string,
  entry: RelayPinEntry,
  opts: { lockTimeoutMs?: number; file?: string } = {},
): AddRelayPinResult {
  const file = opts.file ?? relayPinsPath();
  try {
    mkdirOwnerOnly(path.dirname(file));
    return withFileLock(
      file,
      (): AddRelayPinResult => {
        const read = readRelayPins(file);
        if (read.status === "damaged") return { result: "unavailable", cause: read.cause };
        const existing = Object.hasOwn(read.pins, pinKey) ? read.pins[pinKey] : undefined;
        if (existing != null && existing.public_key === entry.public_key) {
          return { result: "already_present" };
        }
        if (existing != null) return { result: "conflict" };
        const next = { version: 1, pins: { ...read.pins, [pinKey]: entry } };
        writeFileAtomic(file, `${JSON.stringify(next, null, 2)}\n`, 0o600);
        return { result: "added" };
      },
      { timeoutMs: opts.lockTimeoutMs ?? 5_000 },
    );
  } catch (err) {
    return { result: "unavailable", cause: err instanceof Error ? err.message : String(err) };
  }
}

// ── When a key is established for a URL ─────────────────────────────────────

/** Injected seams: tests drive the real store and real requests with short timeouts. */
export interface RelayKeyDeps {
  /** Fetch implementation — defaults to the global `fetch` at call time. */
  fetchImpl?: typeof fetch;
  /** Timeout of each of the two document requests (ms). Default 5000. */
  timeoutMs?: number;
  /** How long to wait for the record's lock (ms). Default 5000. */
  lockTimeoutMs?: number;
}

/** Why the full check established no key. */
export type RelayCheckFailureReason =
  | RelayMetadataForUrlFailure["reason"]
  | "declaration_unavailable"
  | "declaration_invalid"
  | "declaration_key_mismatch"
  | "declaration_relay_id_mismatch";

/** The outcome of the full check. */
export type RelayFullCheck =
  | { ok: true; pinKey: string; publicKey: string; relayId: string }
  | {
      ok: false;
      reason: RelayCheckFailureReason;
      /** `endpoint_mismatch` only: the pin key of the URL the relay signed, or null. */
      signedPinKey?: string | null;
    };

const TRANSPARENCY_PATH = "/.well-known/motebit-transparency.json";
const METADATA_PATH = "/.well-known/motebit.json";

/**
 * The full check: the relay's signed metadata must name this URL
 * (`verifyRelayMetadataForUrl`), and then — only when that established a key
 * — its signed transparency declaration at the same URL must verify and name
 * the same key and the same relay id. Same timeout; redirects not followed.
 * When the metadata step fails, the declaration is not requested.
 */
export async function fullRelayCheck(
  url: string,
  deps: RelayKeyDeps = {},
): Promise<RelayFullCheck> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 5_000;
  // No step below may throw out of this function: `bindRelayPin` has exactly
  // six results and never a throw. Each step turns its OWN failure into its
  // own reason — a relay's fault is never reported as the record's.
  let metadata: Awaited<ReturnType<typeof verifyRelayMetadataForUrl>>;
  try {
    metadata = await verifyRelayMetadataForUrl(url, { fetchImpl, timeoutMs });
  } catch {
    // It is written never to throw; a transport that hands back something
    // that is not a response is the one way it could.
    return { ok: false, reason: "metadata_unavailable" };
  }
  if (!metadata.ok) {
    return metadata.reason === "endpoint_mismatch"
      ? { ok: false, reason: metadata.reason, signedPinKey: metadata.signedPinKey }
      : { ok: false, reason: metadata.reason };
  }
  const pinKey = relayPinKey(url);
  if (pinKey == null) return { ok: false, reason: "unpinnable_url" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let declaration: Parameters<typeof verifyTransparencyDeclaration>[0];
  try {
    let resp: Response;
    try {
      resp = await fetchImpl(`${pinKey}${TRANSPARENCY_PATH}`, {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      return { ok: false, reason: "unreachable" };
    }
    if (resp.type === "opaqueredirect" || (resp.status >= 300 && resp.status < 400)) {
      return { ok: false, reason: "redirect_refused" };
    }
    if (!resp.ok) return { ok: false, reason: "declaration_unavailable" };
    let body: unknown;
    try {
      body = await resp.json();
    } catch {
      return {
        ok: false,
        reason: controller.signal.aborted ? "unreachable" : "declaration_unavailable",
      };
    }
    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return { ok: false, reason: "declaration_unavailable" };
    }
    declaration = body as Parameters<typeof verifyTransparencyDeclaration>[0];
  } catch {
    // Reading the answer itself failed (a transport that handed back
    // something that is not a response): answered, but not a declaration.
    return { ok: false, reason: "declaration_unavailable" };
  } finally {
    clearTimeout(timer);
  }

  // Its own verification, as `register` does it today. The verifier
  // canonicalises the document, and a document the relay nests deeply enough
  // overflows the stack there: a declaration that cannot be verified is an
  // invalid declaration, whatever the way it failed.
  let verdict: Awaited<ReturnType<typeof verifyTransparencyDeclaration>>;
  try {
    verdict = await verifyTransparencyDeclaration(declaration);
  } catch {
    return { ok: false, reason: "declaration_invalid" }; // verification threw
  }
  if (!verdict.ok) {
    return {
      ok: false,
      reason:
        verdict.reason === "malformed_declaration"
          ? "declaration_unavailable"
          : "declaration_invalid",
    };
  }
  // A verified declaration's `relay_public_key` and `relay_id` are strings
  // (the verifier's structural check), so neither comparison can throw.
  if (declaration.relay_public_key.toLowerCase() !== metadata.publicKey) {
    return { ok: false, reason: "declaration_key_mismatch" };
  }
  if (declaration.relay_id !== metadata.relayId) {
    return { ok: false, reason: "declaration_relay_id_mismatch" };
  }
  return { ok: true, pinKey, publicKey: metadata.publicKey, relayId: metadata.relayId };
}

/** The legacy key `config.json` holds right now (lowercase), or undefined. */
function readLegacyRelayKey(): string | undefined {
  try {
    const key = loadFullConfig().relay_public_key;
    return key != null && key !== "" ? key.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

// ── Binding on proof ────────────────────────────────────────────────────────

/** What `bindRelayPin` did. */
export type BindRelayPinResult =
  | { result: "no_key"; reason: RelayCheckFailureReason; signedPinKey?: string | null }
  | { result: "legacy_mismatch" }
  | { result: "added"; publicKey: string }
  | { result: "already_present"; publicKey: string }
  | { result: "conflict"; pinKey: string }
  | { result: "unavailable"; cause: string };

/**
 * The one way an entry is written. Fixed order:
 *
 *  1. the full check; no key established → `no_key`, with the reason;
 *  2. read the legacy key from `config.json` at that moment; absent, or
 *     different from the proved key → `legacy_mismatch` (nothing written);
 *  3. `addRelayPin`, and its result: `added`, `already_present`, `conflict`
 *     or `unavailable`.
 *
 * So an entry always records a key that both the relay proved for that URL
 * and this install already held. It does not look at existing entries
 * itself; only the store does.
 *
 * Exactly these six results, never a throw: the full check turns every
 * failure of its own steps into a reason, the legacy read treats an
 * unreadable `config.json` as "no legacy key", and the store returns
 * `unavailable` instead of throwing.
 */
export async function bindRelayPin(
  url: string,
  deps: RelayKeyDeps = {},
): Promise<BindRelayPinResult> {
  const check = await fullRelayCheck(url, deps);
  if (!check.ok) {
    return check.signedPinKey !== undefined
      ? { result: "no_key", reason: check.reason, signedPinKey: check.signedPinKey }
      : { result: "no_key", reason: check.reason };
  }
  const legacy = readLegacyRelayKey();
  if (legacy == null || legacy !== check.publicKey) return { result: "legacy_mismatch" };
  const added = addRelayPin(
    check.pinKey,
    { public_key: check.publicKey, relay_id: check.relayId, pinned_at: Date.now() },
    deps.lockTimeoutMs !== undefined ? { lockTimeoutMs: deps.lockTimeoutMs } : {},
  );
  if (added.result === "added" || added.result === "already_present") {
    return { result: added.result, publicKey: check.publicKey };
  }
  if (added.result === "conflict") return { result: "conflict", pinKey: check.pinKey };
  return added;
}

// ── One answer per process ──────────────────────────────────────────────────

/** Which key this process uses for a relay, or the reason it uses none. */
export type RelayKeyResolution =
  | {
      status: "key";
      relayUrl: string;
      key: string;
      /** `recorded`: the entry was already on disk (no request was made). */
      origin: "recorded" | "added" | "already_present";
    }
  | { status: "no_key"; relayUrl: string; reason: "not_pinned" | "legacy_mismatch" }
  | {
      status: "no_key";
      relayUrl: string;
      reason: "damaged";
      file: string;
      damage: "newer_version" | "damaged";
      cause: string;
    }
  | {
      status: "no_key";
      relayUrl: string;
      reason: "no_key";
      check: RelayCheckFailureReason;
      signedPinKey?: string | null;
    }
  | { status: "no_key"; relayUrl: string; reason: "conflict"; file: string; pinKey: string }
  | { status: "no_key"; relayUrl: string; reason: "unavailable"; file: string; cause: string };

/** A resolution that carries no key. */
export type RelayKeyAbsent = Extract<RelayKeyResolution, { status: "no_key" }>;

/** What the session knows about its relay's key; `no_relay` when relay sync is off. */
export type SessionRelayKey = RelayKeyResolution | { status: "no_relay" };

const resolved = new Map<string, Promise<RelayKeyResolution>>();

/** Test-only: forget every answer, to model "the next start". */
export function resetRelayKeyMemoryForTests(): void {
  resolved.clear();
}

/**
 * Decide — ONCE per process and relay URL — which key this process uses for
 * `relayUrl`, or the reason it uses none, and remember the answer. It is the
 * only thing the three money-path readers consult; none re-asks the file
 * later in the same process.
 *
 *  1. the record is damaged → no key, `damaged` (no request);
 *  2. an entry exists for the relay → that key (no request);
 *  3. no entry and no legacy key → no key, `not_pinned` (no request);
 *  4. no entry and a legacy key → lazy binding (`bindRelayPin`), one attempt:
 *     `added` / `already_present` → the key; `no_key`, `legacy_mismatch`,
 *     `conflict`, `unavailable` → no key, with that reason.
 *
 * Never throws: no outcome stops the session.
 */
export function resolveRelayKey(
  relayUrl: string,
  deps: RelayKeyDeps = {},
): Promise<RelayKeyResolution> {
  const memoKey = relayPinKey(relayUrl) ?? relayUrl;
  const remembered = resolved.get(memoKey);
  if (remembered != null) return remembered;
  const answer = decideRelayKey(relayUrl, deps).catch((err: unknown): RelayKeyResolution => ({
    status: "no_key",
    relayUrl,
    reason: "unavailable",
    file: relayPinsPath(),
    cause: err instanceof Error ? err.message : String(err),
  }));
  resolved.set(memoKey, answer);
  return answer;
}

async function decideRelayKey(relayUrl: string, deps: RelayKeyDeps): Promise<RelayKeyResolution> {
  const file = relayPinsPath();
  const read = readRelayPins(file);
  if (read.status === "damaged") {
    return {
      status: "no_key",
      relayUrl,
      reason: "damaged",
      file,
      damage: read.damage,
      cause: read.cause,
    };
  }
  const pinKey = relayPinKey(relayUrl);
  const entry = pinKey != null && Object.hasOwn(read.pins, pinKey) ? read.pins[pinKey] : undefined;
  if (entry != null) return { status: "key", relayUrl, key: entry.public_key, origin: "recorded" };

  if (readLegacyRelayKey() == null) return { status: "no_key", relayUrl, reason: "not_pinned" };

  const bound = await bindRelayPin(relayUrl, deps);
  if (bound.result === "added" || bound.result === "already_present") {
    return { status: "key", relayUrl, key: bound.publicKey, origin: bound.result };
  }
  if (bound.result === "conflict") {
    return { status: "no_key", relayUrl, reason: "conflict", file, pinKey: bound.pinKey };
  }
  if (bound.result === "unavailable") {
    return { status: "no_key", relayUrl, reason: "unavailable", file, cause: bound.cause };
  }
  if (bound.result === "legacy_mismatch") {
    return { status: "no_key", relayUrl, reason: "legacy_mismatch" };
  }
  return bound.signedPinKey !== undefined
    ? {
        status: "no_key",
        relayUrl,
        reason: "no_key",
        check: bound.reason,
        signedPinKey: bound.signedPinKey,
      }
    : { status: "no_key", relayUrl, reason: "no_key", check: bound.reason };
}

// ── Messages ────────────────────────────────────────────────────────────────

/**
 * Where the relay URL of this process came from, for a message that tells
 * the owner what to change: the flag, the environment, or the saved config.
 * The same order as `namedRelayUrl`.
 */
export function relayUrlSource(
  config: { syncUrl?: string | undefined },
  fullConfig: { sync_url?: string | undefined },
): string {
  if (normalizeRelayUrl(config.syncUrl) != null) return "the `--sync-url` or `--sync` flag";
  if (normalizeRelayUrl(process.env["MOTEBIT_SYNC_URL"]) != null) return "`MOTEBIT_SYNC_URL`";
  if (normalizeRelayUrl(fullConfig.sync_url) != null) return "the saved config (`sync_url`)";
  return "your relay setting";
}

/** A relay-supplied or user-named address, safe to print. */
function shown(text: string): string {
  return sanitizeRelayText(text);
}

/**
 * The remedy for a full-check reason (printed by lazy binding and by
 * `register`'s warning).
 */
export function relayCheckRemedy(
  reason: RelayCheckFailureReason,
  ctx: { relayUrl: string; where: string; signedPinKey?: string | null },
): string {
  const relay = shown(ctx.relayUrl);
  switch (reason) {
    case "endpoint_mismatch": {
      if (ctx.signedPinKey == null) {
        return "This relay signs a value that is not a usable relay address; its operator must make it sign the URL you use.";
      }
      const signed = shown(ctx.signedPinKey);
      return (
        `This relay signs \`${signed}\`, not the URL you named (from ${ctx.where}). ` +
        `If that is this same relay, use that URL: \`motebit register --sync-url ${signed}\`, ` +
        `and change ${ctx.where} to it. Otherwise its operator must make it sign the URL you use.`
      );
    }
    case "endpoint_empty":
      return (
        "This relay does not sign its URL, so its key cannot be used for paid peer-to-peer. " +
        "Its operator makes it sign one: `motebit relay up --federation-url <url>`, or for the " +
        "relay service `MOTEBIT_FEDERATION_ENDPOINT_URL=<url>` (add " +
        "`MOTEBIT_FEDERATION_ENABLED=false` to keep federation off)."
      );
    case "redirect_refused":
      return "This relay answered with a redirect, which is not followed. If the target is its real address, name the relay by that URL.";
    case "metadata_unavailable":
      return `This relay answered but does not serve \`${METADATA_PATH}\`; its operator must serve it.`;
    case "declaration_unavailable":
      return `This relay answered but does not serve \`${TRANSPARENCY_PATH}\`; its operator must serve it.`;
    case "unreachable":
      return `Could not reach the relay; run \`motebit register --sync-url ${relay}\` when online.`;
    case "unpinnable_url":
      return "This relay URL cannot be used for a relay key: it must be an http(s) address without `?`, `#`, `@`, a backslash or spaces. Name the relay by a plain address.";
    default:
      return `This relay's key was not established (${reason}).`;
  }
}

/** The remedy for "the record could not be read or written" (lock, I/O). */
export function relayPinsUnavailableRemedy(ctx: {
  relayUrl: string;
  file: string;
  cause: string;
}): string {
  return (
    `The relay key record \`${ctx.file}\` could not be read or written (\`${shown(ctx.cause)}\`). ` +
    `Fix that, then run \`motebit register --sync-url ${shown(ctx.relayUrl)}\` again.`
  );
}

/** The remedy for a damaged record: upgrade (a newer version), else move it aside. */
export function relayPinsDamagedRemedy(ctx: {
  file: string;
  damage: "newer_version" | "damaged";
  cause: string;
}): string {
  return ctx.damage === "newer_version"
    ? `The relay key record \`${ctx.file}\` was written by a newer motebit (${ctx.cause}), so no relay key is used. Upgrade the CLI: \`npm install -g motebit@latest\`.`
    : `The relay key record \`${ctx.file}\` is damaged (${ctx.cause}), so no relay key is used. Move the file aside; the entry for the relay whose key this install holds is then re-established on the next start.`;
}

/** Why this process uses no key for its relay, and what to do about it. */
export function relayKeyRemedy(absent: RelayKeyAbsent, where: string): string {
  const relay = shown(absent.relayUrl);
  switch (absent.reason) {
    case "damaged":
      return relayPinsDamagedRemedy(absent);
    case "not_pinned":
      return `No relay key is pinned. Run \`motebit register --sync-url ${relay}\`.`;
    case "legacy_mismatch":
      return `This install's relay key was pinned for another relay or this relay's key changed. Run \`motebit register --sync-url ${relay}\`.`;
    case "conflict":
      return (
        `A different key is already recorded for this relay in \`${absent.file}\` ` +
        `(entry \`${shown(absent.pinKey)}\`), and it does not match the key the relay just proved. ` +
        `No relay key is used in this session. Verify the relay's key out of band, then remove that entry.`
      );
    case "unavailable":
      return relayPinsUnavailableRemedy(absent);
    case "no_key":
      return relayCheckRemedy(absent.check, {
        relayUrl: absent.relayUrl,
        where,
        ...(absent.signedPinKey !== undefined ? { signedPinKey: absent.signedPinKey } : {}),
      });
  }
}

/**
 * The one line REPL startup prints about its relay's key, or null when there
 * is nothing to say: an entry already on disk, or an install that never ran
 * `register` (exactly as before this record existed).
 */
export function relayKeyStartupLine(resolution: RelayKeyResolution, where: string): string | null {
  if (resolution.status === "key") {
    if (resolution.origin === "recorded") return null;
    return `Relay key ${resolution.key.slice(0, 12)}… recorded for ${shown(resolution.relayUrl)} (the relay proved the key this install already held).`;
  }
  if (resolution.reason === "not_pinned") return null;
  return `No relay key for ${shown(resolution.relayUrl)}: paid peer-to-peer is off this session. ${relayKeyRemedy(resolution, where)}`;
}
