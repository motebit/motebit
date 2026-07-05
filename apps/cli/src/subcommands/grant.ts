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
 * still bites locally: the chat presenter includes the stored revocation
 * in the held set, and `verifyGrantForTurn` refuses.
 *
 * Honest framing (trust-layer discipline): the ceiling is what the
 * runtime's meter ENFORCES on the trusted-runtime path — never displayed
 * as an offline guarantee. Money-grant lifetime defaults to 7 days
 * (§6 D4: offline worst-case exposure = short lifetime × signed ceiling).
 */

import { readFileSync, writeFileSync, readdirSync, mkdirSync, existsSync } from "node:fs";
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
import { CONFIG_DIR, loadFullConfig } from "../config.js";
import { loadActiveSigningKey } from "../identity.js";
import type { CliConfig } from "../args.js";

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
  mkdirSync(grantsDir(), { recursive: true });
  writeFileSync(
    join(grantsDir(), `${stored.grant.grant_id}.json`),
    JSON.stringify(stored, null, 2),
  );
}

function listStoredGrants(): StoredGrant[] {
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
 * threads into `sendMessageStreaming({ delegation })`. Artifacts only:
 * the runtime's `verifyGrantForTurn` (the sole authority producer) does
 * every check; a null here just means an honestly grantless turn.
 *
 * The held revocation set = the locally stored revocation (if any) plus
 * a best-effort pull of the relay's delegation-revocation cache at
 * session start — so a revocation signed on ANOTHER device and
 * propagated through the relay bites here too. Offline pull failure is
 * not an error (the cache is a cache, §6 D2); it narrows freshness to
 * the local set, and the relay re-fences at acceptance regardless.
 */
export interface GrantPresenter {
  grantId: string;
  /** Options fragment for this turn, or null when no tick is due / revoked. */
  delegationForTurn(): {
    delegation: {
      token: DelegationToken;
      grant: StandingDelegation;
      revocations: readonly DelegationRevocation[];
    };
  } | null;
}

export async function createGrantPresenter(grantId: string): Promise<GrantPresenter | null> {
  const stored = loadStoredGrant(grantId);
  if (stored == null) {
    console.error(`--grant: no stored grant ${grantId} under ${grantsDir()}`);
    return null;
  }
  const revocations: DelegationRevocation[] = stored.revocation != null ? [stored.revocation] : [];

  const relayUrl = (loadFullConfig().sync_url ?? process.env["MOTEBIT_SYNC_URL"] ?? "").replace(
    /\/$/,
    "",
  );
  if (relayUrl !== "") {
    try {
      const res = await fetch(`${relayUrl}/api/v1/delegations/revocations`);
      if (res.ok) {
        const body = (await res.json()) as { records?: DelegationRevocation[] };
        // Include the whole cache — findGrantRevocation inside the
        // runtime's verifier does the authoritative grant_id + delegator-
        // key binding check, so over-inclusion is harmless and correct.
        for (const record of body.records ?? []) revocations.push(record);
      }
    } catch {
      // Offline — local set stands; the relay re-fences at acceptance.
    }
  }

  return {
    grantId,
    delegationForTurn() {
      const tick = selectDueTick(stored, Date.now());
      if (tick == null) return null;
      return { delegation: { token: tick, grant: stored.grant, revocations } };
    },
  };
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

export function handleGrantList(): void {
  const grants = listStoredGrants();
  if (grants.length === 0) {
    console.log(
      "No standing grants. Mint one: motebit grant create --scope … --subject … --lifetime-usd …",
    );
    return;
  }
  const now = Date.now();
  for (const stored of grants) {
    const g = stored.grant;
    const state = stored.revocation != null ? "REVOKED" : g.expires_at < now ? "expired" : "active";
    const ceiling = g.spend_ceiling?.lifetime_limit_micro;
    console.log(
      `${g.grant_id}  ${state.padEnd(7)}  ${g.subject}  scope=${g.scope}${ceiling != null ? `  ${usd(ceiling)} lifetime` : "  (no ceiling — no money)"}`,
    );
  }
}

export function handleGrantShow(grantId: string | undefined): void {
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
  console.log(
    `ticks: ${stored.ticks.length} pre-minted; ${due != null ? `slot due now (issued_at ${new Date(due.issued_at).toISOString()})` : "no slot due now"}`,
  );
  if (stored.revocation != null) {
    console.log(`REVOKED at ${new Date(stored.revocation.revoked_at).toISOString()} (terminal)`);
  }
}

// === motebit grant revoke ============================================

export async function handleGrantRevoke(grantId: string | undefined): Promise<void> {
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
  const relayUrl = (fullConfig.sync_url ?? process.env["MOTEBIT_SYNC_URL"] ?? "").replace(
    /\/$/,
    "",
  );
  if (relayUrl === "") {
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
