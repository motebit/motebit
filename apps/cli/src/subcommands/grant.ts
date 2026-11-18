/**
 * `motebit grant` — mint, inspect, and revoke standing-delegation grants
 * (money-execution Inc 4; spec/standing-delegation-v1.md @1.0–@1.2).
 *
 * The sovereign act this command performs: signing a `StandingDelegation`
 * whose `spend_ceiling` is the delegator's cryptographic commitment to
 * HOW MUCH may move autonomously (§3.3), plus the v1.0 PRE-MINTED tick
 * schedule — one future-dated, `not_before`-gated `DelegationToken` per
 * cadence slot, all signed now while the key is unlocked, so cadence is
 * a cryptographic property (the signed token set IS the schedule) and
 * the delegator stays the sole signer (§4).
 *
 * Storage: `~/.motebit/grants/<grant_id>.json` holding the verbatim
 * signed artifacts `{ grant, ticks, revocation? }`. Files, not the
 * synced DB, on purpose: a grant + its pre-minted ticks compose into
 * standing authority — they stay on the machine that minted them, out
 * of the sync surface, legible to the sovereign as plain JSON.
 *
 * Revocation (`grant revoke`) signs the terminal `DelegationRevocation`
 * (§5, D3: no unrevoke), stores it beside the grant, and best-effort
 * PROPAGATES it to the relay's delegation-revocation cache
 * (`POST /api/v1/delegations/revocations` — permissive by design; the
 * artifact is the auth, and revocations want to travel). Offline revoke
 * still bites locally: with no relay configured the presenter includes the
 * stored revocation in the held set and `verifyGrantForTurn` refuses; with a
 * relay configured and unreachable it presents no grant at all.
 *
 * Honest framing (trust-layer discipline): the ceiling is what the
 * runtime's meter ENFORCES on the trusted-runtime path — never displayed
 * as an offline guarantee. Money-grant lifetime defaults to 7 days
 * (§6 D4: offline worst-case exposure = short lifetime × signed ceiling).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  signStandingDelegation,
  signDelegation,
  signDelegationRevocation,
  secureErase,
  type StandingDelegation,
  type DelegationToken,
  type DelegationRevocation,
  type SpendCeilingV1,
} from "@motebit/encryption";
import { openMotebitDatabase } from "@motebit/persistence";
import { CONFIG_DIR, loadFullConfig } from "../config.js";
import { mkdirOwnerOnly } from "../durable-file.js";
import { getDbPath } from "../runtime-factory.js";
import { loadActiveSigningKey } from "../identity.js";
import type { CliConfig } from "../args.js";
import { namedRelayUrl, normalizeRelayUrl } from "../sync-opt-in.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const MICRO_PER_USD = 1_000_000;
/** Pre-mint bound — a runaway schedule is a signing bug, not a use case. */
const MAX_TICKS = 1000;

export const GRANTS_DIR_NAME = "grants";
const grantsDir = (): string => join(CONFIG_DIR, GRANTS_DIR_NAME);

/** The on-disk shape: verbatim signed artifacts, nothing derived. */
export interface StoredGrant {
  grant: StandingDelegation;
  ticks: DelegationToken[];
  revocation?: DelegationRevocation;
}

/** UUIDv7 (time-ordered) — the grant_id shape spec §3.1 names. Mirrors
 *  the private generator in @motebit/core-identity. */
function generateUUIDv7(): string {
  const ts = Date.now();
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[0] = (ts / 2 ** 40) & 0xff;
  bytes[1] = (ts / 2 ** 32) & 0xff;
  bytes[2] = (ts / 2 ** 24) & 0xff;
  bytes[3] = (ts / 2 ** 16) & 0xff;
  bytes[4] = (ts / 2 ** 8) & 0xff;
  bytes[5] = ts & 0xff;
  bytes[6] = 0x70 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function loadStoredGrant(grantId: string): StoredGrant | null {
  const path = join(grantsDir(), `${grantId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StoredGrant;
  } catch {
    return null;
  }
}

function saveStoredGrant(stored: StoredGrant): void {
  mkdirOwnerOnly(grantsDir()); // creates ~/.motebit 0700 on a first run
  writeFileSync(
    join(grantsDir(), `${stored.grant.grant_id}.json`),
    JSON.stringify(stored, null, 2),
  );
}

export function listStoredGrants(): StoredGrant[] {
  if (!existsSync(grantsDir())) return [];
  const out: StoredGrant[] = [];
  for (const file of readdirSync(grantsDir())) {
    if (!file.endsWith(".json")) continue;
    const stored = loadStoredGrant(file.slice(0, -".json".length));
    if (stored != null) out.push(stored);
  }
  return out.sort((a, b) => a.grant.issued_at - b.grant.issued_at);
}

/** The currently-due pre-minted tick, or null when no slot is active. */
export function selectDueTick(stored: StoredGrant, now: number): DelegationToken | null {
  for (const tick of stored.ticks) {
    const activeFrom = tick.not_before ?? tick.issued_at;
    if (now >= activeFrom && now < tick.expires_at) return tick;
  }
  return null;
}

/**
 * Per-turn presentation of a stored grant — what `motebit --grant <id>`
 * threads into `sendMessageStreaming({ delegation })` and what `motebit serve
 * --direct --grant <id>` presents to each task. Artifacts only: the runtime's
 * `verifyGrantForTurn` (the sole authority producer) does every check; a null
 * here just means an honestly grantless turn.
 *
 * Everything is read at EACH presentation, never cached from startup: the
 * stored grant and its locally stored revocation (so `motebit grant revoke`
 * from another shell bites on the running session's next call), plus a pull of
 * the relay's delegation-revocation cache (so a revocation signed on ANOTHER
 * device bites too). A stored grant that has disappeared presents nothing.
 *
 * The pull is fail-closed. With a relay configured, a pull that FAILED
 * (timeout, network error, non-2xx, a body that is not the feed's shape) is
 * not "nothing revoked": this machine may hold a copy of a grant revoked
 * elsewhere, and the payment is broadcast before the relay's own fence sees
 * the task. So a failed pull presents NO grant for that turn: the turn runs
 * grantless and R4 falls back to the owner's approval (or, on a path with no
 * one to approve, is refused). With no relay named there is nothing to ask,
 * and the local set stands.
 *
 * THE RULE: each turn, the presenter pulls from EVERY relay this identity is
 * known to use, and withholds if ANY of those pulls fails. The set is
 * recomputed at each presentation through `GrantPresenterOptions.relayUrls`,
 * a function, so a relay captured once at startup is unrepresentable. The
 * caller composes it (`replGrantRelayUrls`, `daemonGrantRelayUrls`).
 *
 * THE SET is every relay named by ANY source, all of them, not the winning
 * one: the `--sync-url` / `--sync` flag, the `MOTEBIT_SYNC_URL` environment
 * variable, the saved config's `sync_url` (re-read each turn), and every
 * relay the session has used (the REPL's `SessionRelays`, to which startup and
 * a first `/connect` ADD and from which nothing is removed; the daemon's
 * intent and push relay). `/connect` does not move the session: in a session
 * already on a relay it is refused, sends nothing and adds nothing, so the
 * relay the delegation tool submits to stays the one in the set. The sources
 * are not
 * ranked here, because a revocation may have been posted under any of them:
 * `motebit grant revoke` run without the flag posts to the config relay while
 * a session started with `--sync-url` talks to another. Records from every
 * pull are merged. An empty set means no relay is named anywhere. The
 * presenter core reads no config or environment; only the two composers do.
 *
 * The cost, stated: a stale or unreachable relay left in the config or the
 * environment under a flag override withholds the grant every turn until it
 * is removed, and N relays cost N pulls per presented turn.
 *
 * What this does not do: the feed is unsigned, so a relay that omits a record
 * (or a wrong relay URL) still answers "ok". That needs the signed
 * revocation-set attestation (spec/standing-delegation-v1.md §5.2).
 */
export interface GrantDelegation {
  token: DelegationToken;
  grant: StandingDelegation;
  revocations: readonly DelegationRevocation[];
}

/** What one presentation produced, and why when it produced no grant. */
export type GrantPresentation =
  | { status: "presented"; delegation: GrantDelegation }
  /** The stored grant is gone, or no pre-minted tick is active now. */
  | { status: "not_due" }
  /** The relay could not confirm revocation status, so no grant is presented. */
  | { status: "withheld"; reason: "revocation_unconfirmed" };

export interface GrantPresenter {
  grantId: string;
  /** This turn's presentation, with the reason when no grant is presented. */
  presentForTurn(): Promise<GrantPresentation>;
  /**
   * Options fragment for this turn, or null for a grantless turn (no tick due,
   * the grant is gone, or revocation status unconfirmed). `presentForTurn`
   * projected for a caller that does not need the reason.
   */
  delegationForTurn(): Promise<{ delegation: GrantDelegation } | null>;
}

export interface GrantPresenterOptions {
  /**
   * Every relay this identity is known to use, asked at EACH presentation
   * (never captured): see `replGrantRelayUrls` / `daemonGrantRelayUrls`.
   * Entries are normalised and de-duplicated; absent or all-empty means no
   * relay, and nothing is pulled.
   */
  relayUrls?: () => readonly (string | undefined)[];
  /**
   * Called once per OUTAGE: on the first presentation withheld because a
   * relay could not confirm revocation status, with a short fixed reason
   * naming the failing relay's host (`HTTP 429 (relay.example)`,
   * `timeout (…)`). Never a raw URL or a raw error message. Later consecutive
   * withheld turns with the SAME failing hosts are silent; it fires again
   * when the set of failing hosts changes, and after a turn where every pull
   * succeeded. The caller renders its own one-line notice.
   */
  onRevocationUnconfirmed?: (reason: string) => void;
  /** The fetch the revocation pull uses (tests inject one; default: global). */
  fetch?: typeof fetch;
  /** Upper bound on one pull (default 3 s). */
  pullTimeoutMs?: number;
}

/**
 * Every relay a REPL session has used, for the life of the process. Relays
 * are ADDED (the startup relay, a first `/connect` in a session on no relay,
 * the relay the saved config named just before that `/connect` overwrote it)
 * and there is no way to remove or replace one. `/connect B` on a session
 * already on A is refused and adds nothing: the session stays on A, and A
 * stays asked.
 */
export class SessionRelays {
  readonly #urls: string[] = [];

  /** Add a relay (normalised; an empty or already-known one is ignored). */
  add(url: string | undefined): void {
    const normalized = normalizeRelayUrl(url);
    if (normalized == null || this.#urls.includes(normalized)) return;
    this.#urls.push(normalized);
  }

  /** A copy: the set cannot be edited through it. */
  get urls(): readonly string[] {
    return [...this.#urls];
  }
}

/**
 * The relays a REPL session's grant is checked against, this turn: every
 * relay the session has used, and EVERY source that names one — the flag
 * (`config.syncUrl`: `--sync-url`, or `--sync`), the environment, the saved
 * config. All of them, never the first that is set (`namedRelayUrl` picks a
 * winner; a revocation posted to a loser would be missed).
 */
export function replGrantRelayUrls(
  session: { readonly urls: readonly string[] },
  config: { syncUrl?: string | undefined },
): (string | undefined)[] {
  return [
    ...session.urls,
    config.syncUrl,
    process.env["MOTEBIT_SYNC_URL"],
    loadFullConfig().sync_url,
  ];
}

/**
 * The relays a daemon's grant is checked against, this task: the relay named
 * for its identity, the one it pushes to, and EVERY source that names one —
 * the flag, the environment, the saved config. All of them, never a winner.
 * (`daemonRelayUrl` also does not normalise: with `MOTEBIT_SYNC_URL=""` and a
 * config `sync_url` it yields none, while `motebit grant revoke` posts to the
 * config relay.)
 */
export function daemonGrantRelayUrls(
  relay: { syncUrl: string | undefined; intentUrl: string | undefined },
  config: { syncUrl?: string | undefined },
): (string | undefined)[] {
  return [
    relay.intentUrl,
    relay.syncUrl,
    config.syncUrl,
    process.env["MOTEBIT_SYNC_URL"],
    loadFullConfig().sync_url,
  ];
}

/** Upper bound on the per-presentation relay revocation pull. */
const RELAY_REVOCATION_PULL_TIMEOUT_MS = 3_000;

/**
 * One pull of the relay's revocation feed. FAILED and SUCCEEDED-AND-EMPTY are
 * different answers, so they are different variants: a caller cannot read a
 * failed pull as an empty set without saying so.
 */
export type RelayRevocationPull =
  /** The caller named no relay: there is no feed to ask. */
  | { status: "no_relay" }
  /** The relay answered 2xx with a well-shaped feed (possibly empty). */
  | { status: "ok"; records: DelegationRevocation[] }
  /**
   * Timeout, network error, redirect, non-2xx, or a body that is not the
   * feed's shape. `reason` is a fixed short phrase plus the relay's host;
   * `hosts` names each relay that failed (a fixed word when it has no host).
   */
  | { status: "failed"; reason: string; hosts: readonly string[] };

const isRecordObject = (v: unknown): boolean =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Normalised (as the session normalises), de-duplicated, order kept. */
export function normalizeRelayUrls(urls: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const url of urls) {
    const normalized = normalizeRelayUrl(url);
    if (normalized != null && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

/** The relay's host (no userinfo, path or query), or null when it has none. */
function relayHost(relayUrl: string): string | null {
  try {
    const url = new URL(relayUrl);
    return (url.protocol === "https:" || url.protocol === "http:") && url.host !== ""
      ? url.host
      : null;
  } catch {
    return null;
  }
}

const errorField = (err: unknown, field: "name" | "message" | "cause"): unknown =>
  typeof err === "object" && err !== null ? (err as Record<string, unknown>)[field] : undefined;

/**
 * A thrown pull as one of a fixed set of words. The error's own text is never
 * returned: it can carry the request URL, and a URL can carry credentials.
 */
function thrownPullKind(err: unknown): string {
  const name = errorField(err, "name");
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if (name === "SyntaxError") return "not a revocation feed";
  const texts = [errorField(err, "message"), errorField(errorField(err, "cause"), "message")];
  return texts.some((t) => typeof t === "string" && /redirect/i.test(t))
    ? "redirected"
    : "network error";
}

export async function pullRelayRevocations(
  options: { relayUrl?: string | undefined } & Pick<
    GrantPresenterOptions,
    "fetch" | "pullTimeoutMs"
  > = {},
): Promise<RelayRevocationPull> {
  const relayUrl = normalizeRelayUrl(options.relayUrl);
  if (relayUrl == null) return { status: "no_relay" };
  const host = relayHost(relayUrl);
  if (host == null) {
    return { status: "failed", reason: "invalid relay URL", hosts: ["(invalid relay URL)"] };
  }
  const failed = (kind: string): RelayRevocationPull => ({
    status: "failed",
    reason: `${kind} (${host})`,
    hosts: [host],
  });
  const fetchImpl = options.fetch ?? fetch;
  try {
    const res = await fetchImpl(`${relayUrl}/api/v1/delegations/revocations`, {
      signal: AbortSignal.timeout(options.pullTimeoutMs ?? RELAY_REVOCATION_PULL_TIMEOUT_MS),
      // A redirected answer is not this relay's answer: a failed pull.
      redirect: "error",
    });
    if (res.redirected) return failed("redirected");
    if (!res.ok) return failed(`HTTP ${res.status}`);
    const body: unknown = await res.json();
    const records = isRecordObject(body) ? (body as { records?: unknown }).records : undefined;
    if (!Array.isArray(records) || !records.every(isRecordObject)) {
      return failed("not a revocation feed");
    }
    // The whole cache — findGrantRevocation inside the runtime's verifier
    // does the authoritative grant_id + delegator-key binding check, so
    // over-inclusion is harmless and correct.
    return { status: "ok", records: records as DelegationRevocation[] };
  } catch (err: unknown) {
    // Timeout, offline, or an unparseable body: revocation status is unknown.
    return failed(thrownPullKind(err));
  }
}

/**
 * Pull every relay in the set. ANY failed pull fails the whole: one relay
 * that cannot be read may be the one holding the revocation. All succeeded:
 * the records are merged. An empty set is `no_relay`.
 */
export async function pullRevocationsFromRelays(
  relayUrls: readonly (string | undefined)[],
  options: Pick<GrantPresenterOptions, "fetch" | "pullTimeoutMs"> = {},
): Promise<RelayRevocationPull> {
  const urls = normalizeRelayUrls(relayUrls);
  if (urls.length === 0) return { status: "no_relay" };
  const pulls = await Promise.all(
    urls.map((relayUrl) => pullRelayRevocations({ ...options, relayUrl })),
  );
  const failures = pulls.flatMap((p) => (p.status === "failed" ? [p] : []));
  if (failures.length > 0) {
    return {
      status: "failed",
      reason: failures.map((f) => f.reason).join("; "),
      hosts: failures.flatMap((f) => f.hosts),
    };
  }
  return { status: "ok", records: pulls.flatMap((p) => (p.status === "ok" ? p.records : [])) };
}

export function createGrantPresenter(
  grantId: string,
  options: GrantPresenterOptions = {},
): Promise<GrantPresenter | null> {
  if (loadStoredGrant(grantId) == null) {
    console.error(`--grant: no stored grant ${grantId} under ${grantsDir()}`);
    return Promise.resolve(null);
  }
  /** The failing hosts last announced; null while no outage stands announced. */
  let announced: string | null = null;
  /** This turn's relay set, asked of the caller now; unreadable is a failure. */
  const pullForTurn = async (): Promise<RelayRevocationPull> => {
    let relayUrls: readonly (string | undefined)[];
    try {
      relayUrls = options.relayUrls?.() ?? [];
    } catch {
      return {
        status: "failed",
        reason: "relay configuration unreadable",
        hosts: ["(relay configuration)"],
      };
    }
    return pullRevocationsFromRelays(relayUrls, options);
  };
  const presentForTurn = async (): Promise<GrantPresentation> => {
    const stored = loadStoredGrant(grantId);
    if (stored == null || stored.grant.grant_id !== grantId) return { status: "not_due" };
    const tick = selectDueTick(stored, Date.now());
    if (tick == null) return { status: "not_due" };
    const pull = await pullForTurn();
    if (pull.status === "failed") {
      // Announce when the set of failing relays is new: the first failure of
      // an outage, and again when a different relay is the one failing.
      const failing = [...pull.hosts].sort().join(",");
      if (failing !== announced) {
        announced = failing;
        options.onRevocationUnconfirmed?.(pull.reason);
      }
      return { status: "withheld", reason: "revocation_unconfirmed" };
    }
    // Every relay answered: the outage (if any) is over, the next one is new.
    if (pull.status === "ok") announced = null;
    const revocations: DelegationRevocation[] = [
      ...(stored.revocation != null ? [stored.revocation] : []),
      ...(pull.status === "ok" ? pull.records : []),
    ];
    return { status: "presented", delegation: { token: tick, grant: stored.grant, revocations } };
  };
  return Promise.resolve({
    grantId,
    presentForTurn,
    async delegationForTurn() {
      const presentation = await presentForTurn();
      return presentation.status === "presented" ? { delegation: presentation.delegation } : null;
    },
  });
}

function usdFlag(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const usd = Number(value);
  if (!Number.isFinite(usd) || usd <= 0) {
    console.error(`--${name} must be a positive number of USD (got "${value}")`);
    process.exit(1);
  }
  const micro = Math.round(usd * MICRO_PER_USD);
  if (!Number.isSafeInteger(micro)) {
    console.error(`--${name} is out of range`);
    process.exit(1);
  }
  return micro;
}

function intFlag(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`--${name} must be a positive integer (got "${value}")`);
    process.exit(1);
  }
  return n;
}

const usd = (micro: number): string => `$${(micro / MICRO_PER_USD).toFixed(2)}`;

/**
 * The mint itself, pure given keys — the v1.0 pre-minting model (§4):
 * one self-delegation grant + one future-dated `not_before`-gated 1h
 * tick per cadence slot, all delegator-signed now. Slot 0 is active
 * immediately; later slots cannot verify before their `not_before`.
 * Exported for tests; `handleGrantCreate` is the key-unlocking shell.
 */
export async function mintGrantWithSchedule(params: {
  motebitId: string;
  publicKeyHex: string;
  privateKey: Uint8Array;
  scope: string;
  subject: string;
  ceiling: SpendCeilingV1;
  cadenceMs: number;
  days: number;
  now: number;
}): Promise<{ grant: StandingDelegation; ticks: DelegationToken[] }> {
  const { motebitId, publicKeyHex, privateKey, scope, subject, ceiling, cadenceMs, days, now } =
    params;
  const slotCount = Math.floor((days * DAY_MS) / cadenceMs);
  const grantId = generateUUIDv7();
  // Self-delegation (the N=1 first-grant shape): the motebit authorizes
  // ITSELF to act on a schedule. Delegator and delegate are the same
  // identity + key; the authority split is temporal (pre-minted slots),
  // not inter-party.
  const grant = await signStandingDelegation(
    {
      grant_id: grantId,
      delegator_id: motebitId,
      delegator_public_key: publicKeyHex,
      delegate_id: motebitId,
      delegate_public_key: publicKeyHex,
      scope,
      subject,
      spend_ceiling: ceiling,
      cadence_ms: cadenceMs,
      issued_at: now,
      not_before: null,
      expires_at: now + days * DAY_MS,
      max_token_ttl_ms: HOUR_MS,
    },
    privateKey,
  );

  const ticks: DelegationToken[] = [];
  for (let slot = 0; slot < slotCount; slot++) {
    const slotStart = now + slot * cadenceMs;
    ticks.push(
      await signDelegation(
        {
          delegator_id: motebitId,
          delegator_public_key: publicKeyHex,
          delegate_id: motebitId,
          delegate_public_key: publicKeyHex,
          scope,
          issued_at: slotStart,
          expires_at: slotStart + HOUR_MS,
          ...(slot > 0 ? { not_before: slotStart } : {}),
          grant_id: grantId,
        },
        privateKey,
      ),
    );
  }
  return { grant, ticks };
}

// === motebit grant create ============================================

export async function handleGrantCreate(config: CliConfig): Promise<void> {
  const fullConfig = loadFullConfig();
  const motebitId = fullConfig.motebit_id;
  if (motebitId == null || motebitId === "") {
    console.error("No motebit identity configured — run `motebit init` first.");
    process.exit(1);
  }

  const scope = config.scope;
  const subject = config.subject;
  if (scope == null || scope.trim() === "" || subject == null || subject.trim() === "") {
    console.error(
      "Usage: motebit grant create --scope <capabilities> --subject <binding> --lifetime-usd <n> [--days 7] [--cadence-hours 24] [--window-usd <n> --window-hours <n>]",
    );
    process.exit(1);
  }

  const lifetimeMicro = usdFlag(config.lifetimeUsd, "lifetime-usd");
  if (lifetimeMicro === undefined) {
    // A money grant MUST bound total exposure (spec §3.3: at least one
    // total bound, and lifetime is the offline-meaningful one). Refusing
    // to mint without it is the CLI's surface-honesty duty.
    console.error(
      "--lifetime-usd is required: a standing grant that can move money MUST carry a signed total bound (spec/standing-delegation-v1.md §3.3).",
    );
    process.exit(1);
  }
  const windowMicro = usdFlag(config.windowUsd, "window-usd");
  const windowHours = config.windowHours ? intFlag(config.windowHours, "window-hours", 24) : 24;
  if (config.windowHours !== undefined && windowMicro === undefined) {
    console.error("--window-hours requires --window-usd");
    process.exit(1);
  }
  const days = intFlag(config.days, "days", 7);
  if (days > 30) {
    // §6 D4: money grants live short — 7–30d renewable. Not a hard spec
    // MUST, but the CLI mints the recommended shape; a longer horizon is
    // a deliberate hand-edit, not a default drift.
    console.error(
      "--days must be ≤ 30 for a money grant (spec §6 D4: offline worst-case exposure = lifetime × ceiling; renew by re-minting).",
    );
    process.exit(1);
  }
  const cadenceHours = intFlag(config.cadenceHours, "cadence-hours", 24);
  const cadenceMs = cadenceHours * HOUR_MS;
  const slotCount = Math.floor((days * DAY_MS) / cadenceMs);
  if (slotCount < 1) {
    console.error("--cadence-hours exceeds the grant lifetime — no tick slots fit.");
    process.exit(1);
  }
  if (slotCount > MAX_TICKS) {
    console.error(`Schedule of ${slotCount} ticks exceeds the ${MAX_TICKS}-tick pre-mint bound.`);
    process.exit(1);
  }

  const ceiling: SpendCeilingV1 = {
    schema: "motebit.spend-ceiling.v1",
    lifetime_limit_micro: lifetimeMicro,
    ...(windowMicro !== undefined
      ? { cumulative_limit_micro: windowMicro, window_ms: windowHours * HOUR_MS }
      : {}),
  };

  const active = await loadActiveSigningKey(fullConfig, { promptLabel: "Passphrase: " });
  try {
    const { grant, ticks } = await mintGrantWithSchedule({
      motebitId,
      publicKeyHex: active.publicKey,
      privateKey: active.privateKey,
      scope: scope.trim(),
      subject: subject.trim(),
      ceiling,
      cadenceMs,
      days,
      now: Date.now(),
    });
    const grantId = grant.grant_id;

    saveStoredGrant({ grant, ticks });

    console.log(`Grant minted: ${grantId}`);
    console.log(`  scope     ${grant.scope}`);
    console.log(`  subject   ${grant.subject}`);
    console.log(
      `  ceiling   ${usd(lifetimeMicro)} lifetime${windowMicro !== undefined ? ` / ${usd(windowMicro)} per ${windowHours}h window` : ""}`,
    );
    console.log(
      `  schedule  ${ticks.length} pre-minted tick${ticks.length === 1 ? "" : "s"}, every ${cadenceHours}h, 1h each`,
    );
    console.log(`  expires   ${new Date(grant.expires_at).toISOString()} (${days}d)`);
    console.log("");
    console.log(`Present it: motebit --grant ${grantId}`);
    console.log(`Revoke it:  motebit grant revoke ${grantId}`);
    console.log("");
    console.log(
      "The ceiling is enforced by this runtime's money meter on every grant-cleared action. Revocation is terminal and propagates to the relay cache.",
    );
  } finally {
    secureErase(active.privateKey);
  }
}

// === motebit grant list / show =======================================

/**
 * Read a grant's durable spend accumulator (the same SQLite store the money
 * meter writes). Read-only owner legibility (#436): the spend was recorded on
 * every metered payment but observable NOWHERE until the ceiling denial.
 * Undefined when the DB is unavailable or the grant has never spent.
 */
async function readSpentMicro(grantIds: string[]): Promise<Map<string, number>> {
  const spent = new Map<string, number>();
  try {
    const db = await openMotebitDatabase(getDbPath(undefined));
    try {
      for (const id of grantIds) {
        const state = db.grantSpendStore.peek(id);
        if (state != null) spent.set(id, state.lifetime_spent_micro);
      }
    } finally {
      db.close();
    }
  } catch {
    // No DB (fresh machine) — grants exist but nothing has ever spent.
  }
  return spent;
}

/**
 * A grant authorizes spending only when its delegator key is this motebit's
 * CURRENT identity key (`grantDelegatorIs` in @motebit/runtime — authority
 * derives from the immediate issuer, and it flows forward across a rotation,
 * never back). `motebit rotate` leaves stored grants untouched, so a grant
 * signed under a previous key stays on disk and verifies as a signature,
 * yet no longer moves money. False when the current key is unknown.
 */
export function signedByPreviousKey(
  grant: Pick<StandingDelegation, "delegator_public_key">,
  currentPublicKeyHex: string | undefined,
): boolean {
  if (currentPublicKeyHex == null || currentPublicKeyHex === "") return false;
  return grant.delegator_public_key.toLowerCase() !== currentPublicKeyHex.toLowerCase();
}

export const PREVIOUS_KEY_MARK = "signed by a previous key — re-issue with `motebit grant create`";

/** The `grant list` lines: one per grant, plus the previous-key mark under each it applies to. */
export function formatGrantListLines(
  grants: StoredGrant[],
  opts: { now: number; spent: Map<string, number>; currentPublicKeyHex: string | undefined },
): string[] {
  const lines: string[] = [];
  for (const stored of grants) {
    const g = stored.grant;
    const state =
      stored.revocation != null ? "REVOKED" : g.expires_at < opts.now ? "expired" : "active";
    const ceiling = g.spend_ceiling?.lifetime_limit_micro;
    const spentMicro = opts.spent.get(g.grant_id) ?? 0;
    const money =
      ceiling != null
        ? `  ${usd(Math.max(0, ceiling - spentMicro))} of ${usd(ceiling)} lifetime remaining`
        : "  (no ceiling — no money)";
    lines.push(`${g.grant_id}  ${state.padEnd(7)}  ${g.subject}  scope=${g.scope}${money}`);
    if (signedByPreviousKey(g, opts.currentPublicKeyHex)) lines.push(`  ${PREVIOUS_KEY_MARK}`);
  }
  return lines;
}

/**
 * The one line `motebit rotate` prints after a rotation when live grants
 * (neither revoked nor expired) were signed by a key other than the new
 * one; null when there are none.
 */
export function previousKeyGrantNotice(
  grants: StoredGrant[],
  newPublicKeyHex: string,
  now: number,
): string | null {
  const n = grants.filter(
    (s) =>
      s.revocation == null &&
      s.grant.expires_at >= now &&
      signedByPreviousKey(s.grant, newPublicKeyHex),
  ).length;
  if (n === 0) return null;
  return `  Grants: ${n} standing grant${n === 1 ? " was" : "s were"} signed by a previous key and no longer authorize${n === 1 ? "s" : ""} spending — re-issue with \`motebit grant create\``;
}

export async function handleGrantList(): Promise<void> {
  const grants = listStoredGrants();
  if (grants.length === 0) {
    console.log(
      "No standing grants. Mint one: motebit grant create --scope … --subject … --lifetime-usd …",
    );
    return;
  }
  const spent = await readSpentMicro(grants.map((s) => s.grant.grant_id));
  let currentPublicKeyHex: string | undefined;
  try {
    currentPublicKeyHex = loadFullConfig().device_public_key;
  } catch {
    // No readable config: nothing to compare against, so no mark.
  }
  const lines = formatGrantListLines(grants, { now: Date.now(), spent, currentPublicKeyHex });
  for (const line of lines) console.log(line);
}

export async function handleGrantShow(grantId: string | undefined): Promise<void> {
  if (grantId == null || grantId === "") {
    console.error("Usage: motebit grant show <grant_id>");
    process.exit(1);
  }
  const stored = loadStoredGrant(grantId);
  if (stored == null) {
    console.error(`No stored grant ${grantId} under ${grantsDir()}`);
    process.exit(1);
  }
  const now = Date.now();
  const due = selectDueTick(stored, now);
  console.log(JSON.stringify(stored.grant, null, 2));
  console.log("");
  const ceiling = stored.grant.spend_ceiling?.lifetime_limit_micro;
  if (ceiling != null) {
    const spentMicro = (await readSpentMicro([stored.grant.grant_id])).get(grantId) ?? 0;
    console.log(
      `spend: ${usd(spentMicro)} of ${usd(ceiling)} lifetime used · ${usd(Math.max(0, ceiling - spentMicro))} remaining`,
    );
  }
  console.log(
    `ticks: ${stored.ticks.length} pre-minted; ${due != null ? `slot due now (issued_at ${new Date(due.issued_at).toISOString()})` : "no slot due now"}`,
  );
  if (stored.revocation != null) {
    console.log(`REVOKED at ${new Date(stored.revocation.revoked_at).toISOString()} (terminal)`);
  }
}

// === motebit grant revoke ============================================

export async function handleGrantRevoke(
  grantId: string | undefined,
  config: { syncUrl?: string | undefined } = {},
): Promise<void> {
  if (grantId == null || grantId === "") {
    console.error("Usage: motebit grant revoke <grant_id>");
    process.exit(1);
  }
  const stored = loadStoredGrant(grantId);
  if (stored == null) {
    console.error(`No stored grant ${grantId} under ${grantsDir()}`);
    process.exit(1);
  }
  if (stored.revocation != null) {
    console.log(`Already revoked (terminal — spec §6 D3). Nothing to do.`);
    return;
  }
  // A grant whose delegator key is not in its one canonical spelling (64
  // lowercase hex, standing-delegation-v1 §5) verifies nowhere, so it confers
  // nothing — and a revocation of it cannot be signed (the signer refuses the
  // spelling). Say so calmly, before asking for the passphrase.
  if (!/^[0-9a-f]{64}$/.test(stored.grant.delegator_public_key)) {
    console.error(
      `Grant ${grantId} carries a non-canonical delegator key — it verifies nowhere and is already inert. Nothing to revoke.`,
    );
    process.exit(1);
  }

  const fullConfig = loadFullConfig();
  const active = await loadActiveSigningKey(fullConfig, { promptLabel: "Passphrase: " });
  let revocation: DelegationRevocation;
  try {
    revocation = await signDelegationRevocation(
      {
        grant_id: stored.grant.grant_id,
        delegator_id: stored.grant.delegator_id,
        delegator_public_key: stored.grant.delegator_public_key,
        revoked_at: Date.now(),
      },
      active.privateKey,
    );
  } finally {
    secureErase(active.privateKey);
  }

  saveStoredGrant({ ...stored, revocation });
  console.log(`Revoked ${grantId} locally — this runtime refuses every remaining tick.`);

  // Best-effort propagation: revocations want to travel (§5 — the relay
  // cache is what lets the coordinator refuse at acceptance/settlement).
  // Offline is not failure: the local store already bites, and anyone
  // may re-propagate the signed artifact later.
  // The relay the operator named for this process, resolved as every other
  // command resolves it: `--sync-url` > MOTEBIT_SYNC_URL > config `sync_url`.
  const relayUrl = namedRelayUrl(config, fullConfig);
  if (relayUrl == null) {
    console.log("No relay configured — propagate later by re-running revoke with sync_url set.");
    return;
  }
  try {
    const res = await fetch(`${relayUrl}/api/v1/delegations/revocations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(revocation),
    });
    if (res.ok) {
      const body = (await res.json()) as { status?: string };
      console.log(`Propagated to relay cache (${body.status ?? "recorded"}).`);
    } else {
      console.warn(`Relay declined propagation (HTTP ${res.status}) — local revocation stands.`);
    }
  } catch {
    console.warn("Relay unreachable — local revocation stands; re-run revoke to propagate.");
  }
}
