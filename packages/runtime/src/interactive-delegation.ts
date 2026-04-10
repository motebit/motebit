/**
 * Interactive Delegation — delegate_to_agent tool registration and receipt management.
 *
 * Extracted from MotebitRuntime. Registers a tool that submits tasks to the relay
 * via REST, polls for results, bumps trust on verified receipts, and returns the
 * result as normal tool output.
 */

import type { ExecutionReceipt, ToolRegistry } from "@motebit/sdk";

/** ToolRegistry extended with `has()` — matches SimpleToolRegistry in MotebitRuntime. */
interface ToolRegistryWithHas extends ToolRegistry {
  has(name: string): boolean;
}

// === Types ===

export interface InteractiveDelegationDeps {
  motebitId: string;
  logger: { warn(message: string, context?: Record<string, unknown>): void };
  toolRegistry: ToolRegistryWithHas;
  /** Maps tool names to motebit server names (only for motebit MCP adapters). */
  motebitToolServers: Map<string, string>;
  /** Set the credential submitter on the credential manager. */
  setCredentialSubmitter: (
    submitter: (
      vc: import("@motebit/encryption").VerifiableCredential<unknown>,
      targetMotebitId: string,
    ) => Promise<void>,
  ) => void;
  /** Bump trust for a remote agent based on a verified receipt. */
  bumpTrustFromReceipt: (receipt: ExecutionReceipt) => Promise<void>;
  /** Re-wire loop deps so newly registered tools are visible to the agentic loop. */
  wireLoopDeps: () => void;
}

export interface InteractiveDelegationConfig {
  syncUrl: string;
  authToken: (audience?: string) => Promise<string>;
  timeoutMs?: number;
  routingStrategy?: "cost" | "quality" | "balanced";
}

// === Manager ===

export class InteractiveDelegationManager {
  private receipts: ExecutionReceipt[] = [];

  constructor(private readonly deps: InteractiveDelegationDeps) {}

  /**
   * Register the `delegate_to_agent` tool for interactive delegation.
   *
   * The tool submits tasks to the relay via REST, polls for results, bumps trust
   * on verified receipts, and returns the result as normal tool output.
   */
  enable(config: InteractiveDelegationConfig): void {
    const TOOL_NAME = "delegate_to_agent";

    // Avoid double-registration
    if (this.deps.toolRegistry.has(TOOL_NAME)) return;

    // Wire credential submission to relay — credentials issued by bumpTrustFromReceipt
    // are submitted to the relay for routing indexing. The subject agent (the one we
    // delegated to) gets the credential pushed to its relay profile.
    const { logger } = this.deps;
    this.deps.setCredentialSubmitter(async (vc, targetMotebitId) => {
      try {
        const token = await config.authToken();
        const resp = await fetch(
          `${config.syncUrl}/api/v1/agents/${encodeURIComponent(targetMotebitId)}/credentials/submit`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${token}`,
            },
            body: JSON.stringify({ credentials: [vc] }),
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!resp.ok) {
          logger.warn("credential relay submission rejected", {
            status: resp.status,
            targetMotebitId,
          });
        }
      } catch (err: unknown) {
        logger.warn("credential relay submission failed", {
          error: err instanceof Error ? err.message : String(err),
          targetMotebitId,
        });
      }
    });

    const timeoutMs = config.timeoutMs ?? 120_000;
    const motebitId = this.deps.motebitId;
    const bumpTrust = (receipt: ExecutionReceipt) => this.deps.bumpTrustFromReceipt(receipt);
    const stashReceipt = (receipt: ExecutionReceipt) => this.receipts.push(receipt);

    // Mark as delegation tool for processStream to emit delegation_start/complete
    this.deps.motebitToolServers.set(TOOL_NAME, "relay");

    this.deps.toolRegistry.register(
      {
        name: TOOL_NAME,
        description:
          "Delegate a task to a remote agent on the motebit network. " +
          "The relay routes to the best capable agent based on trust and capabilities. " +
          "Use when the user asks you to delegate, or when a task would benefit from " +
          "a specialized agent. Returns the agent's response text.",
        inputSchema: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description: "The task prompt to send to the remote agent.",
            },
            required_capabilities: {
              type: "array",
              items: { type: "string" },
              description:
                "Capabilities the target agent must have (e.g. ['web_search', 'read_url']). " +
                "Optional — if omitted, the relay routes based on the prompt alone.",
            },
          },
          required: ["prompt"],
        },
      },
      async (args: Record<string, unknown>) => {
        const prompt = args.prompt as string;
        const requiredCapabilities = args.required_capabilities as string[] | undefined;

        // Build audience-specific auth tokens.
        // The relay enforces aud binding: submit requires "task:submit",
        // polling requires "task:query". A single token won't work for both.
        let submitHeader: string;
        let queryHeader: string;
        try {
          const [submitToken, queryToken] = await Promise.all([
            config.authToken("task:submit"),
            config.authToken("task:query"),
          ]);
          submitHeader = `Bearer ${submitToken}`;
          queryHeader = `Bearer ${queryToken}`;
        } catch (err: unknown) {
          return {
            ok: false,
            error: `Auth failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        // Submit task to relay
        let taskId: string;
        let targetMotebitId: string;
        try {
          const body: Record<string, unknown> = {
            prompt,
            submitted_by: motebitId,
          };
          if (requiredCapabilities && requiredCapabilities.length > 0) {
            body.required_capabilities = requiredCapabilities;
          }
          if (config.routingStrategy) {
            body.routing_strategy = config.routingStrategy;
          }

          const resp = await fetch(`${config.syncUrl}/agent/${motebitId}/task`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: submitHeader,
              "Idempotency-Key": crypto.randomUUID(),
            },
            body: JSON.stringify(body),
          });

          if (!resp.ok) {
            const text = await resp.text();
            return { ok: false, error: `Task submission failed (${resp.status}): ${text}` };
          }

          const data = (await resp.json()) as {
            task_id: string;
            status: string;
            routing_choice?: Record<string, unknown>;
          };
          taskId = data.task_id;
          // Tasks are stored under Alice's motebitId (the submitter/owner)
          targetMotebitId = motebitId;
        } catch (err: unknown) {
          return {
            ok: false,
            error: `Submission error: ${err instanceof Error ? err.message : String(err)}`,
          };
        }

        // Poll for result
        const POLL_INTERVAL_MS = 2000;
        const maxPolls = Math.ceil(timeoutMs / POLL_INTERVAL_MS);

        for (let i = 0; i < maxPolls; i++) {
          await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

          try {
            const resp = await fetch(`${config.syncUrl}/agent/${targetMotebitId}/task/${taskId}`, {
              headers: { Authorization: queryHeader },
            });
            if (!resp.ok) {
              logger.warn("delegation poll failed", {
                taskId,
                status: resp.status,
                body: await resp.text().catch(() => ""),
              });
              continue;
            }

            const data = (await resp.json()) as {
              task: { status: string };
              receipt: ExecutionReceipt | null;
            };

            if (data.receipt != null) {
              // Bump trust (best-effort)
              try {
                await bumpTrust(data.receipt);
              } catch {
                // Best-effort
              }

              // Stash receipt for handleAgentTask to drain into delegation_receipts
              stashReceipt(data.receipt);

              return { ok: true, data: data.receipt.result ?? "Task completed (no result text)" };
            }
          } catch {
            // Network hiccup — keep polling
          }
        }

        return { ok: false, error: `Delegation timed out after ${timeoutMs / 1000}s` };
      },
    );

    // Re-wire loop deps so the tool is visible to the agentic loop
    this.deps.wireLoopDeps();
  }

  /**
   * Drain interactive delegation receipts (used by handleAgentTask to include
   * in the parent receipt's delegation_receipts array).
   */
  getAndResetReceipts(): ExecutionReceipt[] {
    const result = this.receipts.slice();
    this.receipts.length = 0;
    return result;
  }
}
