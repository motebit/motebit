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
  // Co-browse Slice 1: motebit attempted to act while not holding
  // control. 423 Locked is the closest standard pairing — the
  // resource (the browser session) is allocated but locked to
  // another holder until a control transition. The dispatcher's
  // `statusToReason` reverse-maps this back, so the cross-network
  // shape stays clean.
  not_in_control: 423,
  // Typed-truth-perception (motebit-computer.md §"Typed truth on
  // results"): the page navigated mid-action and the executor's
  // frame reference is stale. 409 Conflict is the closest standard
  // pairing — the resource (the browser frame) is in a state that
  // conflicts with the request's assumed pre-state. The executor
  // already retried once before surfacing this; receiving frame_stale
  // means even the retry caught a fresh stale frame, so the AI must
  // re-read before retrying. Paired with statusToReason in the
  // dispatcher.
  frame_stale: 409,
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
