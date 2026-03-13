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

  async delegateStep(step: PlanStep, timeoutMs: number): Promise<DelegatedStepResult> {
    const { syncUrl, motebitId, authToken, onCustomMessage } = this.config;

    // Submit task to relay
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (authToken != null && authToken !== "") {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    const resp = await fetch(`${syncUrl}/agent/${motebitId}/task`, {
      method: "POST",
      headers,
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
}
