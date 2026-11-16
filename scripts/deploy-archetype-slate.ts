#!/usr/bin/env tsx
/**
 * deploy-archetype-slate — idempotent Fly.io ceremony for the archetype
 * slate (docs/doctrine/agent-archetypes.md): atoms first (web-search,
 * read-url, summarize), capture their motebit_ids from the relay, then
 * molecules (research, auditor) with atom-target secrets wired.
 *
 * Replaces the old two-service `deploy-money-loop.sh` ceremony.
 *
 * SAFE BY DEFAULT: dry-run unless RUN=1. Everything is idempotent —
 * existing apps/volumes are left alone; secrets are (re)staged; deploys
 * always run (fly dedupes by image).
 *
 *   DRY RUN:   npx tsx scripts/deploy-archetype-slate.ts
 *   STAGING:   RUN=1 npx tsx scripts/deploy-archetype-slate.ts
 *   PROD:      MOTEBIT_RELAY_PUBLIC_KEY=<production relay key> RUN=1 TARGET=prod \
 *                npx tsx scripts/deploy-archetype-slate.ts
 *              (the key is the operator's pin, obtained out of band; a
 *               promotion without it is refused: see Required env)
 *
 * TARGET is unset, `staging` or `prod`, exactly. Anything else (`PROD`,
 * `prod ` with a space, an empty value) is refused before anything runs: it
 * used to deploy STAGING silently.
 *
 * PROMOTION READINESS (docs/doctrine/agent-archetypes.md §4). A real
 * production promotion reads the conformance workflow's scheduled-run
 * history (scripts/check-promotion-ready.ts, `readPromotionReadiness`: the
 * newest 5 scheduled runs of archetype-conformance.yml in motebit/motebit,
 * each a first attempt on main that concluded success, the newest at most 48
 * hours old, no two counted runs more than 48 hours apart (a schedule that
 * stopped and restarted)) BEFORE its first flyctl call, and REFUSES (exit 1,
 * nothing
 * deployed, no secret staged) unless ready. Unreadable history (gh missing,
 * unauthenticated, erroring) refuses. A run is a production promotion when
 * TARGET=prod, OR when the relay it resolves to is the production relay
 * (relay.motebit.com / motebit-sync.fly.dev) even though the apps are the
 * `-stg` ones: joining staging apps to the production relay is gated the
 * same way. A dry run of either reports the readiness and refuses nothing.
 * A staging run against any other relay never reads it.
 *
 *   OVERRIDE:  PROMOTION_READINESS_OVERRIDE_REASON="<why>" \
 *                MOTEBIT_RELAY_PUBLIC_KEY=<production relay key> RUN=1 TARGET=prod …
 *              The only bypass. The value must be a reason someone wrote: at
 *              least 10 characters after trimming, and not `1`, `true`,
 *              `yes`, `y`, `ok` or `override`. Anything less does not
 *              override. The run prints the reason and the readiness result
 *              it overrode, then proceeds. Nothing records it beyond this
 *              run's output: the reason makes a bypass visible, not
 *              impossible. It overrides readiness only, never the clerk's
 *              relay-key rules below.
 *
 * What this does NOT cover: this is still a local flyctl deploy, so no CI
 * gate and no GitHub environment reviewer applies to it; a direct
 * `flyctl deploy` consults nothing; and once a prod app exists, its
 * deploy-<service>.yml workflow deploys it on CI + staging + head of main +
 * a reviewer WITHOUT consulting conformance history.
 *
 * Required env (real run):
 *   MOTEBIT_API_TOKEN        the operator's token — used by THIS script's discover call only;
 *                            never handed to a worker (workers self-authenticate)
 *   ANTHROPIC_API_KEY        research only (operator-funded inference)
 *   MOTEBIT_SOLANA_RPC_URL   clerk only: the sovereign rail. The clerk exits at boot without
 *                            MOTEBIT_SOLANA_RPC_URL, MOTEBIT_RELAY_PUBLIC_KEY and
 *                            MOTEBIT_SYNC_URL (services/clerk/src/index.ts). This script
 *                            stages the last two itself; it passes this one through and
 *                            does NOT check that it is set.
 * Optional:
 *   RELAY_URL                override the target relay base URL
 *   MOTEBIT_RELAY_PUBLIC_KEY clerk only: the operator's pin of the relay key, the clerk's
 *                            payment trust root. The operator's key is the pin; the key
 *                            this script fetches from the relay's well-known descriptor is
 *                            a convenience and a cross-check, because it is served by the
 *                            very relay it would pin (trust on first use).
 *                            REQUIRED on a production promotion (TARGET=prod or the
 *                            production relay): unset, empty or whitespace REFUSES before
 *                            any flyctl call. Get the key out of band.
 *                            On a staging run it is optional: unset, the clerk gets the
 *                            fetched key, and the log says it is not an operator pin.
 *                            When set it must be 64 hex characters (compared lower-cased),
 *                            or the run is refused on every target. It is then compared
 *                            with the fetched key: a MISMATCH refuses a production
 *                            promotion; on a staging run it prints a warning and the
 *                            clerk gets the operator's value.
 *                            The OTHER five workers always get the fetched key as their
 *                            task-admission key. That is trust on first use for them, and
 *                            an open question this script does not settle.
 *   MOTEBIT_CLERK_CEILING_MICRO  clerk only (default 1000000)
 *   BRAVE_API_KEY            web-search only
 *
 * Economics posture (agent-archetypes.md §5): the multi-hop settlement arc
 * landed (Inc 1/2), so atoms are now PRICED cost-indexed (web-search $0.003,
 * read-url $0.002) and advertise p2p. The Researcher PAYS them P2P once its
 * money seam is flipped (Inc 3b — fund its wallet + set MOTEBIT_SOLANA_RPC_URL
 * + MOTEBIT_RELAY_PUBLIC_KEY); until that ratified live-money step it uses the
 * free direct-MCP fallback (bindRelayBudget degrades on the paid-cross-agent
 * gate). Molecules are priced cost-indexed (research $0.25 incl. operator
 * inference, auditor $0.01 LLM-free, clerk $0.01) and settle P2P-at-top-of-chain.
 */

import { execFileSync } from "node:child_process";

import {
  PROMOTION_MAX_NEWEST_RUN_AGE_HOURS,
  PROMOTION_MAX_RUN_GAP_HOURS,
  PROMOTION_REQUIRED_GREEN_RUNS,
  describePromotionReadiness,
  isProgramEntry,
  promotionRepair,
  readPromotionReadiness,
  type ListRuns,
} from "./check-promotion-ready.ts";
import { cleanEnv } from "./lib/differential-tree.ts";

interface SlateService {
  name: string;
  app: (target: Target) => string;
  config: (target: Target) => string;
  volume: string;
  kind: "atom" | "molecule";
  capability: string;
  /** env secrets beyond the shared registration set; value null = pass through from process env. */
  secrets: (ctx: SecretContext) => Record<string, string>;
}

type Target = "staging" | "prod";

interface SecretContext {
  target: Target;
  /** The deploy environment secrets are passed through from. */
  env: Record<string, string | undefined>;
  relayUrl: string;
  /** The OPERATOR's token — used only for the operator's own discover call below; never placed in a worker secret map. */
  apiToken: string;
  /** The target relay's Ed25519 public key (hex) from its well-known descriptor — the worker's task-admission pin. */
  relayPublicKey: string;
  /**
   * The relay key the CLERK is staged (its pinned P2P treasury root): the
   * operator's validated MOTEBIT_RELAY_PUBLIC_KEY when set, else the fetched
   * key. Resolved once in `runSlate`, which refuses a malformed pin and a
   * pin that disagrees with the relay on a promotion.
   */
  clerkRelayPublicKey: string;
  /** capability → motebit_id captured from the relay after atom deploys. */
  atomIds: Map<string, string>;
  appHost: (app: string) => string;
}

const REGION = "sjc";

/** An Ed25519 public key as the relay serves it: 64 lower-case hex characters. */
const RELAY_KEY_FORMAT = /^[0-9a-f]{64}$/;

/** A key's first and last 8 hex characters, for a message that compares two. */
const keyEnds = (key: string): string => `${key.slice(0, 8)}…${key.slice(-8)}`;

const STAGING_RELAY_URL = "https://motebit-sync-stg.fly.dev";
const PROD_RELAY_URL = "https://relay.motebit.com";
/**
 * Hosts that ARE the production relay: its public name and its Fly app
 * (docs/ops/RUNBOOK.md). A run that resolves to one of them is a production
 * promotion whatever TARGET says.
 */
const PROD_RELAY_HOSTS: readonly string[] = ["relay.motebit.com", "motebit-sync.fly.dev"];

/**
 * The host an http(s) relay URL names, lower-cased with no trailing dot; null
 * when it is not one. `relay.motebit.com:443` parses as a URL whose SCHEME is
 * `relay.motebit.com:` and whose host is empty, so the scheme is checked.
 */
function relayHost(relayUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(relayUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  // An http(s) URL always has a host (`new URL("https://")` throws).
  return url.hostname.toLowerCase().replace(/\.$/, "");
}

/**
 * The one bypass of the promotion-readiness refusal: a reason someone wrote.
 * See `overrideReasonOf` for what counts.
 */
export const PROMOTION_READINESS_OVERRIDE_ENV = "PROMOTION_READINESS_OVERRIDE_REASON";

/** A reason shorter than this (trimmed) is not a reason. */
const OVERRIDE_REASON_MIN_LENGTH = 10;
/**
 * Flag-shaped values, named so the refusal can say them. Every one is also
 * shorter than the minimum length, which is the rule that rejects them.
 */
const OVERRIDE_NOT_A_REASON: readonly string[] = ["1", "true", "yes", "y", "ok", "override"];

/** The override reason when the value is one, else null (no override). */
function overrideReasonOf(raw: string | undefined): string | null {
  const reason = (raw ?? "").trim();
  if (reason.length < OVERRIDE_REASON_MIN_LENGTH) return null;
  if (OVERRIDE_NOT_A_REASON.includes(reason.toLowerCase())) return null;
  return reason;
}

/**
 * Everything the ceremony does to the world, as parameters, so a test can
 * drive `runSlate` with a recording runner and no real gh, flyctl or network.
 */
export interface SlateEffects {
  env: Record<string, string | undefined>;
  /** Runs a command and returns its stdout; throws on a non-zero exit. */
  exec: (cmd: string, args: string[], opts?: { quiet?: boolean }) => string;
  fetch: (url: string, init?: { headers?: Record<string, string> }) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
  error: (line: string) => void;
  table: (rows: unknown[]) => void;
  /** Lists scheduled conformance runs for the readiness check (default: `gh run list`). */
  listRuns?: ListRuns;
  /** The clock the readiness check measures the newest run's age against (default: the real one). */
  now?: () => Date;
}

// The slate — parsed by check-archetype-slate; order is the deploy order
// (atoms first — molecules exit(1) without atom hostnames).
export const SLATE: SlateService[] = [
  {
    name: "web-search",
    app: (t) => (t === "prod" ? "motebit-web-search" : "motebit-web-search-stg"),
    config: (t) => `services/web-search/${t === "prod" ? "fly.toml" : "fly.staging.toml"}`,
    volume: "web_search_data",
    kind: "atom",
    capability: "web_search",
    secrets: (ctx) => ({
      MOTEBIT_SYNC_URL: ctx.relayUrl,
      // No relay token of any kind: the worker authenticates to the relay AS
      // ITSELF (per-audience signed tokens after a public bootstrap) and admits
      // tasks by verifying the relay-signed dispatch token against this pin.
      // Until 2026-09-15 this map handed the OPERATOR's master token to every
      // worker twice — as MOTEBIT_API_TOKEN and again as MOTEBIT_AUTH_TOKEN.
      MOTEBIT_RELAY_PUBLIC_KEY: ctx.relayPublicKey,
      // Inc 3 — the multi-hop settlement arc landed (Inc 1/2), so the atoms are
      // now PRICED market participants, not free riders. Cost-indexed: web
      // search clears ~$0.001-0.01/query in the API economy; $0.003 = ~2x
      // marginal, comfortably above the ~$0.001 Solana settle floor.
      MOTEBIT_UNIT_COST: "0.003",
      // Advertise p2p so a paying delegator (a flipped Researcher) can settle
      // the hop P2P; the settlement address is derived from this atom's own
      // identity key (molecule-runner). relay,p2p keeps relay-mode available.
      MOTEBIT_SETTLEMENT_MODES: "relay,p2p",
      BRAVE_API_KEY: ctx.env["BRAVE_API_KEY"] ?? "",
    }),
  },
  {
    name: "read-url",
    app: (t) => (t === "prod" ? "motebit-read-url" : "motebit-read-url-stg"),
    config: (t) => `services/read-url/${t === "prod" ? "fly.toml" : "fly.staging.toml"}`,
    volume: "read_url_data",
    kind: "atom",
    capability: "read_url",
    secrets: (ctx) => ({
      MOTEBIT_SYNC_URL: ctx.relayUrl,
      // No relay token of any kind: the worker authenticates to the relay AS
      // ITSELF (per-audience signed tokens after a public bootstrap) and admits
      // tasks by verifying the relay-signed dispatch token against this pin.
      // Until 2026-09-15 this map handed the OPERATOR's master token to every
      // worker twice — as MOTEBIT_API_TOKEN and again as MOTEBIT_AUTH_TOKEN.
      MOTEBIT_RELAY_PUBLIC_KEY: ctx.relayPublicKey,
      // Inc 3 — priced now the arc landed. $0.002 = ~2x a page-read's marginal
      // cost, at the Solana settle floor (payment overhead is a known ceiling
      // at this price — the batching arc is the lever below it, not a lower list).
      MOTEBIT_UNIT_COST: "0.002",
      MOTEBIT_SETTLEMENT_MODES: "relay,p2p",
    }),
  },
  {
    name: "summarize",
    app: (t) => (t === "prod" ? "motebit-summarize" : "motebit-summarize-stg"),
    config: (t) => `services/summarize/${t === "prod" ? "fly.toml" : "fly.staging.toml"}`,
    volume: "summarize_data",
    // A DELEGATING atom — summarize_search connects to web-search on boot
    // (services/summarize/src/index.ts: `await webSearchAdapter.connect()`,
    // loud failure by design). It reads WEB_SEARCH_URL and defaults to
    // localhost, so it MUST be wired to the deployed web-search host or the
    // process exits before registering (the un-discoverable failure caught
    // on the first staging deploy). Kept in the atom phase — it delegates
    // to a fixed host, not a market-discovered target, so it needs no
    // atom-id capture.
    kind: "atom",
    capability: "summarize_search",
    secrets: (ctx) => ({
      MOTEBIT_SYNC_URL: ctx.relayUrl,
      // No relay token of any kind: the worker authenticates to the relay AS
      // ITSELF (per-audience signed tokens after a public bootstrap) and admits
      // tasks by verifying the relay-signed dispatch token against this pin.
      // Until 2026-09-15 this map handed the OPERATOR's master token to every
      // worker twice — as MOTEBIT_API_TOKEN and again as MOTEBIT_AUTH_TOKEN.
      MOTEBIT_RELAY_PUBLIC_KEY: ctx.relayPublicKey,
      MOTEBIT_UNIT_COST: "0",
      WEB_SEARCH_URL: ctx.appHost(
        ctx.target === "prod" ? "motebit-web-search" : "motebit-web-search-stg",
      ),
    }),
  },
  {
    name: "research",
    app: (t) => (t === "prod" ? "motebit-research" : "motebit-research-stg"),
    config: (t) => `services/research/${t === "prod" ? "fly.toml" : "fly.staging.toml"}`,
    volume: "research_data",
    kind: "molecule",
    capability: "research",
    secrets: (ctx) => ({
      MOTEBIT_SYNC_URL: ctx.relayUrl,
      // No relay token of any kind: the worker authenticates to the relay AS
      // ITSELF (per-audience signed tokens after a public bootstrap) and admits
      // tasks by verifying the relay-signed dispatch token against this pin.
      // Until 2026-09-15 this map handed the OPERATOR's master token to every
      // worker twice — as MOTEBIT_API_TOKEN and again as MOTEBIT_AUTH_TOKEN.
      MOTEBIT_RELAY_PUBLIC_KEY: ctx.relayPublicKey,
      MOTEBIT_UNIT_COST: "0.25",
      MOTEBIT_SETTLEMENT_MODES: "relay,p2p",
      ANTHROPIC_API_KEY: ctx.env["ANTHROPIC_API_KEY"] ?? "",
      MOTEBIT_WEB_SEARCH_URL: `${ctx.appHost(ctx.target === "prod" ? "motebit-web-search" : "motebit-web-search-stg")}/mcp`,
      MOTEBIT_READ_URL_URL: `${ctx.appHost(ctx.target === "prod" ? "motebit-read-url" : "motebit-read-url-stg")}/mcp`,
      ...(ctx.atomIds.has("web_search")
        ? { MOTEBIT_WEB_SEARCH_TARGET_ID: ctx.atomIds.get("web_search")! }
        : {}),
      ...(ctx.atomIds.has("read_url")
        ? { MOTEBIT_READ_URL_TARGET_ID: ctx.atomIds.get("read_url")! }
        : {}),
    }),
  },
  {
    name: "auditor",
    app: (t) => (t === "prod" ? "motebit-auditor" : "motebit-auditor-stg"),
    config: (t) => `services/auditor/${t === "prod" ? "fly.toml" : "fly.staging.toml"}`,
    volume: "auditor_data",
    kind: "molecule",
    capability: "audit_agent",
    secrets: (ctx) => ({
      MOTEBIT_SYNC_URL: ctx.relayUrl,
      // No relay token of any kind: the worker authenticates to the relay AS
      // ITSELF (per-audience signed tokens after a public bootstrap) and admits
      // tasks by verifying the relay-signed dispatch token against this pin.
      // Until 2026-09-15 this map handed the OPERATOR's master token to every
      // worker twice — as MOTEBIT_API_TOKEN and again as MOTEBIT_AUTH_TOKEN.
      MOTEBIT_RELAY_PUBLIC_KEY: ctx.relayPublicKey,
      MOTEBIT_RELAY_URL: ctx.relayUrl,
      MOTEBIT_UNIT_COST: "0.01",
      MOTEBIT_SETTLEMENT_MODES: "relay,p2p",
    }),
  },
  {
    name: "clerk",
    app: (t) => (t === "prod" ? "motebit-clerk" : "motebit-clerk-stg"),
    config: (t) => `services/clerk/${t === "prod" ? "fly.toml" : "fly.staging.toml"}`,
    volume: "clerk_data",
    kind: "molecule",
    capability: "execute_delegation",
    secrets: (ctx) => ({
      MOTEBIT_SYNC_URL: ctx.relayUrl,
      // No relay token of any kind: the worker authenticates to the relay AS
      // ITSELF (per-audience signed tokens after a public bootstrap) and admits
      // tasks by verifying the relay-signed dispatch token against this pin.
      // Until 2026-09-15 this map handed the OPERATOR's master token to every
      // worker twice — as MOTEBIT_API_TOKEN and again as MOTEBIT_AUTH_TOKEN.
      //
      // ONE key, and it doubles as the clerk's pinned P2P treasury root: the
      // operator's own pin from the deploy environment when set, validated
      // and compared with the relay's served key in `runSlate`, else the key
      // fetched from the relay's well-known descriptor. Until this was
      // collapsed the map set the key twice and the env pass-through
      // (defaulting to "") won, so the fetched key was NEVER staged for the
      // clerk and, without the operator variable, a fresh clerk exited at boot.
      MOTEBIT_RELAY_PUBLIC_KEY: ctx.clerkRelayPublicKey,
      MOTEBIT_UNIT_COST: "0.01",
      MOTEBIT_SETTLEMENT_MODES: "relay,p2p",
      // DRY-RUN-FIRST: the whole metered spine runs at hard-zero (no broadcast,
      // live ceiling untouched). Flipping to live money is a deliberate,
      // ratified operator step — set DRY_RUN=0 out of band, never here.
      DRY_RUN: "1",
      MOTEBIT_CLERK_CEILING_MICRO: ctx.env["MOTEBIT_CLERK_CEILING_MICRO"] ?? "1000000",
      // The sovereign rail (own funds) — passed through from the deploy
      // environment (never hardcoded). Not set ⇒ not staged.
      MOTEBIT_SOLANA_RPC_URL: ctx.env["MOTEBIT_SOLANA_RPC_URL"] ?? "",
    }),
  },
];

interface DiscoveredAgent {
  motebit_id: string;
  endpoint_url: string;
  display_name?: string | null;
  description?: string | null;
  pricing?: unknown;
}

async function discoverByCapability(
  effects: SlateEffects,
  relayUrl: string,
  apiToken: string,
): Promise<Map<string, DiscoveredAgent>> {
  const byCapability = new Map<string, DiscoveredAgent>();
  const res = await effects.fetch(`${relayUrl}/api/v1/agents/discover`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!res.ok) {
    effects.error(`  discover returned ${res.status} — capture skipped`);
    return byCapability;
  }
  const data = (await res.json()) as {
    agents?: Array<DiscoveredAgent & { capabilities: string[] }>;
  };
  for (const agent of data.agents ?? []) {
    for (const cap of agent.capabilities) {
      // Slate apps only — a foreign agent claiming the capability must not
      // become a molecule's pinned target.
      if (agent.endpoint_url.includes(".fly.dev") || agent.endpoint_url.includes("motebit")) {
        if (!byCapability.has(cap)) byCapability.set(cap, agent);
      }
    }
  }
  return byCapability;
}

/**
 * The relay's Ed25519 public key from its well-known descriptor. Every
 * failure names what could not be read and says nothing was deployed: this
 * runs before the first flyctl call.
 */
async function fetchRelayPublicKey(effects: SlateEffects, relayUrl: string): Promise<string> {
  const what = `${new URL(relayUrl).host}/.well-known/motebit.json`;
  const unread = (reason: string, cause?: unknown): Error =>
    new Error(`could not read ${what} (${reason}); nothing was deployed`, { cause });
  let res: Response;
  try {
    res = await effects.fetch(`${relayUrl}/.well-known/motebit.json`);
  } catch (err) {
    // undici's "fetch failed" carries the real reason (ECONNREFUSED, ENOTFOUND) on its cause.
    const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
    const message = err instanceof Error ? err.message : String(err);
    throw unread(typeof code === "string" ? `${message}: ${code}` : message, err);
  }
  if (!res.ok) throw unread(`HTTP ${res.status}`);
  let body: { public_key?: string };
  try {
    body = (await res.json()) as { public_key?: string };
  } catch (err) {
    throw unread("the answer is not JSON", err);
  }
  if (!body.public_key || !RELAY_KEY_FORMAT.test(body.public_key)) {
    throw unread("the descriptor carries no 64-hex public_key");
  }
  return body.public_key;
}

const RECHECK = "npx tsx scripts/check-promotion-ready.ts";

/**
 * The promotion-readiness gate (docs/doctrine/agent-archetypes.md §4), at the
 * one place the slate's promotion happens. Returns the exit code to refuse
 * with, or null to go on.
 *
 *   not a promotion    → no readiness read at all
 *   promotion, dry run → reads and reports; refuses nothing
 *   promotion, real    → refuses unless ready, or unless the override env
 *                        carries a real reason (printed with the result it
 *                        overrode)
 *
 * `promotion` is: TARGET=prod, or a relay that is the production relay.
 */
function gatePromotion(promotion: boolean, run: boolean, effects: SlateEffects): number | null {
  if (!promotion) return null;

  const readiness = readPromotionReadiness({
    required: PROMOTION_REQUIRED_GREEN_RUNS,
    listRuns: effects.listRuns,
    now: effects.now,
  });
  const lines = describePromotionReadiness(readiness);
  const overrideRaw = effects.env[PROMOTION_READINESS_OVERRIDE_ENV];
  const overrideReason = overrideReasonOf(overrideRaw);
  const notAReason =
    overrideRaw !== undefined && overrideReason === null
      ? `${PROMOTION_READINESS_OVERRIDE_ENV} is set but is not a reason, so it overrides nothing: it needs at least ${OVERRIDE_REASON_MIN_LENGTH} characters saying why, and ${OVERRIDE_NOT_A_REASON.map((v) => `"${v}"`).join(" / ")} are not reasons.`
      : null;

  if (readiness.ready) {
    effects.log("promotion readiness:");
    for (const line of lines) effects.log(`  ${line}`);
    if (overrideReason !== null) {
      effects.log(
        `  ${PROMOTION_READINESS_OVERRIDE_ENV} is set (${overrideReason}) but overrides nothing: readiness is green.`,
      );
    }
    return null;
  }

  if (!run) {
    effects.log("promotion readiness (dry run: reported, nothing refused):");
    for (const line of lines) effects.log(`  ${line}`);
    if (notAReason !== null) effects.log(`  ${notAReason}`);
    effects.log(
      overrideReason !== null
        ? `  A real run would PROCEED on ${PROMOTION_READINESS_OVERRIDE_ENV} (${overrideReason}), overriding the result above.`
        : `  A real run (RUN=1) would REFUSE here, before any flyctl call. Re-check with: ${RECHECK}`,
    );
    return null;
  }

  if (overrideReason !== null) {
    effects.error("!!! PROMOTION READINESS OVERRIDDEN !!!");
    effects.error(`!!! reason (${PROMOTION_READINESS_OVERRIDE_ENV}): ${overrideReason}`);
    effects.error("!!! the readiness result this run overrides:");
    for (const line of lines) effects.error(`!!!   ${line}`);
    effects.error(
      "!!! proceeding past the readiness check only: the override does not replace the operator's relay-key pin (MOTEBIT_RELAY_PUBLIC_KEY), which is checked next.",
    );
    return null;
  }

  effects.error("REFUSED: the archetype slate is not ready for production. Nothing was deployed.");
  for (const line of lines) effects.error(`  ${line}`);
  if (notAReason !== null) effects.error(`  ${notAReason}`);
  effects.error(
    `Fix: promotion needs the newest ${PROMOTION_REQUIRED_GREEN_RUNS} SCHEDULED runs of archetype-conformance.yml all green, each a first attempt on main, the newest at most ${PROMOTION_MAX_NEWEST_RUN_AGE_HOURS} hours old and no two more than ${PROMOTION_MAX_RUN_GAP_HOURS} hours apart (docs/doctrine/agent-archetypes.md §4). ` +
      `${promotionRepair(readiness)}, re-check with: ${RECHECK}, then re-run this command. ` +
      `Emergency only: ${PROMOTION_READINESS_OVERRIDE_ENV}="<why, at least ${OVERRIDE_REASON_MIN_LENGTH} characters>" proceeds and prints the reason with the result it overrode; an empty or flag-like value (${OVERRIDE_NOT_A_REASON.join(", ")}) does not. The override does not replace the operator's relay-key pin: a promotion still needs MOTEBIT_RELAY_PUBLIC_KEY.`,
  );
  return 1;
}

/** The ceremony. Returns the process exit code. */
export async function runSlate(effects: SlateEffects): Promise<number> {
  const { env } = effects;
  // TARGET is exact. `PROD`, `prod ` or an empty value used to fall through
  // to staging without a word.
  const rawTarget = env["TARGET"];
  if (rawTarget !== undefined && rawTarget !== "staging" && rawTarget !== "prod") {
    effects.error(
      `REFUSED: TARGET=${JSON.stringify(rawTarget)} is not a target. Nothing was deployed. Fix: leave TARGET unset or set TARGET=staging for the -stg apps, or TARGET=prod for production (exact, lower case, no spaces).`,
    );
    return 1;
  }
  const target: Target = rawTarget === "prod" ? "prod" : "staging";
  const run = env["RUN"] === "1";
  const relayUrl = env["RELAY_URL"] ?? (target === "prod" ? PROD_RELAY_URL : STAGING_RELAY_URL);
  const host = relayHost(relayUrl);
  if (host === null) {
    effects.error(
      `REFUSED: RELAY_URL=${JSON.stringify(relayUrl)} is not an http(s) URL. Nothing was deployed. Fix: unset RELAY_URL for the target's own relay, or set it to an absolute URL that starts with https:// (a bare host or host:port is not one).`,
    );
    return 1;
  }
  // Staging apps joined to the production relay are a production promotion.
  const prodRelay = PROD_RELAY_HOSTS.includes(host);
  const promotion = target === "prod" || prodRelay;

  const RELAY_KEY_ARG = "MOTEBIT_RELAY_PUBLIC_KEY=";
  const sh = (cmd: string, args: string[]): string => {
    if (!run) {
      // On a promotion the relay key is not a value to copy from this output
      // (the operator's pin comes from out of band), so a dry run shows only
      // its ends. A staging dry run prints it as before.
      const shown = args.map((arg) =>
        promotion && arg.startsWith(RELAY_KEY_ARG)
          ? `${RELAY_KEY_ARG}${keyEnds(arg.slice(RELAY_KEY_ARG.length))}`
          : arg,
      );
      effects.log(`  [dry-run] ${cmd} ${shown.join(" ")}`);
      return "";
    }
    return effects.exec(cmd, args);
  };
  const flyAppExists = (app: string): boolean => {
    if (!run) return false;
    try {
      effects.exec("flyctl", ["status", "-a", app], { quiet: true });
      return true;
    } catch {
      return false;
    }
  };

  const apiToken = env["MOTEBIT_API_TOKEN"] ?? "";
  effects.log(
    `deploy-archetype-slate — target=${target} relay=${relayUrl} ${run ? "LIVE" : "DRY RUN (set RUN=1 to execute)"}`,
  );

  // Before anything else touches the world: no flyctl call, no secret staged
  // and no relay read happens on a prod run the readiness gate refuses.
  if (target !== "prod" && prodRelay) {
    effects.log(
      `relay ${relayUrl} is the PRODUCTION relay: joining the ${target} apps to it is gated as a production promotion.`,
    );
  }
  const refusal = gatePromotion(promotion, run, effects);
  if (refusal !== null) return refusal;

  if (run && apiToken === "") {
    effects.error("MOTEBIT_API_TOKEN is required for a live run (relay registration).");
    return 1;
  }
  if (run && env["ANTHROPIC_API_KEY"] == null) {
    effects.error("ANTHROPIC_API_KEY is required for a live run (research inference).");
    return 1;
  }

  const relayPublicKey = await fetchRelayPublicKey(effects, relayUrl);
  // On a promotion the fetched key is a cross-check for the operator's pin,
  // so only its ends are shown: this line is not where the pin comes from.
  effects.log(
    `relay public key, fetched from the relay's well-known descriptor (trust on first use: it is served by the relay it pins; staged as the task-admission key for every worker; the clerk's key is named on the next line): ${promotion ? `${keyEnds(relayPublicKey)} (first and last 8 characters only on a promotion: a cross-check, not a value to copy)` : relayPublicKey}`,
  );

  // The clerk's key is its payment trust root. The OPERATOR's key is the pin;
  // the fetched key is a convenience and a cross-check, because it comes from
  // the very relay it would pin. So a promotion needs the operator's key, and
  // only a staging run may fall back to the fetched one. Whitespace-only is
  // unset, and the value is compared lower-cased. Nothing has been deployed
  // or staged yet.
  const operatorPin = (env["MOTEBIT_RELAY_PUBLIC_KEY"] ?? "").trim().toLowerCase();
  const pinRequired = promotion;
  let clerkRelayPublicKey = relayPublicKey;
  if (operatorPin === "") {
    if (pinRequired) {
      const missing = `a production promotion needs the clerk's relay key pinned by the operator, and MOTEBIT_RELAY_PUBLIC_KEY is not set. The key the relay ${relayUrl} serves (${keyEnds(relayPublicKey)}, shown only for comparison) is trust on first use, not a pin`;
      if (run) {
        effects.error(
          `REFUSED: ${missing}. Nothing was deployed. Fix: export MOTEBIT_RELAY_PUBLIC_KEY=<the production relay's 64-hex public key, obtained out of band, not from this run's output>, then re-run this command.`,
        );
        return 1;
      }
      effects.error(
        `!!! WARNING: ${missing}. A real run (RUN=1) would REFUSE here, before any flyctl call.`,
      );
    } else {
      effects.log(
        "clerk's relay key: the key above, fetched from the relay (trust on first use), not an operator pin (MOTEBIT_RELAY_PUBLIC_KEY is not set).",
      );
    }
  } else {
    if (!RELAY_KEY_FORMAT.test(operatorPin)) {
      // The value is not echoed: a variable holding the wrong thing may hold a secret.
      effects.error(
        `REFUSED: MOTEBIT_RELAY_PUBLIC_KEY is set but is not a relay public key (64 hex characters; got ${operatorPin.length} characters). Nothing was deployed. Fix: ${
          promotion
            ? "set MOTEBIT_RELAY_PUBLIC_KEY to the production relay's 64-hex key, obtained out of band."
            : `unset it to stage the clerk the key the relay serves (${keyEnds(relayPublicKey)}), or set it to that relay's 64-hex Ed25519 public key.`
        }`,
      );
      return 1;
    }
    if (operatorPin === relayPublicKey) {
      effects.log(
        "clerk's relay key: the operator's MOTEBIT_RELAY_PUBLIC_KEY, which matches the fetched key above.",
      );
    } else {
      const disagree = `the operator's pin MOTEBIT_RELAY_PUBLIC_KEY (${keyEnds(operatorPin)}) and the key the relay ${relayUrl} serves (${keyEnds(relayPublicKey)}) disagree`;
      if (promotion && run) {
        effects.error(
          `REFUSED: ${disagree}. Nothing was deployed. The clerk would pin its payments to a key this relay does not hold. Do not deploy until one is corrected. Fix: if the pin is stale (a staging key left in the shell), set MOTEBIT_RELAY_PUBLIC_KEY to the production relay's 64-hex key, obtained out of band; if the relay is serving the wrong key, stop and find out why.`,
        );
        return 1;
      }
      const consequence = promotion
        ? "A real run (RUN=1) would REFUSE here, before any flyctl call."
        : "This is not a production promotion, so the run PROCEEDS and stages the clerk the OPERATOR's pin; every other worker gets the fetched key.";
      effects.error(`!!! WARNING: ${disagree}. ${consequence}`);
    }
    clerkRelayPublicKey = operatorPin;
  }

  const ctx: SecretContext = {
    target,
    env,
    relayUrl,
    apiToken,
    relayPublicKey,
    clerkRelayPublicKey,
    atomIds: new Map(),
    appHost: (app) => `https://${app}.fly.dev`,
  };

  const phases: Array<"atom" | "molecule"> = ["atom", "molecule"];
  for (const phase of phases) {
    effects.log(`\n=== ${phase}s ===`);
    for (const svc of SLATE.filter((s) => s.kind === phase)) {
      const app = svc.app(target);
      effects.log(`\n▸ ${svc.name} → ${app}`);

      if (!flyAppExists(app)) {
        sh("flyctl", ["apps", "create", app, "--org", "personal"]);
        sh("flyctl", [
          "volumes",
          "create",
          svc.volume,
          "-a",
          app,
          "--region",
          REGION,
          "--size",
          "1",
          "--yes",
        ]);
      } else {
        effects.log("  app exists — skipping create");
      }

      const secrets = svc.secrets(ctx);
      const pairs = Object.entries(secrets)
        .filter(([, v]) => v !== "")
        .map(([k, v]) => `${k}=${v}`);
      if (pairs.length > 0) {
        // --stage: applied by the deploy that follows, not a separate restart.
        sh("flyctl", ["secrets", "set", "--stage", "-a", app, ...pairs]);
      }
      const publicUrl = ctx.appHost(app);
      sh("flyctl", ["secrets", "set", "--stage", "-a", app, `MOTEBIT_PUBLIC_URL=${publicUrl}`]);

      sh("flyctl", ["deploy", "--config", svc.config(target), "-a", app, "--remote-only"]);
    }

    if (phase === "atom" && run) {
      // Give registrations a moment, then capture atom ids for molecule wiring.
      effects.log("\ncapturing atom motebit_ids from the relay…");
      await effects.sleep(15_000);
      const found = await discoverByCapability(effects, relayUrl, apiToken);
      for (const cap of ["web_search", "read_url", "summarize_search"]) {
        const agent = found.get(cap);
        if (agent) {
          ctx.atomIds.set(cap, agent.motebit_id);
          effects.log(`  ${cap} → ${agent.motebit_id}`);
        } else {
          effects.log(`  ${cap} → NOT FOUND (molecule target secret skipped)`);
        }
      }
    }
  }

  // === Final verification table ===
  if (run) {
    effects.log("\n=== slate verification (relay discover) ===");
    const found = await discoverByCapability(effects, relayUrl, apiToken);
    const rows = SLATE.map((svc) => {
      const agent = found.get(svc.capability);
      return {
        service: svc.name,
        capability: svc.capability,
        discovered: agent != null ? "yes" : "NO",
        display_name: agent?.display_name ?? "—",
        description: (agent?.description ?? "—").slice(0, 48),
        pricing: agent?.pricing != null ? "listed" : "—",
      };
    });
    effects.table(rows);
    const missing = rows.filter((r) => r.discovered === "NO");
    if (missing.length > 0) {
      effects.error(`\n${missing.length} slate service(s) not discoverable — inspect fly logs.`);
      return 1;
    }
    effects.log("\nSlate live. Next: scripts/archetype-conformance.ts exercises it end-to-end.");
  } else {
    effects.log(
      "\nDry run complete. Set RUN=1 (and MOTEBIT_API_TOKEN, ANTHROPIC_API_KEY; a production promotion also needs MOTEBIT_RELAY_PUBLIC_KEY, the production relay's key obtained out of band) to execute.",
    );
  }
  return 0;
}

/** The real effects: this process's env, `execFileSync`, global fetch, the console. */
export function realEffects(): SlateEffects {
  return {
    env: process.env,
    exec: (cmd, args, opts) =>
      execFileSync(cmd, args, {
        encoding: "utf8",
        // A generic command runner: no child inherits a hook's GIT_* variables.
        env: cleanEnv(),
        stdio: opts?.quiet === true ? "ignore" : ["ignore", "pipe", "inherit"],
      }) ?? "",
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    table: (rows) => console.table(rows),
  };
}

if (isProgramEntry(import.meta.url)) {
  runSlate(realEffects()).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
