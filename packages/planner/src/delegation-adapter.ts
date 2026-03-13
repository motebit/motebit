import type { PlanStep, DelegatedStepResult, ExecutionReceipt } from "@motebit/sdk";
import type { StepDelegationAdapter } from "./plan-engine.js";

export interface RelayDelegationConfig {
  syncUrl: string;
  motebitId: string;
  authToken?: string;
  sendRaw: (data: string) => void;
  onCustomMessage: (cb: (msg: { type: string; [key: string]: unknown }) => void) => () => void;
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
    const { syncUrl, motebitId, onCustomMessage } = this.config;

    const resp = await fetch(`${syncUrl}/agent/${motebitId}/task`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        prompt: step.prompt,
        submitted_by: "plan_engine",
        required_capabilities: step.required_capabilities,
        step_id: step.step_id,
      }),
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
        reject(new Error(`Delegation timed out after ${timeoutMs}ms for step "${step.description}"`));
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
          reject(new Error(`Delegated step ${receipt.status}: ${receipt.result}`));
        }
      });
    });
  }

  async pollTaskResult(taskId: string, stepId: string): Promise<DelegatedStepResult | null> {
    const { syncUrl, motebitId } = this.config;

    try {
      const resp = await fetch(`${syncUrl}/agent/${motebitId}/task/${taskId}`, {
        headers: this.buildHeaders(),
      });

      if (!resp.ok) return null; // Task not found (expired) or auth error

      const data = (await resp.json()) as { task: { status: string }; receipt: ExecutionReceipt | null };

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
