/**
 * Provider readiness — "can I do the work I advertise a price for?"
 *
 * A heartbeat asserts LIVENESS. An agent's listing asserts something stronger:
 * that it will perform a named capability for a named price. On 2026-08-27 those
 * two claims came apart. The staging Researcher's inference provider was out of
 * credits, so every task failed in under three seconds — and it kept
 * heartbeating, kept showing `freshness: awake`, kept accepting PAID
 * delegations, and signed an honest refusal for each one. Six nights (#593).
 *
 * On the sovereign rail the buyer's money moves BEFORE the work is attempted
 * (`packages/runtime/src/relay-delegation.ts:1365`), and there is no reversal
 * (#610). So an agent that cannot work must stop advertising rather than sell
 * refusals. Being unreachable is an honest state; being for sale and unable to
 * deliver is not.
 *
 * ## The two-sided design
 *
 * Detection is PASSIVE and costs nothing: the molecule already learns the truth
 * every time a task fails, so `recordFailure` reads those real errors. No
 * synthetic polling in the healthy case.
 *
 * Recovery must be ACTIVE, and this is the part that is easy to get wrong: once
 * an agent stops advertising, no tasks arrive, so no new evidence arrives, and
 * passive detection alone would latch dark forever. The `probe` is therefore
 * called ONLY while already not-ready — cheap, and only when it is the only way
 * back.
 *
 * ## Conservatism is the safety property
 *
 * Withholding heartbeats on a false positive takes a working agent off the
 * market — the more expensive failure. So `classify` recognizes a deliberately
 * NARROW set of durable operator conditions (exhausted credit, revoked or
 * invalid key) and treats everything else — rate limits, 5xx, overload,
 * timeouts, socket errors, and anything unrecognized — as transient. Unknown
 * means transient, always. A probe that throws is handled upstream as ready.
 */

/** What a readiness probe answers. */
export interface ReadinessVerdict {
  ready: boolean;
  reason?: string;
}

export interface ProviderReadiness {
  /** Called before each heartbeat by `runService`. */
  check(): Promise<ReadinessVerdict>;
  /**
   * Feed a real task failure in. Durable operator conditions flip the agent to
   * not-ready; everything else is ignored.
   */
  recordFailure(message: string): void;
  /** A successful task is the strongest possible readiness evidence. */
  recordSuccess(): void;
}

/**
 * Durable provider conditions — an operator must act before work can resume.
 *
 * Matched against the provider's own error text, which for the Anthropic SDK is
 * `${status} ${body}` (e.g. `400 {"type":"error",...,"message":"Your credit
 * balance is too low to access the Anthropic API..."}`). Kept as explicit
 * phrases rather than a status-code rule because status alone does not separate
 * "this request was malformed" (transient, caller's fault, agent is fine) from
 * "this account cannot make requests" (durable, agent is not fine).
 */
const DURABLE_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /credit balance is too low/i, reason: "provider credit balance exhausted" },
  { pattern: /billing|payment required/i, reason: "provider billing problem" },
  {
    pattern: /quota (?:has been )?exceeded|insufficient_quota/i,
    reason: "provider quota exhausted",
  },
  {
    pattern: /authentication_error|invalid[_ ]api[_ ]key|invalid x-api-key/i,
    reason: "provider key rejected",
  },
  {
    pattern: /permission_error|\bunauthorized\b|\bforbidden\b/i,
    reason: "provider access revoked",
  },
];

/**
 * Classify a provider error. Returns the durable reason, or `null` for
 * transient — including for anything unrecognized, which is the safe default.
 */
export function classifyProviderFailure(message: string): string | null {
  // Rate limiting and overload are the loudest transient conditions and can
  // co-occur with words that look durable ("quota" in a 429 body), so they are
  // checked FIRST and short-circuit. A rate limit means "try later", never
  // "stop advertising".
  if (/rate[_ ]?limit|\b429\b|overloaded_error|\b529\b/i.test(message)) return null;
  for (const { pattern, reason } of DURABLE_PATTERNS) {
    if (pattern.test(message)) return reason;
  }
  return null;
}

/**
 * Build a readiness tracker.
 *
 * @param probe Cheapest possible round-trip to the provider, used ONLY while
 *   not-ready, to detect recovery. Resolve `true` if the provider answers.
 *   A probe that throws is treated as "still not ready" — it is only ever
 *   consulted when the agent is already dark, so a throw changes nothing.
 * @param now Injected clock (tests).
 * @param recheckAfterMs Minimum spacing between recovery probes.
 */
export function createProviderReadiness(opts: {
  probe: () => Promise<boolean>;
  now?: () => number;
  recheckAfterMs?: number;
}): ProviderReadiness {
  const now = opts.now ?? (() => Date.now());
  const recheckAfterMs = opts.recheckAfterMs ?? 60_000;

  let durableReason: string | null = null;
  // `null`, not 0 — with an injected clock that starts at 0, a numeric sentinel
  // makes `now() - lastProbeAt` zero on the very first check and suppresses the
  // first recovery probe for a full interval. The moment we go dark is exactly
  // when we most want to know whether it was momentary.
  let lastProbeAt: number | null = null;

  return {
    recordFailure(message: string): void {
      const reason = classifyProviderFailure(message);
      if (reason != null) durableReason = reason;
    },

    recordSuccess(): void {
      // Work completed, so whatever the condition was, it is over. This is
      // stronger evidence than any probe and needs no round-trip.
      durableReason = null;
    },

    async check(): Promise<ReadinessVerdict> {
      if (durableReason == null) return { ready: true };

      // Already dark. Probe — rate-limited — to find out whether to come back.
      if (lastProbeAt != null && now() - lastProbeAt < recheckAfterMs) {
        return { ready: false, reason: durableReason };
      }
      lastProbeAt = now();

      let recovered = false;
      try {
        recovered = await opts.probe();
      } catch {
        recovered = false;
      }
      if (recovered) {
        durableReason = null;
        return { ready: true };
      }
      return { ready: false, reason: durableReason };
    },
  };
}
