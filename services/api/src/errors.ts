/**
 * Structured error hierarchy for relay security and economic boundaries.
 *
 * Each error carries a machine-readable `code` and HTTP `statusCode`, enabling
 * programmatic error handling without coupling to message strings. The global
 * error handler in middleware.ts catches RelayError and returns the appropriate
 * HTTP response with a JSON body: { error, code, status }.
 */

// ── Base ────────────────────────────────────────────────────────────────────

/** Base class for all relay errors. Includes error code for programmatic handling. */
export class RelayError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode: number = 500, options?: ErrorOptions) {
    super(message, options);
    this.name = "RelayError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

// ── Auth boundary ───────────────────────────────────────────────────────────

export class AuthenticationError extends RelayError {
  constructor(
    code:
      | "AUTH_MISSING_TOKEN"
      | "AUTH_INVALID_TOKEN"
      | "AUTH_TOKEN_EXPIRED"
      | "AUTH_TOKEN_BLACKLISTED"
      | "AUTH_AGENT_REVOKED"
      | "AUTH_LEGACY_TOKEN",
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, 401, options);
    this.name = "AuthenticationError";
  }
}

export class AuthorizationError extends RelayError {
  constructor(
    code:
      | "AUTHZ_DEVICE_NOT_AUTHORIZED"
      | "AUTHZ_NOT_TASK_PARTICIPANT"
      | "AUTHZ_INVALID_CREDENTIALS",
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, 403, options);
    this.name = "AuthorizationError";
  }
}

// ── Economic boundary ───────────────────────────────────────────────────────

export class InsufficientFundsError extends RelayError {
  constructor(message: string = "Insufficient funds", options?: ErrorOptions) {
    super("INSUFFICIENT_FUNDS", message, 402, options);
    this.name = "InsufficientFundsError";
  }
}

export class SettlementError extends RelayError {
  constructor(
    code: "SETTLEMENT_FAILED" | "SETTLEMENT_DOUBLE_SETTLE" | "SETTLEMENT_RECEIPT_INVALID",
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, 500, options);
    this.name = "SettlementError";
  }
}

export class AllocationError extends RelayError {
  constructor(
    code: "ALLOCATION_HOLD_FAILED" | "ALLOCATION_BUDGET_EXCEEDED",
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, 409, options);
    this.name = "AllocationError";
  }
}

// ── Rate limiting ───────────────────────────────────────────────────────────

export class RateLimitError extends RelayError {
  readonly retryAfter: number;

  constructor(
    message: string = "Rate limit exceeded",
    retryAfter: number = 60,
    options?: ErrorOptions,
  ) {
    super("RATE_LIMIT_EXCEEDED", message, 429, options);
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

// ── Federation ──────────────────────────────────────────────────────────────

export class FederationError extends RelayError {
  constructor(
    code:
      | "FEDERATION_PEER_UNKNOWN"
      | "FEDERATION_SIGNATURE_INVALID"
      | "FEDERATION_DISABLED"
      | "FEDERATION_PEER_BLOCKED"
      | "FEDERATION_FORWARD_FAILED",
    message: string,
    statusCode: number = 502,
    options?: ErrorOptions,
  ) {
    super(code, message, statusCode, options);
    this.name = "FederationError";
  }
}

// ── Task ────────────────────────────────────────────────────────────────────

export class TaskError extends RelayError {
  constructor(
    code:
      | "TASK_NOT_FOUND"
      | "TASK_EXPIRED"
      | "TASK_ALREADY_CLAIMED"
      | "TASK_INVALID_INPUT"
      | "TASK_QUEUE_FULL"
      | "TASK_PER_SUBMITTER_LIMIT",
    message: string,
    statusCode: number = 400,
    options?: ErrorOptions,
  ) {
    super(code, message, statusCode, options);
    this.name = "TaskError";
  }
}
