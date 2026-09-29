/**
 * Sovereign delegation adapter — pattern 9.1 (pay-forward) from settlement spec.
 *
 * Implements StepDelegationAdapter by orchestrating four concerns that the relay
 * normally handles as a unit: discovery, payment, task execution, and receipt
 * capture. The relay is used only for discovery (a free read); payment, execution,
 * and receipts all happen peer-to-peer.
 *
 * Flow:
 *   1. DISCOVER — GET relay /api/v1/market/candidates (free, read-only)
 *   2. PAY — SolanaWalletRail.send(pay_to_address, cost) → tx_hash
 *   3. EXECUTE — MCP tools/call → motebit_task (direct to agent endpoint)
 *   4. RECEIPT — Verify receipt via embedded public key, return DelegatedStepResult
 *
 * ## A delivery-uncertain outcome never becomes a new payment (#887)
 *
 * Money moves at step 2 and cannot be recalled, so the retry loop may pay a
 * second worker ONLY when the first payment is known not to have happened, or
 * when the paid worker answered with a signed, verified failure. Everything
 * else stops the step and says what is owed:
 *
 *   - `send` threw → ask the rail whether the transfer landed anyway
 *     (`confirmSend`). Landed ⇒ proceed with that signature, exactly as if
 *     `send` had returned it. Absent ⇒ nothing moved; the next worker may be
 *     tried. Undecidable ⇒ stop: "payment status unknown".
 *   - Paid, then the MCP call timed out, failed, or returned something that
 *     is not a verifiable receipt ⇒ stop: "paid, result not retrieved". The
 *     payment stays on the ledger as unretrieved. The adapter does NOT
 *     re-present the task to the same worker: no worker today dedupes a
 *     pay-forward task by its tx hash, so a re-presentation is a second
 *     execution the worker never agreed to (see the report on #887).
 *   - Paid, and the worker returned a verified receipt signed by itself whose
 *     status is not `completed` ⇒ a real failure; the next attempt may pay
 *     another worker, as before.
 *
 * Every payment is written to the injected paid-intent ledger BEFORE the
 * task is presented, and a worker that already holds a paid, unretrieved
 * result for the same capability is refused before any money moves.
 */

import type { PlanStep, DelegatedStepResult, ExecutionReceipt } from "@motebit/sdk";
import type { TokenAudience } from "@motebit/sdk";
import { MCP_CALL_AUDIENCE } from "@motebit/sdk";
import type { StepDelegationAdapter } from "./plan-engine.js";

// ── Config ──────────────────────────────────────────────────────────

/**
 * Verdict of a wallet's read-only "did my failed send land anyway?" lookup.
 * Structural mirror of `SendConfirmation` in `@motebit/wallet-solana` (the
 * planner sits below the wallet in the layer DAG and cannot import it).
 */
export type SovereignSendConfirmation =
  | { status: "landed"; signature: string }
  | { status: "absent" }
  | { status: "pending"; recheckAtMs: number }
  | { status: "unknown"; reason: string };

/** One payment as the paid-intent ledger records it. */
export interface SovereignPaidEntry {
  workerMotebitId: string;
  capability: string;
  /** `sovereign:<worker>:<txHash>` — also the plan step's `delegation_task_id`. */
  taskId: string;
  txHash: string;
  paidMicro: number;
  feeMicro: number;
  recordedAt: number;
}

/**
 * The paid-intent ledger, as the adapter needs it. Structurally satisfied by
 * `PaidIntentLedger` in `@motebit/runtime` (#884), which the runtime injects;
 * the planner cannot import the runtime.
 */
export interface SovereignPaidLedger {
  check(
    workerMotebitId: string,
    capability: string,
  ):
    | { locked: false }
    | {
        locked: true;
        scope: "pair" | "session";
        prior: { taskId: string; txHash: string; capability: string };
      };
  recordInFlight(entry: SovereignPaidEntry): void;
  recordSettledUnretrieved(entry: SovereignPaidEntry): void;
  resolve(taskId: string): boolean;
}

export interface SovereignDelegationConfig {
  /** Relay URL for discovery only (no settlement flows through relay). */
  discoveryUrl: string;
  /** Static auth token or async factory for relay discovery calls. */
  authToken?: string | ((audience?: TokenAudience) => Promise<string>);
  /** Local motebit ID. */
  motebitId: string;
  /** Device ID for auth token creation. */
  deviceId: string;
  /** Ed25519 signing keys for MCP auth tokens. */
  signingKeys: { privateKey: Uint8Array; publicKey: Uint8Array };
  /**
   * Wallet rail for direct USDC payment.
   * Accepts any object with send() returning { signature: string }.
   */
  walletRail: {
    send(toAddress: string, microAmount: bigint): Promise<{ signature: string }>;
    /**
     * Read-only: after `send` threw, did the transfer land anyway? Without
     * it every `send` error is "payment status unknown" and the step stops
     * (fail-closed — never a second payment).
     */
    confirmSend?(query: {
      toAddress: string;
      microAmount: bigint;
      sentAtMs: number;
      failedAtMs: number;
      error: unknown;
      excludeSignatures?: readonly string[];
    }): Promise<SovereignSendConfirmation>;
    readonly chain: string;
    readonly asset: string;
  };
  /**
   * Durable paid-intent ledger (#884). When present, every payment is
   * recorded before the task is presented, and a worker already holding a
   * paid, unretrieved result is refused before any money moves.
   */
  paidLedger?: SovereignPaidLedger;
  /** Where ledger-write failures are reported. Default `console.warn`. */
  logger?: { warn(message: string, context?: Record<string, unknown>): void };
  /** Max retry attempts on failure (default 2, so up to 3 total attempts). */
  maxRetries?: number;
  /**
   * Longest the adapter waits, after a failed `send`, for the wallet to
   * decide whether the transfer landed (default 180 000 ms). Past it the
   * step stops as "payment status unknown".
   */
  paymentConfirmMaxWaitMs?: number;
  /** Clock + sleep seams (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Called on each failed attempt for trust demotion. */
  onDelegationFailure?: (
    step: PlanStep,
    attempt: number,
    error: string,
    failedAgentId?: string,
  ) => void;
  /** Routing strategy passed to discovery. */
  routingStrategy?: "cost" | "quality" | "balanced";
  /**
   * Mint an audience-bound signed auth token. Injected to avoid importing
   * crypto directly. The minter owns iat/exp/jti assembly (the canonical
   * `mintAudienceToken` seam); the adapter supplies identity, audience and,
   * for an MCP call, the target it is bound to (`sub`, #957).
   */
  mintAudienceToken: (
    input: { mid: string; did: string; aud: string; sub?: string; ttlMs?: number },
    privateKey: Uint8Array,
  ) => Promise<{ token: string }>;
  /** Verify an execution receipt. Injected to avoid importing crypto directly. */
  verifyReceipt: (receipt: ExecutionReceipt, publicKey: Uint8Array) => Promise<boolean>;
  /** Hex-decode utility. */
  hexToBytes: (hex: string) => Uint8Array;
  /** SHA-256 hex hash. */
  hash: (data: Uint8Array) => Promise<string>;
}

const DEFAULT_PAYMENT_CONFIRM_MAX_WAIT_MS = 180_000;

// ── Discovery types ─────────────────────────────────────────────────

interface DiscoveredCandidate {
  motebit_id: string;
  endpoint_url: string | null;
  pay_to_address: string | null;
  pricing: Array<{ capability: string; unit_cost: number; currency: string; per: string }>;
  composite: number;
}

/** What one MCP presentation produced — a parsed receipt, or why there is none. */
type McpOutcome =
  { kind: "receipt"; receipt: ExecutionReceipt } | { kind: "undelivered"; reason: string };

// ── Adapter ─────────────────────────────────────────────────────────

export class SovereignDelegationAdapter implements StepDelegationAdapter {
  /**
   * Signatures of payments this adapter made. Handed to `confirmSend` so a
   * lookup after a failed send never mistakes one of them for the new one.
   */
  private readonly paidSignatures: string[] = [];

  constructor(private config: SovereignDelegationConfig) {}

  private now(): number {
    return (this.config.now ?? Date.now)();
  }

  private async buildHeaders(audience?: TokenAudience): Promise<Record<string, string>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const { authToken } = this.config;
    if (authToken != null && authToken !== "") {
      const token = typeof authToken === "function" ? await authToken(audience) : authToken;
      if (token !== "") headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
  }

  async delegateStep(
    step: PlanStep,
    timeoutMs: number,
    onTaskSubmitted?: (taskId: string) => void,
    crossStepExclude?: string[],
  ): Promise<DelegatedStepResult> {
    const maxRetries = this.config.maxRetries ?? 2;
    const excludeAgents: string[] = [...(crossStepExclude ?? [])];
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.attemptSovereignDelegation(
          step,
          timeoutMs,
          excludeAgents,
          onTaskSubmitted,
        );
        return result;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const failedAgentId = (lastError as DelegationError).failedAgentId;

        this.config.onDelegationFailure?.(step, attempt, lastError.message, failedAgentId);

        // Money may have moved and the outcome is not a verified failure:
        // any further attempt would be a second payment (#887). Surface it
        // exactly as it is.
        if ((lastError as DelegationError).terminal === true) {
          throw lastError;
        }

        if (failedAgentId) {
          excludeAgents.push(failedAgentId);
        }

        // Don't retry non-retryable errors
        if (
          lastError.message.includes("No candidates") ||
          lastError.message.includes("Insufficient")
        ) {
          break;
        }
      }
    }

    throw new Error(
      `Sovereign delegation failed after ${Math.min(excludeAgents.length, maxRetries) + 1} attempt(s) for step "${step.description}": ${lastError?.message ?? "unknown error"}`,
      { cause: lastError },
    );
  }

  private async attemptSovereignDelegation(
    step: PlanStep,
    timeoutMs: number,
    excludeAgents: string[],
    onTaskSubmitted?: (taskId: string) => void,
  ): Promise<DelegatedStepResult> {
    // ── Phase 1: DISCOVER ─────────────────────────────────────────
    const candidates = await this.discoverCandidates(step, excludeAgents);
    if (candidates.length === 0) {
      throw new Error("No candidates found for sovereign delegation");
    }

    const candidate = candidates[0]!;

    if (!candidate.endpoint_url) {
      const err = new Error("Candidate has no MCP endpoint URL");
      (err as DelegationError).failedAgentId = candidate.motebit_id;
      throw err;
    }
    if (!candidate.pay_to_address) {
      const err = new Error("Candidate has no wallet address");
      (err as DelegationError).failedAgentId = candidate.motebit_id;
      throw err;
    }

    const capability = step.required_capabilities?.[0] ?? "";

    // ── Paid-intent interlock — BEFORE any money moves ────────────
    this.refuseIfAlreadyPaid(candidate.motebit_id, capability);

    // ── Phase 2: PAY ──────────────────────────────────────────────
    const costMicro = this.estimateCost(candidate.pricing, step);
    const txHash = await this.pay(candidate, costMicro);
    this.paidSignatures.push(txHash);

    const sovereignTaskId = `sovereign:${candidate.motebit_id}:${txHash}`;
    const entry: SovereignPaidEntry = {
      workerMotebitId: candidate.motebit_id,
      capability,
      taskId: sovereignTaskId,
      txHash,
      paidMicro: costMicro,
      feeMicro: 0,
      recordedAt: this.now(),
    };

    // Record the payment before the task is presented: if this process
    // dies mid-call, every later session reads it as paid-unretrieved and
    // refuses to buy the same work again.
    this.ledgerWrite("record_in_flight", entry, (l) => l.recordInFlight(entry));
    onTaskSubmitted?.(sovereignTaskId);

    // ── Phase 3: EXECUTE ──────────────────────────────────────────
    const outcome = await this.executeMcpTask(
      candidate.endpoint_url,
      candidate.motebit_id,
      step.prompt,
      txHash,
      timeoutMs,
    );
    if (outcome.kind === "undelivered") {
      throw this.paidUnretrieved(entry, outcome.reason);
    }
    const receipt = outcome.receipt;

    // ── Phase 4: RECEIPT ──────────────────────────────────────────
    // Verify the receipt's signature using the embedded public key
    let verified = false;
    if (receipt.public_key) {
      const pubKey = this.config.hexToBytes(receipt.public_key);
      verified = await this.config.verifyReceipt(receipt, pubKey);
      if (!verified) {
        const err = this.paidUnretrieved(entry, "receipt signature verification failed");
        err.failedAgentId = candidate.motebit_id;
        throw err;
      }
    }

    if (receipt.status !== "completed") {
      // Only a failure the paid worker itself signed, and that verified, is
      // a real failure that may be retried with another worker. Anything
      // else could be a lost or forged answer for work that was paid for.
      if (!verified || receipt.motebit_id !== candidate.motebit_id) {
        const err = this.paidUnretrieved(
          entry,
          `worker answered "${receipt.status}" without a receipt it verifiably signed`,
        );
        err.failedAgentId = candidate.motebit_id;
        throw err;
      }
      this.ledgerWrite("resolve", entry, (l) => {
        l.resolve(sovereignTaskId);
      });
      const err = new Error(
        `Delegated step ${receipt.status}: ${receipt.result} (paid tx ${txHash})`,
      ) as DelegationError;
      err.failedAgentId = receipt.motebit_id;
      throw err;
    }

    this.ledgerWrite("resolve", entry, (l) => {
      l.resolve(sovereignTaskId);
    });
    return {
      step_id: step.step_id,
      task_id: sovereignTaskId,
      receipt,
      result_text: receipt.result,
    };
  }

  // ── Payment ─────────────────────────────────────────────────────

  /**
   * Refuse, before any broadcast, a payment to a worker that already holds
   * a paid, unretrieved result for this capability (or when too many paid
   * results are outstanding). A ledger that cannot answer also refuses:
   * nothing has moved yet, so refusing is free.
   */
  private refuseIfAlreadyPaid(workerMotebitId: string, capability: string): void {
    const ledger = this.config.paidLedger;
    if (ledger == null) return;
    let verdict: ReturnType<SovereignPaidLedger["check"]>;
    try {
      verdict = ledger.check(workerMotebitId, capability);
    } catch (err: unknown) {
      throw terminal(
        `Refused before payment: the paid-intent ledger could not be read (${
          err instanceof Error ? err.message : String(err)
        }). No money moved.`,
      );
    }
    if (!verdict.locked) return;
    const prior = verdict.prior;
    throw terminal(
      verdict.scope === "pair"
        ? `Refused before payment: worker ${workerMotebitId} already holds a paid, unretrieved ` +
            `result for "${prior.capability}" (tx ${prior.txHash}, task ${prior.taskId}). ` +
            `No money moved. Recover or dismiss it (/result) before hiring again.`
        : `Refused before payment: paid delegations are outstanding without results — all new ` +
            `paid delegation is suspended. Oldest: tx ${prior.txHash}, task ${prior.taskId}. ` +
            `No money moved.`,
    );
  }

  /**
   * Pay `costMicro` to the candidate and return the transaction signature.
   * A thrown `send` is resolved through the wallet's read-only confirmation
   * before it can count as "not paid".
   */
  private async pay(candidate: DiscoveredCandidate, costMicro: number): Promise<string> {
    const toAddress = candidate.pay_to_address!;
    const microAmount = BigInt(costMicro);
    const sentAtMs = this.now();
    try {
      const result = await this.config.walletRail.send(toAddress, microAmount);
      return result.signature;
    } catch (sendErr: unknown) {
      const failedAtMs = this.now();
      const sendMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      const verdict = await this.confirmPayment({
        toAddress,
        microAmount,
        sentAtMs,
        failedAtMs,
        error: sendErr,
      });
      if (verdict.status === "landed") return verdict.signature;
      if (verdict.status === "absent") {
        const payErr = new Error(`Payment failed: ${sendMsg}`, { cause: sendErr });
        (payErr as DelegationError).failedAgentId = candidate.motebit_id;
        throw payErr;
      }
      throw terminal(
        `Payment status unknown (${costMicro} micro to worker ${candidate.motebit_id} at ` +
          `${toAddress}; the send failed with "${sendMsg}" and whether it landed could not be ` +
          `confirmed: ${verdict.reason}). Not retried — check the wallet's history before ` +
          `paying again.`,
        sendErr,
      );
    }
  }

  /**
   * Ask the wallet whether a failed send landed, waiting (bounded) while a
   * broadcast could still land. Never returns `pending`.
   */
  private async confirmPayment(query: {
    toAddress: string;
    microAmount: bigint;
    sentAtMs: number;
    failedAtMs: number;
    error: unknown;
  }): Promise<Exclude<SovereignSendConfirmation, { status: "pending" }>> {
    const rail = this.config.walletRail;
    if (typeof rail.confirmSend !== "function") {
      return { status: "unknown", reason: "this wallet cannot confirm a failed send" };
    }
    const deadline =
      query.failedAtMs +
      (this.config.paymentConfirmMaxWaitMs ?? DEFAULT_PAYMENT_CONFIRM_MAX_WAIT_MS);
    const sleep = this.config.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    // A pending verdict names the moment absence becomes authoritative, so
    // two looks suffice; the third is slack for a clock that ran short.
    for (let look = 0; look < 3; look++) {
      let verdict: SovereignSendConfirmation;
      try {
        verdict = await rail.confirmSend({
          ...query,
          excludeSignatures: [...this.paidSignatures],
        });
      } catch (err: unknown) {
        return { status: "unknown", reason: err instanceof Error ? err.message : String(err) };
      }
      if (verdict.status !== "pending") return verdict;
      if (verdict.recheckAtMs > deadline) break;
      await sleep(Math.max(0, verdict.recheckAtMs - this.now()));
    }
    return {
      status: "unknown",
      reason: "the transfer could still land and the confirmation window ran out",
    };
  }

  /**
   * The step stops here: money moved to this worker and no verifiable
   * result came back. The payment moves to UNRETRIEVED on the ledger (the
   * pair lock and the suspend count now apply), and no further attempt is
   * made — a new attempt would pay again.
   */
  private paidUnretrieved(entry: SovereignPaidEntry, reason: string): DelegationError {
    this.ledgerWrite("record_unretrieved", entry, (l) => l.recordSettledUnretrieved(entry));
    const err = terminal(
      `Paid, result not retrieved (tx ${entry.txHash}, worker ${entry.workerMotebitId}): ` +
        `${reason}. Not retried — another attempt would pay again. The payment is recorded ` +
        `as outstanding (task ${entry.taskId}).`,
    );
    err.paidTxHash = entry.txHash;
    return err;
  }

  /** Ledger writes never abort a paid flow (#884): a failed write is logged loudly. */
  private ledgerWrite(
    op: string,
    entry: SovereignPaidEntry,
    fn: (ledger: SovereignPaidLedger) => void,
  ): void {
    const ledger = this.config.paidLedger;
    if (ledger == null) return;
    try {
      fn(ledger);
    } catch (err: unknown) {
      const logger = this.config.logger ?? {
        // A failed money-ledger write must be loud even with no logger injected.
        // eslint-disable-next-line no-console
        warn: (m: string, c?: Record<string, unknown>) => console.warn(m, c),
      };
      logger.warn("paid_intent_ledger.write_failed", {
        op,
        taskId: entry.taskId,
        txHash: entry.txHash,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Discovery ───────────────────────────────────────────────────

  private async discoverCandidates(
    step: PlanStep,
    excludeAgents: string[],
  ): Promise<DiscoveredCandidate[]> {
    const { discoveryUrl, routingStrategy } = this.config;
    const capability = step.required_capabilities?.[0] ?? "";

    const params = new URLSearchParams();
    if (capability !== "") params.set("capability", capability);
    if (routingStrategy != null) params.set("routing_strategy", routingStrategy);
    params.set("limit", "10");

    const headers = await this.buildHeaders("market:query");
    const resp = await fetch(`${discoveryUrl}/api/v1/market/candidates?${params.toString()}`, {
      headers,
    });

    if (!resp.ok) {
      throw new Error(`Discovery failed (${resp.status}): ${await resp.text()}`);
    }

    const data = (await resp.json()) as {
      candidates: Array<{
        motebit_id: string;
        composite: number;
        endpoint_url: string | null;
        pay_to_address: string | null;
        pricing: Array<{ capability: string; unit_cost: number; currency: string; per: string }>;
        is_online: boolean;
      }>;
    };

    const excludeSet = new Set(excludeAgents);
    return data.candidates
      .filter((c) => !excludeSet.has(c.motebit_id))
      .filter((c) => c.is_online)
      .filter((c) => c.endpoint_url != null && c.pay_to_address != null);
  }

  // ── Cost estimation ─────────────────────────────────────────────

  private estimateCost(
    pricing: Array<{ capability: string; unit_cost: number; per: string }>,
    _step: PlanStep,
  ): number {
    // Use the first task-level pricing, or default to 500000 micro-units ($0.50)
    const taskPricing = pricing.find((p) => p.per === "task");
    return taskPricing?.unit_cost ?? 500_000;
  }

  // ── MCP task execution ──────────────────────────────────────────

  /**
   * Present the paid task once. Never throws: a timeout, a transport error,
   * or an answer that is not a receipt is `undelivered` — the caller must
   * not read any of them as "the worker failed, try another" (#887).
   */
  private async executeMcpTask(
    mcpUrl: string,
    workerMotebitId: string,
    prompt: string,
    txHash: string,
    timeoutMs: number,
  ): Promise<McpOutcome> {
    const { motebitId, deviceId, signingKeys, walletRail } = this.config;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const undelivered = (reason: string): McpOutcome => ({ kind: "undelivered", reason });

    try {
      // A fresh signed token per HTTP request (#957): aud "mcp:call", bound
      // to the worker the relay listed (`sub`). The worker accepts each token
      // once and only if it names that worker, so a token leaked from this
      // call cannot authenticate anywhere else or twice.
      const headers = async (sid?: string): Promise<Record<string, string>> => {
        const { token } = await this.config.mintAudienceToken(
          { mid: motebitId, did: deviceId, aud: MCP_CALL_AUDIENCE, sub: workerMotebitId },
          signingKeys.privateKey,
        );
        return {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          Authorization: `Bearer motebit:${token}`,
          ...(sid ? { "Mcp-Session-Id": sid } : {}),
        };
      };
      // A refused bearer is named in the outcome, never read as a silent miss.
      let authRefusal: string | undefined;

      let sessionId: string | undefined;
      let reqId = 0;

      // MCP call helper (mirrors services/web-search/src/index.ts:subDelegate)
      const mcpCall = async (method: string, params: unknown): Promise<unknown> => {
        const id = ++reqId;
        const resp = await fetch(mcpUrl, {
          method: "POST",
          headers: await headers(sessionId),
          body: JSON.stringify({ jsonrpc: "2.0", method, params, id }),
          signal: controller.signal,
        });
        const sid = resp.headers.get("mcp-session-id");
        if (sid) sessionId = sid;
        const ct = resp.headers.get("content-type") ?? "";
        if (ct.includes("text/event-stream")) {
          const text = await resp.text();
          for (const line of text.split("\n")) {
            if (line.startsWith("data: ")) {
              try {
                const parsed = JSON.parse(line.slice(6)) as { id?: number; result?: unknown };
                if (parsed.id === id) return parsed;
              } catch {
                /* skip */
              }
            }
          }
          return null;
        }
        if (resp.status === 401) {
          authRefusal = (await resp.text().catch(() => "")).slice(0, 400);
          return null;
        }
        if (!resp.ok) return null;
        return resp.json();
      };

      // Initialize MCP session
      const init = (await mcpCall("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "sovereign-delegation", version: "0.1.0" },
      })) as { result?: unknown } | null;
      if (init == null || !("result" in (init as Record<string, unknown>))) {
        if (authRefusal != null) {
          return undelivered(`the worker refused this client's MCP bearer (401): ${authRefusal}`);
        }
        return undelivered("the worker's MCP endpoint did not initialize a session");
      }

      // Send initialized notification
      await fetch(mcpUrl, {
        method: "POST",
        headers: await headers(sessionId),
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
        signal: controller.signal,
      });

      // Call motebit_task — no relay_task_id (sovereign)
      // Include payment proof so the agent knows it was paid
      const taskResult = (await mcpCall("tools/call", {
        name: "motebit_task",
        arguments: {
          prompt,
          sovereign_payment: {
            rail: walletRail.chain,
            tx_hash: txHash,
            payer_motebit_id: motebitId,
          },
        },
      })) as { result?: { content?: Array<{ type: string; text?: string }> } } | null;

      if (!taskResult?.result?.content) {
        return undelivered("no motebit_task result arrived");
      }

      const text = taskResult.result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      const cleaned = text.replace(/\n?\[motebit:[^\]]+\]\s*$/, "");

      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        return undelivered(`the worker answered without a receipt: "${cleaned.slice(0, 200)}"`);
      }

      // Validate receipt shape — reject malformed responses from untrusted agents
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as Record<string, unknown>).task_id !== "string" ||
        typeof (parsed as Record<string, unknown>).motebit_id !== "string" ||
        typeof (parsed as Record<string, unknown>).signature !== "string"
      ) {
        return undelivered("the worker's answer is not a receipt (malformed)");
      }

      return { kind: "receipt", receipt: parsed as ExecutionReceipt };
    } catch (err: unknown) {
      if (controller.signal.aborted) {
        return undelivered(`the MCP call timed out after ${timeoutMs}ms`);
      }
      return undelivered(
        `the MCP call failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  // No relay state to poll for sovereign delegation
  pollTaskResult(_taskId: string, _stepId: string): Promise<DelegatedStepResult | null> {
    return Promise.resolve(null);
  }
}

/** Internal error type carrying the failed agent's ID for exclusion. */
interface DelegationError extends Error {
  failedAgentId?: string;
  /** No further attempt may be made — one could pay a second time (#887). */
  terminal?: boolean;
  /** The payment this step made, when one is known to have moved. */
  paidTxHash?: string;
}

function terminal(message: string, cause?: unknown): DelegationError {
  const err = new Error(message, cause !== undefined ? { cause } : undefined) as DelegationError;
  err.terminal = true;
  return err;
}
