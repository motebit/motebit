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
      "AUTHZ_DEVICE_NOT_AUTHORIZED" | "AUTHZ_NOT_TASK_PARTICIPANT" | "AUTHZ_INVALID_CREDENTIALS",
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, message, 403, options);
    this.name = "AuthorizationError";
  }
}

// ── Economic boundary ───────────────────────────────────────────────────────

/**
 * A payment this request already made, credited to the payer's virtual account
 * before the request was refused (#901): the refusal body names it so the
 * client does not pay again.
 */
export interface CreditedPayment {
  /** Amount credited, integer micro-units. */
  amount_micro: number;
  /** Ledger reference of the credit (`relay_transactions.reference_id`). */
  reference: string;
  /** The account it sits in. */
  motebit_id: string;
}

export class InsufficientFundsError extends RelayError {
  /** Set when this request's own payment was credited before the refusal. */
  readonly creditedPayment?: CreditedPayment;
  constructor(
    message: string = "Insufficient funds",
    options?: ErrorOptions & { creditedPayment?: CreditedPayment },
  ) {
    super("INSUFFICIENT_FUNDS", message, 402, options);
    this.name = "InsufficientFundsError";
    if (options?.creditedPayment != null) this.creditedPayment = options.creditedPayment;
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
      | "TASK_ALREADY_ANSWERED"
      | "TASK_INVALID_INPUT"
      | "TASK_QUEUE_FULL"
      | "TASK_PER_SUBMITTER_LIMIT"
      | "TASK_CONFLICT"
      | "TASK_P2P_INELIGIBLE"
      | "TASK_P2P_NO_ADDRESS"
      | "TASK_P2P_ADDRESS_MISMATCH"
      | "TASK_P2P_AMOUNT_MISMATCH"
      | "TASK_P2P_FEE_ADDRESS_MISMATCH"
      | "TASK_P2P_FEE_AMOUNT_MISMATCH"
      | "TASK_P2P_PROOF_REQUIRED"
      | "TASK_P2P_PROOF_REPLAYED"
      | "TASK_P2P_PROOF_ALREADY_ADMITTED"
      | "TASK_P2P_PROOF_NOT_PAYER"
      | "TASK_P2P_PROOF_UNVERIFIED"
      | "TASK_X402_SETTLEMENT_FAILED"
      | "TASK_X402_PAYMENT_UNBOUND"
      | "TASK_X402_OUTCOME_UNKNOWN"
      | "TASK_X402_OUTCOME_PENDING"
      | "TASK_X402_PAYMENT_REPLAYED"
      | "TASK_GRANT_REVOKED",
    message: string,
    statusCode: number = 400,
    options?: ErrorOptions,
  ) {
    super(code, message, statusCode, options);
    this.name = "TaskError";
  }
}

/**
 * A P2P payment proof that is already bound to an admitted task (#918): one
 * onchain payment funds exactly one task. A refusal before admission (the key
 * is freed). `existingTaskId` is set only when the caller is entitled to see
 * that task (`mayDiscloseAdmittedTask`: the operator, or the token-verified
 * submitter of a token-verified admission); otherwise no id (cf. #903).
 */
export class P2pProofAlreadyAdmittedError extends TaskError {
  readonly existingTaskId?: string;
  constructor(existingTaskId: string | undefined, options?: ErrorOptions) {
    super(
      "TASK_P2P_PROOF_ALREADY_ADMITTED",
      existingTaskId != null
        ? `This payment proof (tx_hash) already funds task ${existingTaskId}; each onchain payment funds exactly one task. Poll that task's result, or replay the Idempotency-Key that admitted it. A new task needs a new payment.`
        : "This payment proof (tx_hash) already funds another task; each onchain payment funds exactly one task. A new task needs a new payment.",
      409,
      options,
    );
    this.name = "P2pProofAlreadyAdmittedError";
    if (existingTaskId != null) this.existingTaskId = existingTaskId;
  }
}

/** The x402 settlement record a refusal names (#907 round 2). No task content. */
export interface X402SettlementRef {
  /** The EIP-3009 authorizer (payer), lowercase. */
  payer: string;
  /** The authorization nonce, lowercase. */
  nonce: string;
  amount_micro: number;
  /** The account a landed payment is credited to. */
  delegator: string;
  network: string;
  status: string;
  /** Unix seconds; an unexecuted authorization can never land after this. */
  valid_before: number;
}

/**
 * The x402 settle did not end in a known state (a timeout, a 5xx, a network
 * error, an unrecognised refusal, a settlement that cannot be attributed), or
 * an earlier request under this key is still in that state ("pending"). The
 * transfer may have landed: the client must NOT pay again. The record is
 * reconciled from the chain, and a landed payment is credited once to
 * `delegator`'s account.
 */
export class X402OutcomeUnknownError extends TaskError {
  readonly settlement?: X402SettlementRef;
  constructor(settlement: X402SettlementRef | undefined, phase: "unknown" | "pending" = "unknown") {
    super(
      phase === "pending" ? "TASK_X402_OUTCOME_PENDING" : "TASK_X402_OUTCOME_UNKNOWN",
      (phase === "pending"
        ? "An earlier request under this Idempotency-Key paid via x402 and its outcome is still being reconciled. "
        : "The x402 payment outcome is unknown: the transfer may have landed. ") +
        "Do NOT pay again. It is reconciled against the chain; if it landed it is credited once to the delegator's account, and a same-key retry after that is funded from the account. No task was admitted.",
      phase === "pending" ? 409 : 402,
    );
    this.name = "X402OutcomeUnknownError";
    if (settlement != null) this.settlement = settlement;
  }
}

/** This signed EIP-3009 authorization already has a settlement record: never settled twice. */
export class X402PaymentReplayedError extends TaskError {
  readonly settlement?: X402SettlementRef;
  constructor(settlement: X402SettlementRef | undefined) {
    super(
      "TASK_X402_PAYMENT_REPLAYED",
      "This x402 payment (EIP-3009 authorization) was already presented to this relay; one authorization is settled at most once. It was not settled again. A new task needs a new payment.",
      409,
    );
    this.name = "X402PaymentReplayedError";
    if (settlement != null) this.settlement = settlement;
  }
}
