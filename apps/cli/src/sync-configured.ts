/**
 * The CLI's answer to `RuntimeConfig.syncConfigured` (#962), shared by every
 * CLI construction of a `MotebitRuntime` — the REPL (`createRuntime`), both
 * daemons (`motebit run`, `motebit serve`) and `motebit delegate`.
 *
 * Configured when the process syncs its events with a relay: the REPL and
 * `delegate` always do (`resolveRelayUrl` / `getRelayUrl` fall back to the
 * default relay); `motebit run` does when a sync URL is set, and `motebit
 * serve` when it serves over HTTP with one. Each of them then pushes on its
 * own (`cli-event-push.ts`). Also configured: a daemon that pushes to no
 * relay itself (`serve` over stdio) while a relay is NAMED for its identity
 * (flag, env, config.json) — another process pushes its events (#962 round
 * 5). A configured runtime records the identity's sync intent in
 * `motebit.db` (`recordSyncIntent`), and every later process on that
 * database floors compaction on it, configured or not; so does the REPL's
 * identity bootstrap (`bootstrapReplIdentity`), before any runtime. Only a
 * database whose identity was never configured for sync compacts freely.
 *
 * Configured, compaction waits on the relay's acknowledged push cursor —
 * never deletes what it has not acknowledged. Stated cost: a CLI that never
 * reaches its relay, or whose push the relay keeps refusing, holds
 * compaction and `motebit.db` grows until a push is acknowledged. The
 * refusal is surfaced as one line (`syncFailureLine`), never silently. A
 * relay connected once and abandoned (a mistyped `--sync-url`, a relay
 * switch) holds compaction too — never retired automatically — and is named
 * once at REPL start and in `motebit status`; `motebit sync status | retire |
 * clear-intent` are the operator's doors (#962 round 6, `subcommands/sync.ts`).
 *
 * Every MotebitRuntime construction under `apps/cli/src` builds its config
 * through `cliRuntimeConfig`; `every-configured-surface-pushes-962.test.ts`
 * holds each entry point's behaviour to it.
 */
import type { RuntimeConfig } from "@motebit/runtime";
import type { CliConfig } from "./args.js";

/**
 * The config every CLI runtime construction is built from (#962): the
 * caller's config with `syncConfigured` decided HERE, last, so no spread at
 * a call site can drop or override it. `relay.syncUrl` is the relay this
 * process syncs its events with (undefined or empty: none).
 */
export function cliRuntimeConfig(
  base: Omit<RuntimeConfig, "syncConfigured">,
  relay: { syncUrl: string | undefined; intentUrl?: string | undefined },
): RuntimeConfig {
  const named = (u: string | undefined): boolean => u != null && u !== "";
  return { ...base, syncConfigured: named(relay.syncUrl) || named(relay.intentUrl) };
}

/**
 * The relay a daemon syncs its events with (#962), or undefined when none:
 * `--sync-url` > `MOTEBIT_SYNC_URL` > the config file's `sync_url`. `motebit
 * serve` over stdio reaches no relay whatever is configured (`transport`).
 * Both daemons pass this to `cliRuntimeConfig` and to their relay wiring.
 */
export function daemonRelayUrl(
  config: Pick<CliConfig, "syncUrl">,
  fullConfig: { sync_url?: string },
  transport: "stdio" | "http" | "run",
): string | undefined {
  if (transport === "stdio") return undefined;
  const url = config.syncUrl ?? process.env["MOTEBIT_SYNC_URL"] ?? fullConfig.sync_url;
  return url != null && url !== "" ? url : undefined;
}

/** The relay wiring a daemon is built from (#962): `daemonRelay`. */
export interface DaemonRelay {
  /** The relay this daemon pushes its events to, or undefined when none. */
  syncUrl: string | undefined;
  /**
   * The relay NAMED for this identity (flag > env > config.json), whatever
   * the transport (#962 round 5): stdio `serve` pushes to none, yet its
   * identity is configured for this one, so its events wait for a relay's
   * acknowledgment (another process pushes them).
   */
  intentUrl: string | undefined;
}

/**
 * Everything a daemon's runtime config and relay wiring read about the relay
 * (#962): what `cliRuntimeConfig` takes, as `daemon.ts` passes it for `run`
 * and `serve`.
 */
export function daemonRelay(
  config: Pick<CliConfig, "syncUrl">,
  fullConfig: { sync_url?: string },
  transport: "stdio" | "http" | "run",
): DaemonRelay {
  return {
    syncUrl: daemonRelayUrl(config, fullConfig, transport),
    intentUrl: daemonRelayUrl(config, fullConfig, "run"),
  };
}
