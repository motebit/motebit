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
 *              (prod promotion is gated on check-promotion-ready — 5
 *               consecutive green scheduled conformance runs)
 *
 * Required env (real run):
 *   MOTEBIT_API_TOKEN        registration token for the target relay
 *   ANTHROPIC_API_KEY        research only (operator-funded inference)
 * Optional:
 *   RELAY_URL                override the target relay base URL
 *
 * Economics posture (agent-archetypes.md §5): atoms run at unit_cost 0
 * (zero-cost carve-out — the delegation chain is relay-visible and
 * receipted, nothing settles until the multi-hop settlement arc);
 * molecules are priced (research $0.50 incl. operator inference, auditor
 * $0.05 LLM-free) and settle P2P-at-top-of-chain.
 */

import { execFileSync } from "node:child_process";

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
  relayUrl: string;
  apiToken: string;
  /** capability → motebit_id captured from the relay after atom deploys. */
  atomIds: Map<string, string>;
  appHost: (app: string) => string;
}

const TARGET: Target = process.env["TARGET"] === "prod" ? "prod" : "staging";
const RUN = process.env["RUN"] === "1";
const RELAY_URL =
  process.env["RELAY_URL"] ??
  (TARGET === "prod" ? "https://relay.motebit.com" : "https://motebit-sync-stg.fly.dev");
const REGION = "sjc";

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
      MOTEBIT_API_TOKEN: ctx.apiToken,
      MOTEBIT_UNIT_COST: "0",
      BRAVE_API_KEY: process.env["BRAVE_API_KEY"] ?? "",
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
      MOTEBIT_API_TOKEN: ctx.apiToken,
      MOTEBIT_UNIT_COST: "0",
    }),
  },
  {
    name: "summarize",
    app: (t) => (t === "prod" ? "motebit-summarize" : "motebit-summarize-stg"),
    config: (t) => `services/summarize/${t === "prod" ? "fly.toml" : "fly.staging.toml"}`,
    volume: "summarize_data",
    kind: "atom",
    capability: "summarize",
    secrets: (ctx) => ({
      MOTEBIT_SYNC_URL: ctx.relayUrl,
      MOTEBIT_API_TOKEN: ctx.apiToken,
      MOTEBIT_UNIT_COST: "0",
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
      MOTEBIT_API_TOKEN: ctx.apiToken,
      MOTEBIT_UNIT_COST: "0.50",
      MOTEBIT_SETTLEMENT_MODES: "relay,p2p",
      ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"] ?? "",
      MOTEBIT_WEB_SEARCH_URL: `${ctx.appHost(TARGET === "prod" ? "motebit-web-search" : "motebit-web-search-stg")}/mcp`,
      MOTEBIT_READ_URL_URL: `${ctx.appHost(TARGET === "prod" ? "motebit-read-url" : "motebit-read-url-stg")}/mcp`,
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
      MOTEBIT_API_TOKEN: ctx.apiToken,
      MOTEBIT_RELAY_URL: ctx.relayUrl,
      MOTEBIT_UNIT_COST: "0.05",
      MOTEBIT_SETTLEMENT_MODES: "relay,p2p",
    }),
  },
];

function sh(cmd: string, args: string[]): string {
  if (!RUN) {
    console.log(`  [dry-run] ${cmd} ${args.join(" ")}`);
    return "";
  }
  return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

function flyAppExists(app: string): boolean {
  if (!RUN) return false;
  try {
    execFileSync("flyctl", ["status", "-a", app], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

async function discoverByCapability(
  relayUrl: string,
  apiToken: string,
): Promise<
  Map<
    string,
    {
      motebit_id: string;
      endpoint_url: string;
      display_name?: string | null;
      description?: string | null;
      pricing?: unknown;
    }
  >
> {
  const byCapability = new Map<
    string,
    {
      motebit_id: string;
      endpoint_url: string;
      display_name?: string | null;
      description?: string | null;
      pricing?: unknown;
    }
  >();
  const res = await fetch(`${relayUrl}/api/v1/agents/discover`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!res.ok) {
    console.error(`  discover returned ${res.status} — capture skipped`);
    return byCapability;
  }
  const data = (await res.json()) as {
    agents?: Array<{
      motebit_id: string;
      endpoint_url: string;
      capabilities: string[];
      display_name?: string | null;
      description?: string | null;
      pricing?: unknown;
    }>;
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

async function main(): Promise<void> {
  const apiToken = process.env["MOTEBIT_API_TOKEN"] ?? "";
  console.log(
    `deploy-archetype-slate — target=${TARGET} relay=${RELAY_URL} ${RUN ? "LIVE" : "DRY RUN (set RUN=1 to execute)"}`,
  );
  if (RUN && apiToken === "") {
    console.error("MOTEBIT_API_TOKEN is required for a live run (relay registration).");
    process.exit(1);
  }
  if (RUN && process.env["ANTHROPIC_API_KEY"] == null) {
    console.error("ANTHROPIC_API_KEY is required for a live run (research inference).");
    process.exit(1);
  }

  const ctx: SecretContext = {
    relayUrl: RELAY_URL,
    apiToken,
    atomIds: new Map(),
    appHost: (app) => `https://${app}.fly.dev`,
  };

  const phases: Array<"atom" | "molecule"> = ["atom", "molecule"];
  for (const phase of phases) {
    console.log(`\n=== ${phase}s ===`);
    for (const svc of SLATE.filter((s) => s.kind === phase)) {
      const app = svc.app(TARGET);
      console.log(`\n▸ ${svc.name} → ${app}`);

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
        console.log("  app exists — skipping create");
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

      sh("flyctl", ["deploy", "--config", svc.config(TARGET), "-a", app, "--remote-only"]);
    }

    if (phase === "atom" && RUN) {
      // Give registrations a moment, then capture atom ids for molecule wiring.
      console.log("\ncapturing atom motebit_ids from the relay…");
      await new Promise((r) => setTimeout(r, 15_000));
      const found = await discoverByCapability(RELAY_URL, apiToken);
      for (const cap of ["web_search", "read_url", "summarize"]) {
        const agent = found.get(cap);
        if (agent) {
          ctx.atomIds.set(cap, agent.motebit_id);
          console.log(`  ${cap} → ${agent.motebit_id}`);
        } else {
          console.log(`  ${cap} → NOT FOUND (molecule target secret skipped)`);
        }
      }
    }
  }

  // === Final verification table ===
  if (RUN) {
    console.log("\n=== slate verification (relay discover) ===");
    const found = await discoverByCapability(RELAY_URL, apiToken);
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
    console.table(rows);
    const missing = rows.filter((r) => r.discovered === "NO");
    if (missing.length > 0) {
      console.error(`\n${missing.length} slate service(s) not discoverable — inspect fly logs.`);
      process.exit(1);
    }
    console.log("\nSlate live. Next: scripts/archetype-conformance.ts exercises it end-to-end.");
  } else {
    console.log(
      "\nDry run complete. Set RUN=1 (and MOTEBIT_API_TOKEN, ANTHROPIC_API_KEY) to execute.",
    );
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
