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
 *   PROD:      RUN=1 TARGET=prod npx tsx scripts/deploy-archetype-slate.ts
 *
 * PROMOTION READINESS (docs/doctrine/agent-archetypes.md §4). A real prod run
 * (RUN=1 and TARGET=prod) reads the conformance workflow's scheduled-run
 * history (scripts/check-promotion-ready.ts, `readPromotionReadiness`: the
 * last 5 scheduled runs of archetype-conformance.yml all concluded success)
 * BEFORE its first flyctl call, and REFUSES (exit 1, nothing deployed, no
 * secret staged) unless ready. Unreadable history (gh missing,
 * unauthenticated, erroring) refuses. A prod dry run reports the readiness
 * and refuses nothing. Staging never reads it.
 *
 *   OVERRIDE:  PROMOTION_READINESS_OVERRIDE_REASON="<why>" RUN=1 TARGET=prod …
 *              The only bypass. The value must be a non-empty reason (empty
 *              or whitespace does not override); the run prints the reason
 *              and the readiness result it overrode, then proceeds. Nothing
 *              records it beyond this run's output.
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
 * Optional:
 *   RELAY_URL                override the target relay base URL
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
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PROMOTION_REQUIRED_GREEN_RUNS,
  describePromotionReadiness,
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
  /** capability → motebit_id captured from the relay after atom deploys. */
  atomIds: Map<string, string>;
  appHost: (app: string) => string;
}

const REGION = "sjc";

/**
 * The one bypass of the promotion-readiness refusal: a non-empty human
 * reason. Empty or whitespace does not override.
 */
export const PROMOTION_READINESS_OVERRIDE_ENV = "PROMOTION_READINESS_OVERRIDE_REASON";

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
      MOTEBIT_RELAY_PUBLIC_KEY: ctx.relayPublicKey,
      MOTEBIT_UNIT_COST: "0.01",
      MOTEBIT_SETTLEMENT_MODES: "relay,p2p",
      // DRY-RUN-FIRST: the whole metered spine runs at hard-zero (no broadcast,
      // live ceiling untouched). Flipping to live money is a deliberate,
      // ratified operator step — set DRY_RUN=0 out of band, never here.
      DRY_RUN: "1",
      MOTEBIT_CLERK_CEILING_MICRO: ctx.env["MOTEBIT_CLERK_CEILING_MICRO"] ?? "1000000",
      // The sovereign rail (own funds) + the PINNED relay treasury root —
      // passed through from the deploy environment (never hardcoded).
      MOTEBIT_SOLANA_RPC_URL: ctx.env["MOTEBIT_SOLANA_RPC_URL"] ?? "",
      MOTEBIT_RELAY_PUBLIC_KEY: ctx.env["MOTEBIT_RELAY_PUBLIC_KEY"] ?? "",
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

/** The relay's Ed25519 public key from its well-known descriptor — pinned into every worker. */
async function fetchRelayPublicKey(effects: SlateEffects, relayUrl: string): Promise<string> {
  const res = await effects.fetch(`${relayUrl}/.well-known/motebit.json`);
  if (!res.ok) throw new Error(`well-known fetch failed: ${res.status}`);
  const body = (await res.json()) as { public_key?: string };
  if (!body.public_key || !/^[0-9a-f]{64}$/.test(body.public_key)) {
    throw new Error("well-known descriptor carries no 64-hex public_key");
  }
  return body.public_key;
}

const RECHECK = "npx tsx scripts/check-promotion-ready.ts";

/**
 * The promotion-readiness gate (docs/doctrine/agent-archetypes.md §4), at the
 * one place the slate's promotion happens. Returns the exit code to refuse
 * with, or null to go on.
 *
 *   staging            → no readiness read at all
 *   prod, dry run      → reads and reports; refuses nothing
 *   prod, real run     → refuses unless ready, or unless the override env
 *                        carries a non-empty reason (printed with the result
 *                        it overrode)
 */
function gatePromotion(target: Target, run: boolean, effects: SlateEffects): number | null {
  if (target !== "prod") return null;

  const readiness = readPromotionReadiness({
    required: PROMOTION_REQUIRED_GREEN_RUNS,
    listRuns: effects.listRuns,
  });
  const lines = describePromotionReadiness(readiness);
  const overrideReason = (effects.env[PROMOTION_READINESS_OVERRIDE_ENV] ?? "").trim();
  const overridden = overrideReason !== "";

  if (readiness.ready) {
    effects.log("promotion readiness:");
    for (const line of lines) effects.log(`  ${line}`);
    if (overridden) {
      effects.log(
        `  ${PROMOTION_READINESS_OVERRIDE_ENV} is set (${overrideReason}) but overrides nothing: readiness is green.`,
      );
    }
    return null;
  }

  if (!run) {
    effects.log("promotion readiness (dry run: reported, nothing refused):");
    for (const line of lines) effects.log(`  ${line}`);
    effects.log(
      overridden
        ? `  A real prod run would PROCEED on ${PROMOTION_READINESS_OVERRIDE_ENV} (${overrideReason}), overriding the result above.`
        : `  A real prod run (RUN=1 TARGET=prod) would REFUSE here, before any flyctl call. Re-check with: ${RECHECK}`,
    );
    return null;
  }

  if (overridden) {
    effects.error("!!! PROMOTION READINESS OVERRIDDEN !!!");
    effects.error(`!!! reason (${PROMOTION_READINESS_OVERRIDE_ENV}): ${overrideReason}`);
    effects.error("!!! the readiness result this run overrides:");
    for (const line of lines) effects.error(`!!!   ${line}`);
    effects.error("!!! proceeding with the prod deploy.");
    return null;
  }

  effects.error("REFUSED: the archetype slate is not ready for production. Nothing was deployed.");
  for (const line of lines) effects.error(`  ${line}`);
  effects.error(
    `Fix: promotion needs the last ${PROMOTION_REQUIRED_GREEN_RUNS} SCHEDULED runs of archetype-conformance.yml all green (docs/doctrine/agent-archetypes.md §4). ` +
      (readiness.reason === "gh-unreadable"
        ? "Install and authenticate gh (`gh auth status`) so the history can be read"
        : readiness.reason === "thin-history"
          ? "Wait for the daily schedule to put enough runs on record (manual dispatches do not count)"
          : "Fix what the runs listed above caught, then wait for the daily schedule to turn the window green (manual dispatches do not count)") +
      `, re-check with: ${RECHECK}, then re-run this command. ` +
      `Emergency only: ${PROMOTION_READINESS_OVERRIDE_ENV}="<why>" proceeds and prints the reason with the result it overrode; an empty value does not.`,
  );
  return 1;
}

/** The ceremony. Returns the process exit code. */
export async function runSlate(effects: SlateEffects): Promise<number> {
  const { env } = effects;
  const target: Target = env["TARGET"] === "prod" ? "prod" : "staging";
  const run = env["RUN"] === "1";
  const relayUrl =
    env["RELAY_URL"] ??
    (target === "prod" ? "https://relay.motebit.com" : "https://motebit-sync-stg.fly.dev");

  const sh = (cmd: string, args: string[]): string => {
    if (!run) {
      effects.log(`  [dry-run] ${cmd} ${args.join(" ")}`);
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
  const refusal = gatePromotion(target, run, effects);
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
  effects.log(`relay public key (task-admission pin for every worker): ${relayPublicKey}`);
  const ctx: SecretContext = {
    target,
    env,
    relayUrl,
    apiToken,
    relayPublicKey,
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
      "\nDry run complete. Set RUN=1 (and MOTEBIT_API_TOKEN, ANTHROPIC_API_KEY) to execute.",
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

/** True when this file is the program being run, not a module a test imported. */
function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  runSlate(realEffects()).then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
