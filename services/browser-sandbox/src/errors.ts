/**
 * Service error envelope — wire shape the
 * `CloudBrowserDispatcher` (in `@motebit/runtime`) reads to populate
 * `ComputerDispatcherError.reason`. Every 4xx/5xx response from this
 * service uses this body shape so the dispatcher's structured-envelope
 * path lights up:
 *
 *   { "error": { "reason": "<ComputerFailureReason>", "message": "..." } }
 *
 * The `reason` field is constrained to the `ComputerFailureReason`
 * union in `@motebit/protocol::computer-use` — keeping the shape
 * symmetric across the desktop Tauri Rust path and this cloud path is
 * the load-bearing invariant the dispatcher-parity drift gate
 * enforces.
 */

import type { ComputerFailureReason } from "@motebit/protocol";

export interface ServiceErrorBody {
  readonly error: {
    readonly reason: ComputerFailureReason;
    readonly message?: string;
  };
}

/**
 * HTTP status that pairs naturally with each failure reason. Mirrors
 * the dispatcher-side `statusToReason` mapping but inverted — keep
 * the two in sync (the parity gate cross-checks).
 */
const REASON_STATUS: Record<ComputerFailureReason, number> = {
  policy_denied: 429,
  approval_required: 412, // precondition (consent) failed
  approval_expired: 412,
  permission_denied: 401,
  session_closed: 404,
  target_not_found: 400,
  target_obscured: 400,
  user_preempted: 408,
  platform_blocked: 500,
  not_supported: 501,
};

/**
 * Internal exception thrown from route handlers / executor. Caught at
 * the route boundary and serialized into `ServiceErrorBody`.
 */
export class ServiceError extends Error {
  constructor(
    public readonly reason: ComputerFailureReason,
    message?: string,
  ) {
    super(message ?? reason);
    this.name = "ServiceError";
  }

  toEnvelope(): ServiceErrorBody {
    return { error: { reason: this.reason, message: this.message } };
  }

  status(): number {
    return REASON_STATUS[this.reason];
  }
}

/** True iff `value` looks like a `ServiceError` (cross-realm safe). */
export function isServiceError(value: unknown): value is ServiceError {
  return (
    value instanceof Error &&
    value.name === "ServiceError" &&
    typeof (value as { reason?: unknown }).reason === "string"
  );
}
