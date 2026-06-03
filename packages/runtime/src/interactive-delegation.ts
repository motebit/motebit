/**
 * Interactive Delegation — delegate_to_agent tool registration and receipt management.
 *
 * Extracted from MotebitRuntime. Registers a tool that submits tasks to the relay
 * via REST, polls for results, bumps trust on verified receipts, and returns the
 * result as normal tool output.
 */

import type { ExecutionReceipt, ToolRegistry } from "@motebit/sdk";

import { selectAndRunDelegation } from "./relay-delegation.js";
import type { P2pPaymentProof, SovereignP2pPaymentRequest } from "@motebit/protocol";

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
  /**
   * The relay's Ed25519 public key (hex), PINNED at pairing. With
   * `buildP2pPayment`, a paid cross-agent `delegate_to_agent` call settles
   * peer-to-peer (treasury derived from this key, never a fetched response);
   * absent → relay-mediated. Surface-provided. See `relay-delegation.ts`
   * `selectAndRunDelegation` + `docs/doctrine/off-ramp-as-user-action.md` § Arc 3.5.
   */
  relayPublicKey?: string;
  /**
   * The sovereign rail's atomic multi-leg payment builder, bound by the runtime
   * from its `SovereignWalletRail` at enable time. Present only when a sovereign
   * wallet is configured.
   */
  buildP2pPayment?: (request: SovereignP2pPaymentRequest) => Promise<P2pPaymentProof>;
  /**
   * Cold-start opt-in: whether the user has consented to pay a worker they have
   * NO trust history with directly, peer-to-peer (the Arc-3 acknowledgment).
   * Without it, a first paid delegation to an unknown worker is ineligible for
   * P2P and degrades to relay-mode — so the `delegate_to_agent` tool MUST forward
   * it or the surface's "pay new agents directly" toggle is a no-op for chat-
   * driven delegation (the bug this closes). A function is read fresh per call so
   * toggling the preference takes effect without re-enabling — mirrors
   * `InvokeCapabilityConfig.acknowledgeNoHistoryRisk`.
   */
  acknowledgeNoHistoryRisk?: boolean | (() => boolean);
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
          logger.warn("credential relay submission http_failed", {
            status: resp.status,
            targetMotebitId,
          });
          return;
        }
        // The relay returns HTTP 200 even when it filters every credential
        // server-side (spec/credential-v1.md §23 — self-issued / signature-
        // failed / unknown-subject all collapse to a body-level rejection).
        // Inspect the body counts so silent server-side filtering surfaces
        // in the runtime logs, not just at status-code level.
        const body = (await resp.json().catch(() => null)) as {
          accepted?: number;
          rejected?: number;
          errors?: string[];
        } | null;
        if (body == null) return;
        const accepted = body.accepted ?? 0;
        const rejected = body.rejected ?? 0;
        if (rejected > 0) {
          logger.warn("credential relay submission body_rejected", {
            targetMotebitId,
            accepted,
            rejected,
            errors: body.errors ?? [],
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
        // Cross-motebit delegation sends the prompt + arguments to a
        // remote agent via the relay. Same outbound boundary as
        // web_search / read_url; the runtime's sensitivity gate
        // refuses to dispatch this tool when session_sensitivity is
        // medical/financial/secret AND the configured provider is not
        // sovereign.
        outbound: true,
      },
      async (args: Record<string, unknown>) => {
        const prompt = args.prompt as string;
        const requiredCapabilities = args.required_capabilities as string[] | undefined;

        // Resolve the cold-start ack fresh per call (a function reflects a live
        // surface toggle without re-enabling). Without forwarding this, a paid
        // delegation to a no-history worker is denied P2P eligibility and silently
        // degrades to relay-mode — the "pay new agents directly" toggle would be a
        // no-op for the AI-loop path.
        const ack =
          typeof config.acknowledgeNoHistoryRisk === "function"
            ? config.acknowledgeNoHistoryRisk()
            : config.acknowledgeNoHistoryRisk;

        const result = await selectAndRunDelegation({
          motebitId,
          syncUrl: config.syncUrl,
          authToken: config.authToken,
          prompt,
          ...(requiredCapabilities ? { requiredCapabilities } : {}),
          ...(config.buildP2pPayment ? { buildP2pPayment: config.buildP2pPayment } : {}),
          ...(config.relayPublicKey != null ? { relayPublicKey: config.relayPublicKey } : {}),
          ...(ack === true ? { acknowledgeNoHistoryRisk: true } : {}),
          ...(config.routingStrategy ? { routingStrategy: config.routingStrategy } : {}),
          invocationOrigin: "ai-loop",
          ...(timeoutMs != null ? { timeoutMs } : {}),
          logger,
        });

        if (!result.ok) {
          return { ok: false, error: `${result.error.code}: ${result.error.message}` };
        }

        // Bump trust (best-effort)
        try {
          await bumpTrust(result.receipt);
        } catch {
          // Best-effort
        }

        // Stash receipt for handleAgentTask to drain into delegation_receipts
        stashReceipt(result.receipt);

        return { ok: true, data: result.receipt.result ?? "Task completed (no result text)" };
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

  /**
   * Append a receipt produced by a sibling delegation path (today:
   * `invokeCapability`). The two paths share one drain bucket so a concurrent
   * AI loop composes all downstream receipts — AI-decided and user-tapped —
   * into one parent receipt's `delegation_receipts` chain.
   */
  pushReceipt(receipt: ExecutionReceipt): void {
    this.receipts.push(receipt);
  }
}
