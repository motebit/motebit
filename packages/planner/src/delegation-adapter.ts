import type {
  PlanStep,
  DelegatedStepResult,
  ExecutionReceipt,
  CollaborativePlanProposal,
  ProposalResponse,
} from "@motebit/sdk";
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
  authToken?: string;
  sendRaw: (data: string) => void;
  onCustomMessage: (cb: (msg: { type: string; [key: string]: unknown }) => void) => () => void;
  /** Optional: returns agent's current exploration drive [0-1] from intelligence gradient, passed to relay for routing. */
  getExplorationDrive?: () => number | undefined;
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

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.config.authToken != null && this.config.authToken !== "") {
      headers["Authorization"] = `Bearer ${this.config.authToken}`;
    }
    return headers;
  }

  async delegateStep(
    step: PlanStep,
    timeoutMs: number,
    onTaskSubmitted?: (taskId: string) => void,
  ): Promise<DelegatedStepResult> {
    const maxRetries = this.config.maxDelegationRetries ?? 2;
    const excludeAgents: string[] = [];
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await this.attemptDelegation(
          step,
          timeoutMs,
          excludeAgents,
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
    onTaskSubmitted?: (taskId: string) => void,
  ): Promise<DelegatedStepResult> {
    const { syncUrl, motebitId, onCustomMessage } = this.config;

    const body: Record<string, unknown> = {
      prompt: step.prompt,
      submitted_by: "plan_engine",
      required_capabilities: step.required_capabilities,
      step_id: step.step_id,
      exploration_drive: this.config.getExplorationDrive?.(),
    };
    if (excludeAgents.length > 0) {
      body.exclude_agents = excludeAgents;
    }

    const resp = await fetch(`${syncUrl}/agent/${motebitId}/task`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Relay task submission failed (${resp.status}): ${text}`);
    }

    const { task_id } = (await resp.json()) as { task_id: string };

    // Persist task_id immediately so recovery can find it if we crash/close
    onTaskSubmitted?.(task_id);

    // Wait for task_result via WebSocket
    return new Promise<DelegatedStepResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        unsubscribe();
        reject(
          new Error(`Delegation timed out after ${timeoutMs}ms for step "${step.description}"`),
        );
      }, timeoutMs);

      const unsubscribe = onCustomMessage((msg) => {
        if (msg.type !== "task_result") return;
        if (msg.task_id !== task_id) return;

        clearTimeout(timer);
        unsubscribe();

        const receipt = msg.receipt as ExecutionReceipt | undefined;
        if (!receipt) {
          reject(new Error("Delegation completed but no receipt received"));
          return;
        }

        if (receipt.status === "completed") {
          resolve({
            step_id: step.step_id,
            task_id,
            receipt,
            result_text: receipt.result,
          });
        } else {
          // Attach the failed agent's ID to the error for exclusion
          const err = new Error(`Delegated step ${receipt.status}: ${receipt.result}`);
          (err as DelegationError).failedAgentId = receipt.motebit_id;
          reject(err);
        }
      });
    });
  }

  /** Extract the failed agent ID from an error if available. */
  private extractFailedAgentId(err: Error): string | undefined {
    return (err as DelegationError).failedAgentId;
  }

  async pollTaskResult(taskId: string, stepId: string): Promise<DelegatedStepResult | null> {
    const { syncUrl, motebitId } = this.config;

    try {
      const resp = await fetch(`${syncUrl}/agent/${motebitId}/task/${taskId}`, {
        headers: this.buildHeaders(),
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
}
