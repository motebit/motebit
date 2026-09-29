import type {
  PlanStep,
  DelegatedStepResult,
  ExecutionReceipt,
  CollaborativePlanProposal,
  ProposalResponse,
} from "@motebit/sdk";
import type { TokenAudience } from "@motebit/sdk";
import type { StepDelegationAdapter } from "./plan-engine.js";

export interface StepResult {
  status: string;
  result_summary: string;
  receipt?: ExecutionReceipt;
}

export interface CollaborativeDelegationAdapter {
  submitProposal(proposal: CollaborativePlanProposal, steps: PlanStep[]): Promise<void>;
  postStepResult(proposalId: string, stepId: string, result: StepResult): Promise<void>;
  onProposalResponse(cb: (response: ProposalResponse) => void): () => void;
  onStepResult(cb: (proposalId: string, stepId: string, result: StepResult) => void): () => void;
}

export interface RelayDelegationConfig {
  syncUrl: string;
  motebitId: string;
  /**
   * Mints the bearer for one relay call, given the audience that call's route
   * verifies: `task:submit` for the submission, `task:query` for the poll.
   * A factory, never a static token: a device token is bound to ONE audience,
   * so any single string fails one of the two routes. Static strings were
   * accepted here and three surfaces passed their `sync` socket token, so
   * plan-step delegation was refused on both routes (#827). An operator with a
   * master token passes `async () => masterToken`.
   */
  authToken?: (audience: TokenAudience) => Promise<string>;
  sendRaw: (data: string) => void;
  onCustomMessage: (cb: (msg: { type: string; [key: string]: unknown }) => void) => () => void;
  /** Optional: returns agent's current exploration drive [0-1] from intelligence gradient, passed to relay for routing. */
  getExplorationDrive?: () => number | undefined;
  /** Routing strategy for agent selection: cost, quality, or balanced. */
  routingStrategy?: "cost" | "quality" | "balanced";
  /** Max retry attempts on delegation failure (default 2, so up to 3 total attempts). */
  maxDelegationRetries?: number;
  /** Called on each failed delegation attempt — lets the caller record failures for trust demotion. */
  onDelegationFailure?: (
    step: PlanStep,
    attempt: number,
    error: string,
    failedAgentId?: string,
  ) => void;
}

export class RelayDelegationAdapter implements StepDelegationAdapter {
  constructor(private config: RelayDelegationConfig) {}

  private async buildHeaders(audience: TokenAudience): Promise<Record<string, string>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const { authToken } = this.config;
    if (authToken != null) {
      const token = await authToken(audience);
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
    const maxRetries = this.config.maxDelegationRetries ?? 2;
    const excludeAgents: string[] = [...(crossStepExclude ?? [])];
    let lastError: DelegationError | undefined;
    // One key per logical submission. A retry after a DELIVERY failure (the
    // result never reached us and the relay could not say how the task
    // ended) resubmits under the SAME key, so the relay replays the task it
    // already admitted instead of admitting — and charging for — a second
    // one. Only a task that conclusively FAILED gets a new key: that retry is
    // meant to be a new task, routed away from the agent that failed (#816).
    //
    // The key is DERIVED from the step, never random (#890): two drivers
    // that ever submit the same step — a reconnect's recovery racing a
    // scheduler's resume — present the same key, and the relay admits one
    // task for both.
    let rotation = 0;
    let idempotencyKey = planStepIdempotencyKey(step, rotation);
    let attempts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      attempts++;
      try {
        const result = await this.attemptDelegation(
          step,
          timeoutMs,
          excludeAgents,
          idempotencyKey,
          // Every attempt: a same-key retry can be the first to learn the
          // task id (attempt 0's POST threw), and recovery needs it.
          onTaskSubmitted,
        );
        return result;
      } catch (err: unknown) {
        // Undetermined: the task may have been admitted and may still
        // complete. Not a failure — no demotion, no retry, no new task.
        if (err instanceof DelegationUndeterminedError) throw err;
        lastError = err instanceof Error ? err : new Error(String(err));
        const failedAgentId = this.extractFailedAgentId(lastError);

        // Record the failure for trust demotion
        this.config.onDelegationFailure?.(step, attempt, lastError.message, failedAgentId);

        // Exclude the failed agent from next attempt
        if (failedAgentId) {
          excludeAgents.push(failedAgentId);
        }
        if (lastError.deliveryUncertain !== true) {
          rotation++;
          idempotencyKey = planStepIdempotencyKey(step, rotation);
        }

        // Don't retry non-retryable errors (submission failures, not timeouts)
        if (lastError.message.includes("Relay task submission failed")) {
          break;
        }
      }
    }

    // Out of attempts while the relay never said the task ended: it may have
    // been admitted and may still complete, so this is not a failure either.
    if (lastError?.deliveryUncertain === true) {
      throw new DelegationUndeterminedError(step.description, lastError);
    }
    throw new Error(
      `Delegation failed after ${attempts} attempt(s) for step "${step.description}": ${lastError?.message ?? "unknown error"}`,
      { cause: lastError },
    );
  }

  private async attemptDelegation(
    step: PlanStep,
    timeoutMs: number,
    excludeAgents: string[],
    idempotencyKey: string,
    onTaskSubmitted?: (taskId: string) => void,
  ): Promise<DelegatedStepResult> {
    const { syncUrl, motebitId } = this.config;

    const body: Record<string, unknown> = {
      prompt: step.prompt,
      submitted_by: "plan_engine",
      required_capabilities: step.required_capabilities,
      step_id: step.step_id,
      exploration_drive: this.config.getExplorationDrive?.(),
    };
    if (this.config.routingStrategy) {
      body.routing_strategy = this.config.routingStrategy;
    }
    if (excludeAgents.length > 0) {
      body.exclude_agents = excludeAgents;
    }

    const headers = await this.buildHeaders("task:submit");
    headers["Idempotency-Key"] = idempotencyKey;
    // The POST stays here, beside the audience it carries (`task:submit`);
    // submitUnderKey only decides when to send it again.
    const resp = await submitUnderKey(
      () =>
        fetch(`${syncUrl}/agent/${motebitId}/task`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      timeoutMs,
      step.description,
    );

    if (!resp.ok) {
      const text = await resp.text();
      // Surface x402 payment requirement so callers can handle budget exhaustion
      if (resp.status === 402) {
        let detail = text;
        try {
          const parsed = JSON.parse(text) as { estimated_cost?: number; message?: string };
          detail = parsed.message ?? `Payment required: ${parsed.estimated_cost ?? "unknown"} USDC`;
        } catch {
          // Use raw text
        }
        throw new Error(`Payment required (HTTP 402): ${detail}`);
      }
      throw new Error(`Relay task submission failed (${resp.status}): ${text}`);
    }

    let taskResp: { task_id: string; routing_choice?: DelegatedStepResult["routing_choice"] };
    try {
      taskResp = (await resp.json()) as typeof taskResp;
    } catch (err: unknown) {
      // Admitted (2xx), but the answer never arrived whole: same key again.
      throw deliveryUncertain("Relay task submission unconfirmed: response body lost", err);
    }
    const { task_id } = taskResp;
    const routingChoice = taskResp.routing_choice;

    // Persist task_id immediately so recovery can find it if we crash/close
    onTaskSubmitted?.(task_id);

    const settle = (receipt: ExecutionReceipt): DelegatedStepResult => {
      if (receipt.status === "completed") {
        return {
          step_id: step.step_id,
          task_id,
          receipt,
          result_text: receipt.result,
          routing_choice: routingChoice ?? undefined,
        };
      }
      // Attach the failed agent's ID to the error for exclusion
      const err = new Error(`Delegated step ${receipt.status}: ${receipt.result}`);
      (err as DelegationError).failedAgentId = receipt.motebit_id;
      throw err;
    };

    // Wait for task_result via WebSocket
    const pushed = await this.waitForResultFrame(task_id, timeoutMs);
    if (pushed !== null) return settle(pushed);

    // No result frame in time. That is a DELIVERY failure, not a task
    // failure (#433): the socket that would have carried it may have been
    // replaced or dropped. Ask the relay how the SAME task ended before
    // anything resubmits it (#816).
    let remaining = timeoutMs;
    for (;;) {
      const state = await this.queryTask(task_id);
      if (state.kind === "receipt") return settle(state.receipt);
      if (state.kind === "not_found") {
        // The task left the relay's queue without a receipt (a receipt
        // extends its lifetime), so no result is coming. Terminal for THIS
        // task: retry as a new task, never replay the dead task id.
        const err: DelegationError = new Error(
          `Delegated task ${task_id} expired at the relay without a result`,
        );
        const agent = routingChoice?.selected_agent;
        if (agent != null && agent !== "") err.failedAgentId = agent;
        throw err;
      }
      if (state.kind !== "pending" || remaining <= 0) {
        const err = new Error(
          `Delegation timed out after ${timeoutMs}ms for step "${step.description}" (relay: ${state.kind})`,
        );
        (err as DelegationError).deliveryUncertain = true;
        throw err;
      }
      // Still running: keep listening, and ask again — bounded by one more
      // timeout's worth of waiting.
      const wait = Math.min(RESULT_POLL_INTERVAL_MS, remaining);
      remaining -= wait;
      const late = await this.waitForResultFrame(task_id, wait);
      if (late !== null) return settle(late);
    }
  }

  /** Resolves with the task's receipt from a task_result frame, or null after `ms`. */
  private waitForResultFrame(taskId: string, ms: number): Promise<ExecutionReceipt | null> {
    const { onCustomMessage } = this.config;
    return new Promise<ExecutionReceipt | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        resolve(null);
      }, ms);

      const unsubscribe = onCustomMessage((msg) => {
        if (msg.type !== "task_result") return;
        if (msg.task_id !== taskId) return;

        clearTimeout(timer);
        unsubscribe();

        const receipt = msg.receipt as ExecutionReceipt | undefined;
        if (!receipt) {
          reject(new Error("Delegation completed but no receipt received"));
          return;
        }
        resolve(receipt);
      });
    });
  }

  /**
   * Ask the relay how a task stands (authenticated `task:query`, the same
   * route `pollTaskResult` uses): a receipt, still pending, gone, or no
   * answer at all.
   */
  private async queryTask(
    taskId: string,
  ): Promise<
    | { kind: "receipt"; receipt: ExecutionReceipt }
    | { kind: "pending" }
    | { kind: "not_found" }
    | { kind: "unreachable" }
  > {
    const { syncUrl, motebitId } = this.config;
    try {
      const resp = await fetch(`${syncUrl}/agent/${motebitId}/task/${taskId}`, {
        headers: await this.buildHeaders("task:query"),
      });
      if (resp.status === 404) return { kind: "not_found" };
      if (!resp.ok) return { kind: "unreachable" };
      const data = (await resp.json()) as { receipt?: ExecutionReceipt | null };
      if (data.receipt != null) return { kind: "receipt", receipt: data.receipt };
      return { kind: "pending" };
    } catch {
      return { kind: "unreachable" };
    }
  }

  /** Extract the failed agent ID from an error if available. */
  private extractFailedAgentId(err: Error): string | undefined {
    return (err as DelegationError).failedAgentId;
  }

  async pollTaskResult(taskId: string, stepId: string): Promise<DelegatedStepResult | null> {
    const { syncUrl, motebitId } = this.config;

    try {
      const resp = await fetch(`${syncUrl}/agent/${motebitId}/task/${taskId}`, {
        headers: await this.buildHeaders("task:query"),
      });

      if (!resp.ok) return null; // Task not found (expired) or auth error

      const data = (await resp.json()) as {
        task: { status: string };
        receipt: ExecutionReceipt | null;
      };

      if (data.receipt == null) return null; // Task still pending/running

      return {
        step_id: stepId,
        task_id: taskId,
        receipt: data.receipt,
        result_text: data.receipt.result,
      };
    } catch {
      return null; // Network error — caller should retry later
    }
  }
}

/** Internal error type carrying the failed agent's ID for exclusion. */
interface DelegationError extends Error {
  failedAgentId?: string;
  /**
   * The result was not delivered and the relay could not say how the task
   * ended: the retry resubmits under the same Idempotency-Key.
   */
  deliveryUncertain?: boolean;
}

/** While the relay reports a timed-out task as still running, how often to ask again. */
const RESULT_POLL_INTERVAL_MS = 15_000;

/** First backoff after a 409; doubles each time, capped (1s, 2s, 4s, … 30s). */
const SUBMIT_CONFLICT_BACKOFF_MS = 1_000;
const SUBMIT_CONFLICT_BACKOFF_MAX_MS = 30_000;

/**
 * The step's outcome is UNDETERMINED: the relay may have admitted the task,
 * and it may still complete, but nothing confirmed it within the step's time
 * budget. Not a failure: it demotes no agent and triggers no retry, because
 * running the step again could run — and pay for — the task twice (#816).
 */
export class DelegationUndeterminedError extends Error {
  readonly undetermined = true;
  constructor(stepDescription: string, cause?: unknown) {
    super(
      `Submission unconfirmed — the task may still complete; check /result (step "${stepDescription}")`,
      cause !== undefined ? { cause } : undefined,
    );
    this.name = "DelegationUndeterminedError";
  }
}

/**
 * The Idempotency-Key a plan step's submission carries: derived from the
 * plan, the step, and how many times the step was conclusively failed and
 * re-routed (`rotation`), never random (#890). Every submission of the same
 * attempt of the same step — from any driver, in any process — carries the
 * same key, so the relay admits (and charges for) at most one task for it.
 */
export function planStepIdempotencyKey(
  step: Pick<PlanStep, "plan_id" | "step_id">,
  rotation: number,
): string {
  return `plan-step:${step.plan_id}:${step.step_id}:${rotation}`;
}

/**
 * Is this error the "paid outcome unknown" signal, anywhere in its cause
 * chain? True for `DelegationUndeterminedError` and for any error that
 * carries `undetermined === true` (the sovereign adapter's terminal errors,
 * #887). A caller that sees it must not start the same work again until
 * the outcome is resolved from the relay's task state or the receipt
 * (#890) — it is not a failure.
 */
export function isDelegationUndetermined(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e instanceof Error && depth < 16; e = e.cause, depth++) {
    if ((e as { undetermined?: unknown }).undetermined === true) return true;
  }
  return false;
}

function deliveryUncertain(message: string, cause?: unknown): DelegationError {
  const err: DelegationError = new Error(message, cause !== undefined ? { cause } : undefined);
  err.deliveryUncertain = true;
  return err;
}

/**
 * Send a task submission (`post`, which POSTs under its Idempotency-Key). Two answers are not a
 * relay rejection, and neither means "not admitted" (#816):
 * - the fetch throws — the request may have reached the relay and the
 *   response been lost;
 * - 409 — the relay is still processing an earlier request under the same
 *   key.
 * A 409 is retried here with backoff, under the same key and within the
 * step's time budget: once the earlier request finishes, the relay replays
 * its 201 with the same task_id. A 409 that outlasts the budget ends the
 * step as undetermined. A thrown fetch is delivery-uncertain, so the
 * caller's retry keeps the key. Every other response is returned for the
 * caller to judge.
 */
async function submitUnderKey(
  post: () => Promise<Response>,
  budgetMs: number,
  stepDescription: string,
): Promise<Response> {
  let waited = 0;
  for (let conflict = 0; ; conflict++) {
    let resp: Response;
    try {
      resp = await post();
    } catch (err: unknown) {
      throw deliveryUncertain("Relay task submission unconfirmed: no response", err);
    }
    if (resp.status !== 409) return resp;
    // Still processing under this key: keep backing off, within the step's
    // own time budget, then end the step as undetermined.
    if (waited >= budgetMs) {
      throw new DelegationUndeterminedError(
        stepDescription,
        new Error("Relay task submission still being processed (409)"),
      );
    }
    const wait = Math.min(
      SUBMIT_CONFLICT_BACKOFF_MS * 2 ** conflict,
      SUBMIT_CONFLICT_BACKOFF_MAX_MS,
      budgetMs - waited,
    );
    waited += wait;
    await new Promise<void>((r) => setTimeout(r, wait));
  }
}
