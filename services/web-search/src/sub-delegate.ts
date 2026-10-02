/**
 * Pure sub-delegation pieces of the web-search service: the #459 failure
 * circuit and the #957 read-url client config.
 *
 * They live outside `index.ts` because `index.ts` is the process entry: it
 * boots the service (binds MOTEBIT_PORT, opens ./data) on import and exits
 * the process with code 1 if boot fails. A test that imported these from the
 * entry booted a real server per test file; two workers racing for the same port
 * under load turned into `process.exit unexpectedly called with "1"`. Keep
 * this module free of boot side effects — `entry-isolation.test.ts` guards it.
 */
import type { McpServerConfig } from "@motebit/mcp-client";

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

// #459: sub-delegation failure circuit. During the 2026-07-29 incident this
// path retried a down read-url atom as fast as each handler turn completed —
// no backoff, no ceiling — creating a fresh relay task per attempt and
// feeding the settlement-amplification storm. The circuit is deliberately
// simple: consecutive failures open a cooldown during which subDelegate
// returns null IMMEDIATELY (before the relay-task POST, so no task is
// created either); one success closes it. `nowMs` is passed in
// so the cooldown is deterministic under test.
export const SUB_DELEGATE_MAX_CONSECUTIVE_FAILURES = 3;
export const SUB_DELEGATE_COOLDOWN_MS = 60_000;
let subDelegateConsecutiveFailures = 0;
let subDelegateCooldownUntil = 0;

export function subDelegateCircuitState(): { failures: number; cooldownUntil: number } {
  return { failures: subDelegateConsecutiveFailures, cooldownUntil: subDelegateCooldownUntil };
}

export function resetSubDelegateCircuitForTest(): void {
  subDelegateConsecutiveFailures = 0;
  subDelegateCooldownUntil = 0;
}

/** Record one sub-delegation outcome; opens the cooldown at the ceiling. */
export function recordSubDelegateOutcome(ok: boolean, nowMs: number): void {
  if (ok) {
    subDelegateConsecutiveFailures = 0;
    subDelegateCooldownUntil = 0;
    return;
  }
  subDelegateConsecutiveFailures++;
  if (subDelegateConsecutiveFailures >= SUB_DELEGATE_MAX_CONSECUTIVE_FAILURES) {
    subDelegateCooldownUntil = nowMs + SUB_DELEGATE_COOLDOWN_MS;
    log(
      `sub-delegation circuit OPEN — ${subDelegateConsecutiveFailures} consecutive failures; cooling down ${SUB_DELEGATE_COOLDOWN_MS / 1000}s`,
    );
  }
}

/**
 * The read-url hop's MCP client config. Caller tokens are bound to the atom
 * the RELAY named (`motebitId`), not to whatever the endpoint's /health
 * claims (#957); without a relay-named target the client falls back to
 * /health on first contact.
 */
export function subDelegateClientConfig(args: {
  mcpUrl: string;
  callerMotebitId: string;
  callerDeviceId: string;
  callerPrivateKey: Uint8Array;
  targetMotebitId?: string;
}): McpServerConfig {
  return {
    name: "read-url",
    transport: "http",
    url: args.mcpUrl,
    motebit: true,
    motebitType: "service",
    ...(args.targetMotebitId != null ? { motebitId: args.targetMotebitId } : {}),
    callerMotebitId: args.callerMotebitId,
    callerDeviceId: args.callerDeviceId,
    callerPrivateKey: args.callerPrivateKey,
  };
}
