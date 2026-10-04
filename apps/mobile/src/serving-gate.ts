/**
 * The single gate on mobile executing delegated work.
 *
 * Founder decision (2026-10, option 1): mobile is consent-first and
 * NON-EXECUTING today. Mobile is the consent root (surface-authority-model.md)
 * — the device that approves — so letting it also execute delegated tasks
 * collapses approver and executor onto one device. Serving from mobile stays
 * gated off until the approval authority is proven independent of the
 * executing device.
 *
 * Every mobile code path that would run a delegated task
 * (`runtime.handleAgentTask`) or advertise this device as a worker
 * (`startServing`) MUST pass through this gate first; the static test
 * `serving-gate-static.test.ts` fails the build on any ungated call site.
 *
 * The gate is a compile-time constant, not a setting: `/serve` cannot turn it
 * on, and no config or relay message can. The serving scaffolding (sync
 * controller registration, the foreground task loop, the background push-wake
 * handler) is kept as sibling-surface scaffolding per the deletion policy;
 * flipping this constant is the deliberate, reviewed act that re-enables it.
 */

export const MOBILE_SERVING_ENABLED: boolean = false;

/** What `/serve` (and any serving attempt) reports while the gate is off. */
export const MOBILE_SERVING_UNAVAILABLE =
  "Serving from mobile is not available yet — this device approves work, it does not execute delegated tasks.";

/** May this device advertise itself as a worker? */
export function mobileServingAllowed(): boolean {
  return MOBILE_SERVING_ENABLED;
}

/**
 * May this device execute a delegated task right now? Requires BOTH the
 * compile-time gate and the user having turned serving on.
 */
export function canExecuteDelegatedTask(servingOn: boolean): boolean {
  return MOBILE_SERVING_ENABLED && servingOn;
}
