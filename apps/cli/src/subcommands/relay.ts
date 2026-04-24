/**
 * `motebit relay up` — the sovereignty-endgame one-liner.
 *
 *   npm install -g motebit
 *   motebit relay up
 *   # relay listening on http://localhost:3000
 *
 * The wrapper is intentionally thin. All relay semantics live in
 * `@motebit/api` (`createSyncRelay`) — identity, persistence, federation,
 * rails, websockets. This command assembles a `SyncRelayConfig` from CLI
 * flags + env, binds Hono via `@hono/node-server`, and installs graceful
 * shutdown. The doctrine below nails the five choices that are not in
 * the primitive and would otherwise drift — committed here so every
 * future reader can trace them without reconstructing the thread.
 *
 * ## Design answers (the five questions)
 *
 * 1. **Relay identity lifecycle.** `createSyncRelay` auto-generates an
 *    Ed25519 keypair on first boot and persists it in the
 *    `relay_identity` SQLite row (see `services/api/src/federation.ts`
 *    `initRelayIdentity`). Stable across restarts. We add nothing —
 *    no separate key file, no mnemonic, no "print once" ritual. The
 *    key lives in the DB row; backup guidance is `cp <db> <backup>`,
 *    not "write down twelve words." Encryption at rest is tri-modal:
 *    `MOTEBIT_RELAY_KEY_PASSPHRASE` env (unattended), `--passphrase`
 *    flag (interactive prompt via the existing `promptPassphrase`),
 *    or plaintext (loud boot banner names the exposure).
 *
 * 2. **x402.payToAddress.** Honest degradation, not placeholder and
 *    not hard-fail. The rail is silently non-registered if
 *    `payToAddress` is falsy (services/api index.ts:371). We preserve
 *    that: no flag → relay boots, x402 rail disabled, banner names it.
 *    A burn-address placeholder would write the check the protocol
 *    can't cash. A hard `--wallet`-required failure would kill the
 *    "install → up → running" promise. Everything else (identity,
 *    sync, pairing, federation, free tasks) works unconditionally.
 *
 * 3. **Federation default.** Isolated. Matches the standalone boot
 *    (services/api index.ts:1360 — federation is gated on
 *    `MOTEBIT_FEDERATION_ENDPOINT_URL`). A relay that peered with
 *    `relay.motebit.com` by default would announce the user's public
 *    key to our server without asking. Sovereignty doctrine says:
 *    yours, unannounced, until you opt in. `--federation-url <url>`
 *    enables federation by announcing this relay at the given public
 *    URL; post-boot peering is via the existing
 *    `motebit federation peer <url>` command.
 *
 * 4. **Storage.** Native `better-sqlite3` — per services/api
 *    CLAUDE.md rule 13 the relay is durability-sensitive and the
 *    silent sql.js fallback is forbidden. Default path
 *    `~/.motebit/relay/relay.db` (a new subdir, isolated from the
 *    CLI-agent's own `~/.motebit/motebit.db`). Schema creation is
 *    idempotent inside `createSyncRelay`; no CLI-side migration
 *    layer. `--db-path` / `MOTEBIT_RELAY_DB_PATH` override.
 *
 * 5. **Post-boot config.** Boot-time flags only. No `peer / logs /
 *    freeze / status` subcommands in V1 — they'd need primitives
 *    (log journal, runtime admin API) that don't exist, and shipping
 *    half the control plane is worse than shipping none. The relay
 *    is a 12-factor daemon: flags in, signals out, logs on stdout.
 *    `motebit federation peer <url>` already exists for post-boot
 *    peering.
 */

import * as fs from "node:fs";
import { serve } from "@hono/node-server";
import { createSyncRelay, type SyncRelayConfig } from "@motebit/api";
import type { CliConfig } from "../args.js";
import { RELAY_DIR, RELAY_DB_PATH } from "../config.js";
import { promptPassphrase } from "../identity.js";
import { bold, dim, cyan, success } from "../colors.js";

const DEFAULT_PORT = 3000;
const DEFAULT_NETWORK = "eip155:84532"; // Base Sepolia (testnet)
const SHUTDOWN_TIMEOUT_MS = 30_000;

/**
 * Resolved CLI options for `motebit relay up`. Extracted so the pure
 * config assembler `buildRelayConfig` can be unit-tested without
 * touching `process.env`, the filesystem, or `CliConfig`.
 */
export interface RelayCliOptions {
  port: number;
  dbPath: string;
  payToAddress: string | undefined;
  network: string;
  facilitatorUrl: string | undefined;
  federationUrl: string | undefined;
  passphrase: string | undefined;
  corsOrigin: string;
}

/**
 * Pure mapping from resolved CLI options to `SyncRelayConfig`. No IO,
 * no env reads, no prompts. Exported for tests.
 *
 * - `x402.payToAddress` defaults to `""` so the relay's
 *   truthy-check at the rail-registration site (services/api
 *   index.ts:371) skips registration without throwing — that's the
 *   honest-degradation path from design-answer #2.
 * - `federation` is `undefined` unless a federation URL was given —
 *   matches the standalone boot's gating on
 *   `MOTEBIT_FEDERATION_ENDPOINT_URL`.
 * - `testnet` is inferred from the network: Base Sepolia
 *   (`eip155:84532`) and Arbitrum Sepolia (`eip155:421614`) are the
 *   two testnets we recognize; anything else is treated as mainnet.
 */
export function buildRelayConfig(opts: RelayCliOptions): SyncRelayConfig {
  return {
    dbPath: opts.dbPath,
    corsOrigin: opts.corsOrigin,
    x402: {
      payToAddress: opts.payToAddress ?? "",
      network: opts.network,
      facilitatorUrl: opts.facilitatorUrl,
      testnet: isTestnetNetwork(opts.network),
    },
    relayKeyPassphrase: opts.passphrase,
    federation:
      opts.federationUrl != null && opts.federationUrl !== ""
        ? {
            endpointUrl: opts.federationUrl,
            enabled: true,
          }
        : undefined,
  };
}

export function isTestnetNetwork(network: string): boolean {
  return network === "eip155:84532" || network === "eip155:421614";
}

/**
 * Resolve the relay DB path — flag > env > `RELAY_DB_PATH`
 * (`~/.motebit/relay/relay.db`, derived from `CONFIG_DIR` in
 * `../config.ts`). Creates the parent directory if missing.
 * The default lives in `config.ts` alongside `CONFIG_DIR` /
 * `CONFIG_PATH` so every `~/.motebit/*` path has one declaration site
 * — `storage_key_conventions` applies.
 */
export function resolveRelayDbPath(override: string | undefined): string {
  if (override != null && override !== "") return override;
  const envPath = process.env["MOTEBIT_RELAY_DB_PATH"];
  if (envPath != null && envPath !== "") return envPath;
  fs.mkdirSync(RELAY_DIR, { recursive: true });
  return RELAY_DB_PATH;
}

async function resolveOptions(config: CliConfig): Promise<RelayCliOptions> {
  const port = parsePort(config.port) ?? DEFAULT_PORT;
  const dbPath = resolveRelayDbPath(config.dbPath);
  const payToAddress = config.payToAddress ?? process.env["X402_PAY_TO_ADDRESS"];
  const network = config.network ?? process.env["X402_NETWORK"] ?? DEFAULT_NETWORK;
  const facilitatorUrl = config.facilitatorUrl ?? process.env["X402_FACILITATOR_URL"];
  const federationUrl = config.federationUrl ?? process.env["MOTEBIT_FEDERATION_ENDPOINT_URL"];
  const corsOrigin = process.env["MOTEBIT_CORS_ORIGIN"] ?? "*";

  // Passphrase resolution: env wins (unattended boot); --passphrase flag
  // triggers an interactive prompt (TTY or piped); absent both = plaintext.
  let passphrase: string | undefined = process.env["MOTEBIT_RELAY_KEY_PASSPHRASE"];
  if ((passphrase == null || passphrase === "") && config.passphrase === true) {
    passphrase = await promptPassphrase("Relay key passphrase: ");
    if (passphrase === "") passphrase = undefined;
  }

  return {
    port,
    dbPath,
    payToAddress: payToAddress === "" ? undefined : payToAddress,
    network,
    facilitatorUrl: facilitatorUrl === "" ? undefined : facilitatorUrl,
    federationUrl: federationUrl === "" ? undefined : federationUrl,
    passphrase,
    corsOrigin,
  };
}

function parsePort(raw: string | undefined): number | undefined {
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Invalid --port "${raw}" — must be an integer in [1, 65535].`);
  }
  return n;
}

/**
 * Human-readable boot banner. Prints before `createSyncRelay` so the
 * user can see the chosen paths even if schema creation takes a
 * moment. Honest about what is active vs. disabled.
 */
function printStartBanner(opts: RelayCliOptions): void {
  console.log();
  console.log(`  ${bold("motebit relay up")}`);
  console.log(`  ${dim("—")} port     ${String(opts.port)}`);
  console.log(`  ${dim("—")} db       ${opts.dbPath}`);
  console.log(
    `  ${dim("—")} network  ${opts.network}${isTestnetNetwork(opts.network) ? dim(" (testnet)") : ""}`,
  );
  if (opts.payToAddress != null) {
    console.log(`  ${dim("—")} x402     ${success("enabled")} → ${opts.payToAddress}`);
  } else {
    console.log(
      `  ${dim("—")} x402     ${dim("disabled")} ${dim("(pass --pay-to-address 0x… to enable paid task settlement)")}`,
    );
  }
  if (opts.federationUrl != null) {
    console.log(`  ${dim("—")} federation  ${success("enabled")} @ ${opts.federationUrl}`);
  } else {
    console.log(
      `  ${dim("—")} federation  ${dim("isolated")} ${dim("(pass --federation-url to announce this relay)")}`,
    );
  }
  if (opts.passphrase == null) {
    console.log(
      `  ${dim("—")} key      ${dim("plaintext in db")} ${dim("(set MOTEBIT_RELAY_KEY_PASSPHRASE or pass --passphrase to encrypt)")}`,
    );
  } else {
    console.log(`  ${dim("—")} key      ${success("encrypted (AES-GCM + PBKDF2-600K)")}`);
  }
  console.log();
}

function printListeningBanner(port: number, relayMotebitId: string, did: string): void {
  console.log(`  ${bold(success("✓"))} listening on ${cyan(`http://localhost:${String(port)}`)}`);
  console.log(`  ${dim("relay id:")} ${relayMotebitId}`);
  console.log(`  ${dim("did:")}      ${did}`);
  console.log();
  console.log(`  ${dim("Ctrl-C to stop. Twice to force.")}`);
  console.log();
}

export async function handleRelayUp(config: CliConfig): Promise<void> {
  const opts = await resolveOptions(config);

  // Shutdown state flows into the relay via getShuttingDown so the
  // health-check endpoint returns 503 during drain. We own the flag
  // here because the signal handler lives in this process.
  let shuttingDown = false;

  const syncConfig: SyncRelayConfig = {
    ...buildRelayConfig(opts),
    getShuttingDown: () => shuttingDown,
  };

  printStartBanner(opts);

  const relay = await createSyncRelay(syncConfig);

  const server = serve({ fetch: relay.app.fetch, port: opts.port }, (info) => {
    printListeningBanner(info.port, relay.relayIdentity.relayMotebitId, relay.relayIdentity.did);
  });

  // Hono's Node adapter attaches an `injectWebSocket` helper when the
  // app registered WS routes. The relay does (task routing, peer
  // gossip). Type-narrow defensively so a hypothetical non-WS build
  // does not crash.
  const appWithWs = relay.app as unknown as {
    injectWebSocket?: (server: unknown) => void;
  };
  if (typeof appWithWs.injectWebSocket === "function") {
    appWithWs.injectWebSocket(server);
  }

  let forceOnNextSignal = false;
  const gracefulShutdown = (signal: string): void => {
    if (forceOnNextSignal) {
      console.error(`\nForced shutdown on ${signal}.`);
      process.exit(1);
    }
    forceOnNextSignal = true;
    shuttingDown = true;
    console.error(
      `\nShutting down (${signal}). Press ${signal} again to force. Timeout ${String(
        SHUTDOWN_TIMEOUT_MS,
      )}ms.`,
    );

    const forceTimer = setTimeout(() => {
      console.error(`Shutdown timed out after ${String(SHUTDOWN_TIMEOUT_MS)}ms, forcing exit.`);
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    if (typeof forceTimer === "object" && "unref" in forceTimer) {
      forceTimer.unref();
    }

    server.close(() => {
      void relay.close().then(() => {
        process.exit(0);
      });
    });
  };

  process.on("SIGTERM", () => {
    gracefulShutdown("SIGTERM");
  });
  process.on("SIGINT", () => {
    gracefulShutdown("SIGINT");
  });
}
