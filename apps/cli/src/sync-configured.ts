/**
 * The CLI's answer to `RuntimeConfig.syncConfigured` (#962), shared by every
 * CLI construction of a `MotebitRuntime` — the REPL (`createRuntime`), both
 * daemons (`motebit run`, `motebit serve`) and `motebit delegate`.
 *
 * `true`: every CLI runtime opens the one `motebit.db`, and the REPL always
 * syncs it to a relay (`resolveRelayUrl` falls back to the default relay), so
 * an event any of them writes is on its way to that relay. Compaction waits
 * on the relay's acknowledged push cursor — never deletes what it has not
 * acknowledged. The REPL's push authenticates with a device token minted
 * from the identity key (`createReplEventRemote`), so the cursor advances.
 *
 * Stated cost: a CLI that never reaches its relay, or whose push the relay
 * keeps refusing, holds compaction and `motebit.db` grows until a push is
 * acknowledged. The refusal is surfaced as one line (`syncFailureLine`),
 * never silently.
 *
 * Every MotebitRuntime construction under `apps/cli/src` builds its config
 * through `cliRuntimeConfig`; `cli-sync-configured-962.test.ts` holds each
 * site to it.
 */
import type { RuntimeConfig } from "@motebit/runtime";
import type { CliConfig } from "./args.js";

export const CLI_SYNC_CONFIGURED = true;

/**
 * The config every CLI `new MotebitRuntime(` is built from (#962): the
 * caller's config with `syncConfigured` decided HERE, last, so no spread at
 * a call site can drop or override it. `relay.syncUrl` is the relay this
 * process syncs its events with (undefined: none configured).
 */
export function cliRuntimeConfig(
  base: Omit<RuntimeConfig, "syncConfigured">,
  _relay: { syncUrl: string | undefined },
): RuntimeConfig {
  return { ...base, syncConfigured: CLI_SYNC_CONFIGURED };
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
