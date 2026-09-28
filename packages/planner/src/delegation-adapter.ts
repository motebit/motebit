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
    let lastError: Error | undefined;
    // One key per logical submission. A retry after a DELIVERY failure (the
    // result never reached us and the relay could not say how the task
    // ended) resubmits under the SAME key, so the relay replays the task it
    // already admitted instead of admitting — and charging for — a second
    // one. Only a task that conclusively FAILED gets a new key: that retry is
    // meant to be a new task, routed away from the agent that failed (#816).
    let idempotencyKey = crypto.randomUUID();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.attemptDelegation(
          step,
          timeoutMs,
          excludeAgents,
          idempotencyKey,
          // Only call onTaskSubmitted for the first attempt (task_id tracking)
          attempt === 0 ? onTaskSubmitted : undefined,
        );
        return result;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const failedAgentId = this.extractFailedAgentId(lastError);

        // Record the failure for trust demotion
        this.config.onDelegationFailure?.(step, attempt, lastError.message, failedAgentId);

        // Exclude the failed agent from next attempt
        if (failedAgentId) {
          excludeAgents.push(failedAgentId);
        }
        if ((lastError as DelegationError).deliveryUncertain !== true) {
          idempotencyKey = crypto.randomUUID();
        }

        // Don't retry non-retryable errors (submission failures, not timeouts)
        if (lastError.message.includes("Relay task submission failed")) {
          break;
        }
      }
    }

    throw new Error(
      `Delegation failed after ${Math.min(excludeAgents.length, maxRetries) + 1} attempt(s) for step "${step.description}": ${lastError?.message ?? "unknown error"}`,
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
    const resp = await fetch(`${syncUrl}/agent/${motebitId}/task`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

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

    const taskResp = (await resp.json()) as {
      task_id: string;
      routing_choice?: DelegatedStepResult["routing_choice"];
    };
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
