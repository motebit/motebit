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
 * Every MotebitRuntime construction under `apps/cli/src` passes exactly this
 * constant; `cli-sync-configured-962.test.ts` holds each site to it.
 */
export const CLI_SYNC_CONFIGURED = true;
