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
 */

import type { PlanStep, DelegatedStepResult, ExecutionReceipt } from "@motebit/sdk";
import type { StepDelegationAdapter } from "./plan-engine.js";

// ── Config ──────────────────────────────────────────────────────────

export interface SovereignDelegationConfig {
  /** Relay URL for discovery only (no settlement flows through relay). */
  discoveryUrl: string;
  /** Static auth token or async factory for relay discovery calls. */
  authToken?: string | ((audience?: string) => Promise<string>);
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
    readonly chain: string;
    readonly asset: string;
  };
  /** Max retry attempts on failure (default 2, so up to 3 total attempts). */
  maxRetries?: number;
  /** Called on each failed attempt for trust demotion. */
  onDelegationFailure?: (
    step: PlanStep,
    attempt: number,
    error: string,
    failedAgentId?: string,
  ) => void;
  /** Routing strategy passed to discovery. */
  routingStrategy?: "cost" | "quality" | "balanced";
  /** Create a signed auth token for MCP calls. Injected to avoid importing crypto directly. */
  createSignedToken: (
    payload: {
      mid: string;
      did: string;
      iat: number;
      exp: number;
      jti: string;
      aud: string;
    },
    privateKey: Uint8Array,
  ) => Promise<string>;
  /** Verify an execution receipt. Injected to avoid importing crypto directly. */
  verifyReceipt: (receipt: ExecutionReceipt, publicKey: Uint8Array) => Promise<boolean>;
  /** Hex-decode utility. */
  hexToBytes: (hex: string) => Uint8Array;
  /** SHA-256 hex hash. */
  hash: (data: Uint8Array) => Promise<string>;
}

// ── Discovery types ─────────────────────────────────────────────────

interface DiscoveredCandidate {
  motebit_id: string;
  endpoint_url: string | null;
  pay_to_address: string | null;
  pricing: Array<{ capability: string; unit_cost: number; currency: string; per: string }>;
  composite: number;
}

// ── Adapter ─────────────────────────────────────────────────────────

export class SovereignDelegationAdapter implements StepDelegationAdapter {
  constructor(private config: SovereignDelegationConfig) {}

  private async buildHeaders(audience?: string): Promise<Record<string, string>> {
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
          attempt === 0 ? onTaskSubmitted : undefined,
        );
        return result;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const failedAgentId = (lastError as DelegationError).failedAgentId;

        this.config.onDelegationFailure?.(step, attempt, lastError.message, failedAgentId);

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

    // ── Phase 2: PAY ──────────────────────────────────────────────
    const costMicro = this.estimateCost(candidate.pricing, step);
    let txHash: string;
    try {
      const result = await this.config.walletRail.send(candidate.pay_to_address, BigInt(costMicro));
      txHash = result.signature;
    } catch (err: unknown) {
      const payErr = new Error(
        `Payment failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
      (payErr as DelegationError).failedAgentId = candidate.motebit_id;
      throw payErr;
    }

    // Persist sovereign task ID for recovery
    const sovereignTaskId = `sovereign:${candidate.motebit_id}:${txHash}`;
    onTaskSubmitted?.(sovereignTaskId);

    // ── Phase 3: EXECUTE ──────────────────────────────────────────
    const receipt = await this.executeMcpTask(
      candidate.endpoint_url,
      step.prompt,
      txHash,
      timeoutMs,
      candidate.motebit_id,
    );

    if (!receipt) {
      const err = new Error("Agent returned no receipt");
      (err as DelegationError).failedAgentId = candidate.motebit_id;
      throw err;
    }

    // ── Phase 4: RECEIPT ──────────────────────────────────────────
    // Verify the receipt's signature using the embedded public key
    if (receipt.public_key) {
      const pubKey = this.config.hexToBytes(receipt.public_key);
      const verified = await this.config.verifyReceipt(receipt, pubKey);
      if (!verified) {
        const err = new Error("Receipt signature verification failed");
        (err as DelegationError).failedAgentId = candidate.motebit_id;
        throw err;
      }
    }

    if (receipt.status !== "completed") {
      const err = new Error(`Delegated step ${receipt.status}: ${receipt.result}`);
      (err as DelegationError).failedAgentId = receipt.motebit_id;
      throw err;
    }

    return {
      step_id: step.step_id,
      task_id: sovereignTaskId,
      receipt,
      result_text: receipt.result,
    };
  }

  // ── Discovery ───────────────────────────────────────────────────

  private async discoverCandidates(
    step: PlanStep,
    excludeAgents: string[],
  ): Promise<DiscoveredCandidate[]> {
    const { discoveryUrl, routingStrategy } = this.config;
    const capability = step.required_capabilities?.[0] ?? "";

    const params = new URLSearchParams();
    if (capability) params.set("capability", capability);
    if (routingStrategy) params.set("routing_strategy", routingStrategy);
    params.set("limit", "10");

    const headers = await this.buildHeaders("market:query");
    const resp = await fetch(`${discoveryUrl}/api/v1/market/candidates?${params}`, { headers });

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

  private async executeMcpTask(
    mcpUrl: string,
    prompt: string,
    txHash: string,
    timeoutMs: number,
    _targetMotebitId: string,
  ): Promise<ExecutionReceipt | null> {
    const { motebitId, deviceId, signingKeys, walletRail } = this.config;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Create signed auth token for the remote agent
      const token = await this.config.createSignedToken(
        {
          mid: motebitId,
          did: deviceId,
          iat: Date.now(),
          exp: Date.now() + 5 * 60 * 1000,
          jti: crypto.randomUUID(),
          aud: "task:submit",
        },
        signingKeys.privateKey,
      );

      const headers = (sid?: string): Record<string, string> => ({
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer motebit:${token}`,
        ...(sid ? { "Mcp-Session-Id": sid } : {}),
      });

      let sessionId: string | undefined;
      let reqId = 0;

      // MCP call helper (mirrors services/web-search/src/index.ts:subDelegate)
      const mcpCall = async (method: string, params: unknown): Promise<unknown> => {
        const id = ++reqId;
        const resp = await fetch(mcpUrl, {
          method: "POST",
          headers: headers(sessionId),
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
        if (!resp.ok) return null;
        return resp.json();
      };

      // Initialize MCP session
      const init = (await mcpCall("initialize", {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "sovereign-delegation", version: "0.1.0" },
      })) as { result?: unknown } | null;
      if (init == null || !("result" in (init as Record<string, unknown>))) return null;

      // Send initialized notification
      await fetch(mcpUrl, {
        method: "POST",
        headers: headers(sessionId),
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

      if (!taskResult?.result?.content) return null;

      const text = taskResult.result.content
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      const cleaned = text.replace(/\n?\[motebit:[^\]]+\]\s*$/, "");

      let parsed: unknown;
      try {
        parsed = JSON.parse(cleaned);
      } catch {
        return null;
      }

      // Validate receipt shape — reject malformed responses from untrusted agents
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        typeof (parsed as Record<string, unknown>).task_id !== "string" ||
        typeof (parsed as Record<string, unknown>).motebit_id !== "string" ||
        typeof (parsed as Record<string, unknown>).signature !== "string"
      ) {
        return null;
      }

      return parsed as ExecutionReceipt;
    } finally {
      clearTimeout(timer);
    }
  }

  // No relay state to poll for sovereign delegation
  async pollTaskResult(_taskId: string, _stepId: string): Promise<DelegatedStepResult | null> {
    return null;
  }
}

/** Internal error type carrying the failed agent's ID for exclusion. */
interface DelegationError extends Error {
  failedAgentId?: string;
}
