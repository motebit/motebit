/**
 * Wire→runtime option narrowing — a privilege boundary every
 * coordinator host applies. An attached process is authenticated as
 * this device, but authority fields must never be assertable over the
 * socket: `verifiedGrant` may only be produced by `verifyGrantForTurn`
 * from signed artifacts
 * (docs/doctrine/memory-never-confers-authority.md), and
 * `userActionAttestation` must originate from a real local user
 * action. Hosts wire these into their chat/invoke seams; anything not
 * explicitly allowlisted is dropped.
 */

/** Narrow wire-supplied chat options to the rendering-safe subset. */
export function pickSafeChatOptions(
  options: Record<string, unknown> | undefined,
): { delegationScope?: string; suppressHistory?: boolean } | undefined {
  if (options === undefined) return undefined;
  const picked: { delegationScope?: string; suppressHistory?: boolean } = {};
  if (typeof options["delegationScope"] === "string") {
    picked.delegationScope = options["delegationScope"];
  }
  if (typeof options["suppressHistory"] === "boolean") {
    picked.suppressHistory = options["suppressHistory"];
  }
  return picked;
}

/** Same narrowing for invoke options; origin stays the host's default. */
export function pickSafeInvokeOptions(options: Record<string, unknown> | undefined): {
  targetWorkerId?: string;
  acknowledgeNoHistoryRisk?: boolean;
} {
  const picked: { targetWorkerId?: string; acknowledgeNoHistoryRisk?: boolean } = {};
  if (options === undefined) return picked;
  if (typeof options["targetWorkerId"] === "string") {
    picked.targetWorkerId = options["targetWorkerId"];
  }
  if (typeof options["acknowledgeNoHistoryRisk"] === "boolean") {
    picked.acknowledgeNoHistoryRisk = options["acknowledgeNoHistoryRisk"];
  }
  return picked;
}
