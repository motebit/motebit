/**
 * The CLI's answer to `RuntimeConfig.syncConfigured` (#962), shared by every
 * CLI construction of a `MotebitRuntime` — the REPL (`createRuntime`), both
 * daemons (`motebit run`, `motebit serve`) and `motebit delegate`.
 *
 * Configured exactly when the process syncs its events with a relay: the
 * REPL and `delegate` always do (`resolveRelayUrl` / `getRelayUrl` fall back
 * to the default relay); `motebit run` does when a sync URL is set, and
 * `motebit serve` when it serves over HTTP with one. Each of them then
 * pushes on its own (`cli-event-push.ts`). A daemon with no relay is not
 * configured: nothing it writes is on its way to a relay, so compaction does
 * not wait on one — bounded, as always, by any relay stream `motebit.db`
 * already records (another process that did push).
 *
 * Configured, compaction waits on the relay's acknowledged push cursor —
 * never deletes what it has not acknowledged. Stated cost: a CLI that never
 * reaches its relay, or whose push the relay keeps refusing, holds
 * compaction and `motebit.db` grows until a push is acknowledged. The
 * refusal is surfaced as one line (`syncFailureLine`), never silently.
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
  relay: { syncUrl: string | undefined },
): RuntimeConfig {
  return { ...base, syncConfigured: relay.syncUrl != null && relay.syncUrl !== "" };
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
