/**
 * Token audiences — the closed registry of `aud` claim values for the
 * audience-bound signed-token primitive (`SignedTokenPayload`).
 *
 * Audience binding (per `docs/doctrine/security-boundaries.md` and
 * `services/relay/CLAUDE.md` Rule 5) prevents cross-endpoint replay:
 * a token minted for one purpose cannot be reused for another. Every
 * signed bearer in motebit carries `aud`; verifiers reject a missing
 * or unexpected value fail-closed.
 *
 * **Closed registry shape** — same closure pattern as `SuiteId`,
 * `SettlementRail`, `ToolMode`, `ComputerActionKind`. The `TokenAudience`
 * literal union is the wire law; named constants are the developer
 * ergonomics. A typo at a signing site (`"task:sumbit"`) is rejected
 * by the union narrowing AND by the `check-audience-canonical` drift
 * gate, which scans every `aud: "<literal>"` and
 * `createSyncToken("<literal>")` call against `ALL_TOKEN_AUDIENCES`.
 *
 * Adding an audience is intentional protocol-level work: a new entry
 * here, a new caller-or-route registration, a doctrine update at
 * `services/relay/CLAUDE.md` Rule 5. Renaming a literal is a wire
 * break (verifiers reject the old value); deletions break running
 * deployments. Same-shape decisions as cryptosuite agility.
 *
 * Permissive floor (Apache-2.0), type-only, zero runtime deps.
 */

/**
 * The closed set of audience identifiers motebit currently uses.
 *
 * Categories (organizational; the union is flat):
 *
 *   **Multi-device + identity lifecycle**
 *     - `sync` — websocket sync + general relay state operations
 *     - `device:auth` — per-device auth headers on relay calls
 *     - `pair` — device-pairing flow (claim, transfer)
 *     - `rotate-key` — key rotation requests
 *     - `push:register` — push-notification token registration
 *
 *   **Task routing**
 *     - `task:submit` — submitting a task to a peer via the relay
 *     - `task:query` — polling a submitted task for its result
 *     - `task:result` — a worker device posting a signed execution receipt
 *     - `admin:query` — admin-bound read paths (transparency, etc.)
 *     - `proposal` — collaborative proposal lifecycle
 *     - `receipts:read` — a motebit reading its OWN signed execution receipts
 *
 *   **Agent-registry reads (dynamic per-path middleware in `services/relay/src/agents.ts`)**
 *     - `market:listing` — service-listing reads + the p2p-eligibility pre-flight
 *     - `market:query` — market discovery / candidate queries (minted by
 *       delegator clients today; relay-side audience enforcement pending)
 *     - `credentials` — credential submit / verify / revoke paths
 *     - `credentials:present` — verifiable-presentation submission
 *
 *   **Virtual accounts (the relay-mediated economic loop)**
 *     - `account:balance` — read balance
 *     - `account:deposit` — deposit endpoint (Stripe / x402 / Solana)
 *     - `account:withdraw` — withdraw endpoint
 *     - `account:withdrawals` — list withdrawals
 *     - `account:checkout` — Stripe checkout session create
 *
 *   **Browser-sandbox dispatcher token (relay-mediated auth)**
 *     - `browser-sandbox-grant` — motebit→relay grant request
 *     - `browser-sandbox` — relay→motebit→sandbox dispatcher token
 *
 *   **Local runtime-host coordination (never crosses the machine)**
 *     - `runtime:attach` — frontend→coordinator attach handshake on the
 *       local runtime-host socket
 */
export type TokenAudience =
  | "sync"
  | "device:auth"
  | "pair"
  | "rotate-key"
  | "push:register"
  | "task:submit"
  | "task:query"
  | "task:result"
  | "admin:query"
  | "proposal"
  | "receipts:read"
  | "market:listing"
  | "market:query"
  | "credentials"
  | "credentials:present"
  | "account:balance"
  | "account:deposit"
  | "account:withdraw"
  | "account:withdrawals"
  | "account:checkout"
  | "browser-sandbox-grant"
  | "browser-sandbox"
  | "runtime:attach";

// === Named constants — same value, narrower type ============================
//
// Callers that import these get `TokenAudience` typing without the union
// being inferred from a string-literal at every site. Two ergonomic shapes:
// pass a constant (`SYNC_AUDIENCE`) for documentation + grep affordance, or
// inline the literal — the union narrowing catches typos in either case.

/** Multi-device sync + general relay state operations. */
export const SYNC_AUDIENCE: TokenAudience = "sync";

/** Per-device auth headers on relay calls. Apps mint this for ad-hoc reads. */
export const DEVICE_AUTH_AUDIENCE: TokenAudience = "device:auth";

/** Device-pairing flow — claim + transfer. */
export const PAIR_AUDIENCE: TokenAudience = "pair";

/** Key rotation requests against the relay. */
export const ROTATE_KEY_AUDIENCE: TokenAudience = "rotate-key";

/** Push-notification token registration (APNs / FCM). */
export const PUSH_REGISTER_AUDIENCE: TokenAudience = "push:register";

/** Submitting a task to a peer via the relay. */
export const TASK_SUBMIT_AUDIENCE: TokenAudience = "task:submit";

/**
 * Polling a submitted task for its result
 * (`GET /agent/{id}/task/{taskId}`). The submitter's token carries the
 * submitter's own `mid` — the relay authorizes submitter-or-target.
 */
export const TASK_QUERY_AUDIENCE: TokenAudience = "task:query";

/**
 * A worker device posting its signed execution receipt
 * (`POST /agent/{id}/task/{taskId}/result`).
 */
export const TASK_RESULT_AUDIENCE: TokenAudience = "task:result";

/** Admin-bound read paths (transparency, etc.). */
export const ADMIN_QUERY_AUDIENCE: TokenAudience = "admin:query";

/** Collaborative proposal lifecycle. */
export const PROPOSAL_AUDIENCE: TokenAudience = "proposal";

/** A motebit reading its OWN signed execution receipts from the relay archive. */
export const RECEIPTS_READ_AUDIENCE: TokenAudience = "receipts:read";

/** Service-listing reads + the p2p-eligibility pre-flight (same delegator-minted token). */
export const MARKET_LISTING_AUDIENCE: TokenAudience = "market:listing";

/**
 * Market discovery / candidate queries. Minted today by the planner's
 * sovereign-delegation adapter and the CLI delegate flow; the market
 * routes do not yet enforce an audience relay-side — registering the
 * value closes the vocabulary, enforcement is a separate relay change.
 */
export const MARKET_QUERY_AUDIENCE: TokenAudience = "market:query";

/** Credential submit / verify / revoke paths on the agent registry. */
export const CREDENTIALS_AUDIENCE: TokenAudience = "credentials";

/** Verifiable-presentation submission. */
export const CREDENTIALS_PRESENT_AUDIENCE: TokenAudience = "credentials:present";

/** Read virtual-account balance. */
export const ACCOUNT_BALANCE_AUDIENCE: TokenAudience = "account:balance";

/** Deposit endpoint (Stripe / x402 / Solana). */
export const ACCOUNT_DEPOSIT_AUDIENCE: TokenAudience = "account:deposit";

/** Withdraw endpoint. */
export const ACCOUNT_WITHDRAW_AUDIENCE: TokenAudience = "account:withdraw";

/** List withdrawals (history). */
export const ACCOUNT_WITHDRAWALS_AUDIENCE: TokenAudience = "account:withdrawals";

/** Stripe checkout session create. */
export const ACCOUNT_CHECKOUT_AUDIENCE: TokenAudience = "account:checkout";

/**
 * Audience for the motebit-signed grant request to the relay's
 * `POST /api/v1/browser-sandbox/token` endpoint. Verified by the relay
 * via `verifySignedTokenForDevice`.
 */
export const BROWSER_SANDBOX_GRANT_AUDIENCE: TokenAudience = "browser-sandbox-grant";

/**
 * Audience for the relay-signed sandbox token. Verified by
 * `services/browser-sandbox` against the pinned relay public key.
 *
 * See `spec/computer-use-v1.md` §8.2 for the wire-format binding.
 */
export const BROWSER_SANDBOX_AUDIENCE: TokenAudience = "browser-sandbox";

/**
 * Audience for the device-key-signed attach handshake on the local
 * runtime-host socket (`~/.motebit/runtime.sock`): a frontend process
 * authenticating to the machine's coordinator runtime. Verified by
 * `@motebit/runtime-host` fail-closed; never accepted by the relay or
 * any network verifier — the token never leaves the machine.
 *
 * See `docs/doctrine/daemon-desktop-unification.md` for the election +
 * attach model.
 */
export const RUNTIME_ATTACH_AUDIENCE: TokenAudience = "runtime:attach";

// === Iteration + type guard =================================================

/**
 * Canonical iteration order, frozen. Consumers that need to iterate
 * (drift gates, tooling, docs) use this so TypeScript sees the narrow
 * union rather than `string[]`.
 */
export const ALL_TOKEN_AUDIENCES: readonly TokenAudience[] = Object.freeze([
  "sync",
  "device:auth",
  "pair",
  "rotate-key",
  "push:register",
  "task:submit",
  "task:query",
  "task:result",
  "admin:query",
  "proposal",
  "receipts:read",
  "market:listing",
  "market:query",
  "credentials",
  "credentials:present",
  "account:balance",
  "account:deposit",
  "account:withdraw",
  "account:withdrawals",
  "account:checkout",
  "browser-sandbox-grant",
  "browser-sandbox",
  "runtime:attach",
]);

/**
 * Type guard — narrows `unknown` to `TokenAudience`. Drift-gate-driven
 * audience-string scanners use this to validate literals; verifiers
 * call this before dispatch so an unchecked cast is a fail-open path
 * the gate will flag.
 */
export function isTokenAudience(value: unknown): value is TokenAudience {
  return typeof value === "string" && (ALL_TOKEN_AUDIENCES as readonly string[]).includes(value);
}
