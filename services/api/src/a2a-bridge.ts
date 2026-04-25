/**
 * A2A Protocol Bridge — exposes motebit agents as A2A-compatible agents.
 *
 * Maps between Google's Agent2Agent protocol and motebit's native identity,
 * discovery, and task execution. This lets any A2A-compatible framework
 * (Google ADK, LangChain, CrewAI) discover and delegate to motebits —
 * and receive signed ExecutionReceipts back as proof of execution.
 *
 * Endpoints:
 *   GET  /.well-known/agent.json              — A2A Agent Card (relay-level)
 *   GET  /a2a/agents/:motebitId/agent.json     — A2A Agent Card (per-agent)
 *   POST /a2a/agents/:motebitId                — A2A SendMessage (task submission)
 *   GET  /a2a/agents/:motebitId/tasks/:taskId  — A2A GetTask (poll for result)
 */

import type { Hono } from "hono";
import type { DatabaseDriver } from "@motebit/persistence";
import { hexPublicKeyToDidKey } from "@motebit/encryption";
import type { RelayIdentity } from "./federation.js";

// ---------------------------------------------------------------------------
// A2A Types (subset of the spec, enough for the bridge)
// ---------------------------------------------------------------------------

interface A2AAgentCard {
  name: string;
  description: string;
  url: string;
  version: string;
  capabilities: {
    streaming: boolean;
    pushNotifications: boolean;
  };
  skills: A2ASkill[];
  securitySchemes: A2ASecurityScheme[];
  security: Array<Record<string, string[]>>;
  provider?: { organization: string; url?: string };
  /** Motebit extension: cryptographic identity */
  "x-motebit"?: {
    motebit_id: string;
    did: string;
    public_key: string;
    spec: string;
  };
}

interface A2ASkill {
  id: string;
  name: string;
  description: string;
  tags?: string[];
}

interface A2ASecurityScheme {
  type: string;
  scheme?: string;
  description?: string;
}

interface A2AMessage {
  role: "user" | "agent";
  parts: Array<{ text?: string; structuredData?: unknown }>;
  metadata?: Record<string, unknown>;
}

interface A2ATask {
  id: string;
  contextId?: string;
  status: {
    state: "working" | "completed" | "failed" | "canceled";
    timestamp: string;
  };
  messages?: A2AMessage[];
  artifacts?: Array<{
    name?: string;
    parts: Array<{ text?: string; structuredData?: unknown }>;
  }>;
  /** Motebit extension: signed execution receipt */
  "x-motebit-receipt"?: unknown;
}

// ---------------------------------------------------------------------------
// AP2 Types (Google Agent Payments Protocol — V0.1)
// ---------------------------------------------------------------------------

/** AP2 Intent Mandate — authorizes an agent to act in human-not-present scenarios. */
interface AP2IntentMandate {
  type: "intent_mandate";
  /** Shopping intent: product categories, SKUs, purchase criteria */
  intent: string;
  /** Prompt playback: agent's understanding of what the user wants */
  prompt_playback?: string;
  /** Chargeable payment methods (list or category) */
  payment_methods?: string[];
  /** Maximum authorized amount */
  max_amount?: { currency: string; value: number };
  /** Time-to-live in milliseconds */
  ttl_ms?: number;
  /** Cryptographic signature (algorithm left open by AP2 spec) */
  signature?: string;
  /** Signer's public key or DID */
  signer?: string;
  /** ISO 8601 timestamp */
  timestamp: string;
}

/** AP2 Payment Mandate — proof of completed transaction for ecosystem visibility. */
interface AP2PaymentMandate {
  type: "payment_mandate";
  payment_mandate_id: string;
  /** Original task/order ID */
  payment_details_id: string;
  /** Total amount */
  total: { currency: string; value: number };
  /** Agent presence: human_present or human_not_present */
  modality: "human_present" | "human_not_present";
  /** Merchant/service agent identity */
  merchant_agent: string;
  /** User authorization token (JWT or signed blob) */
  user_authorization?: string;
  timestamp: string;
  /** Motebit extension: the signed ExecutionReceipt that proves the work was done */
  "x-motebit-receipt"?: unknown;
}

// ---------------------------------------------------------------------------
// Bridge Registration
// ---------------------------------------------------------------------------

export interface A2ABridgeConfig {
  relayIdentity: RelayIdentity;
  relayUrl: string;
  relayVersion: string;
}

export function registerA2ARoutes(app: Hono, db: DatabaseDriver, config: A2ABridgeConfig): void {
  const { relayIdentity, relayUrl, relayVersion } = config;

  // --- Relay-level Agent Card (/.well-known/agent.json) ---
  // Returns the relay itself as a meta-agent that can route to specific agents.
  /** @internal */
  app.get("/.well-known/agent.json", (c) => {
    const card: A2AAgentCard = {
      name: `motebit-relay-${relayIdentity.relayMotebitId.slice(0, 8)}`,
      description:
        "Motebit relay — routes tasks to sovereign agents with cryptographic identity, trust accumulation, and signed execution receipts.",
      url: `${relayUrl}/a2a`,
      version: relayVersion,
      capabilities: {
        streaming: false,
        pushNotifications: false,
      },
      skills: [
        {
          id: "delegate",
          name: "Task Delegation",
          description:
            "Submit a task to the motebit agent network. The relay routes to the best agent based on trust, cost, and capability. Returns a signed ExecutionReceipt.",
          tags: ["delegation", "routing", "trust"],
        },
        {
          id: "discover",
          name: "Agent Discovery",
          description: "Discover available agents by capability across the federated network.",
          tags: ["discovery", "federation"],
        },
        {
          id: "ap2_payment",
          name: "AP2 Payment",
          description:
            "Accept AP2 Intent Mandates for authorized agent commerce. Returns AP2 Payment Mandates with signed execution receipts.",
          tags: ["payments", "ap2", "commerce"],
        },
      ],
      securitySchemes: [
        {
          type: "http",
          scheme: "bearer",
          description: "Bearer token (relay API token or motebit signed JWT)",
        },
      ],
      security: [{ bearer: [] }],
      provider: { organization: "Motebit", url: "https://motebit.com" },
      "x-motebit": {
        motebit_id: relayIdentity.relayMotebitId,
        did: relayIdentity.did,
        public_key: relayIdentity.publicKeyHex,
        spec: "motebit/identity@1.0",
      },
    };
    return c.json(card);
  });

  // --- Per-agent Agent Card ---
  /** @internal */
  app.get("/a2a/agents/:motebitId/agent.json", (c) => {
    const motebitId = c.req.param("motebitId");

    // Look up agent in registry
    const agent = db
      .prepare(
        "SELECT motebit_id, public_key, endpoint_url, capabilities, metadata FROM agent_registry WHERE motebit_id = ? AND expires_at > ?",
      )
      .get(motebitId, Date.now()) as
      | {
          motebit_id: string;
          public_key: string;
          endpoint_url: string;
          capabilities: string;
          metadata: string | null;
        }
      | undefined;

    if (!agent) {
      return c.json({ error: "Agent not found or registration expired" }, 404);
    }

    // Get service listing for richer metadata
    const listing = db
      .prepare(
        "SELECT description, capabilities, pricing, sla_max_latency_ms, sla_availability FROM relay_service_listings WHERE motebit_id = ? ORDER BY updated_at DESC LIMIT 1",
      )
      .get(motebitId) as
      | {
          description: string;
          capabilities: string;
          pricing: string;
          sla_max_latency_ms: number;
          sla_availability: number;
        }
      | undefined;

    const capabilities: string[] = JSON.parse(agent.capabilities || "[]") as string[];
    const listingCaps: string[] = listing
      ? (JSON.parse(listing.capabilities || "[]") as string[])
      : [];
    const allCaps = [...new Set([...capabilities, ...listingCaps])];

    let did: string;
    try {
      did = hexPublicKeyToDidKey(agent.public_key);
    } catch {
      did = `did:key:${agent.public_key.slice(0, 16)}`;
    }

    const card: A2AAgentCard = {
      name: `motebit-${motebitId.slice(0, 8)}`,
      description: listing?.description || `Motebit agent ${motebitId.slice(0, 8)}`,
      url: `${relayUrl}/a2a/agents/${motebitId}`,
      version: relayVersion,
      capabilities: {
        streaming: false,
        pushNotifications: false,
      },
      skills: allCaps.map((cap) => ({
        id: cap,
        name: cap,
        description: `Agent capability: ${cap}`,
        tags: [cap],
      })),
      securitySchemes: [
        {
          type: "http",
          scheme: "bearer",
          description: "Bearer token (relay API token or motebit signed JWT)",
        },
      ],
      security: [{ bearer: [] }],
      "x-motebit": {
        motebit_id: motebitId,
        did,
        public_key: agent.public_key,
        spec: "motebit/identity@1.0",
      },
    };
    return c.json(card);
  });

  // --- A2A SendMessage (task submission) ---
  // Maps A2A message format → motebit task submission → A2A task response.
  /** @internal */
  app.post("/a2a/agents/:motebitId", async (c) => {
    const motebitId = c.req.param("motebitId");

    const body = await c.req.json<{
      message: A2AMessage;
      configuration?: {
        acceptedOutputModes?: string[];
        returnImmediately?: boolean;
      };
      metadata?: Record<string, unknown>;
    }>();

    if (!body.message?.parts?.length) {
      return c.json({ error: "Message must contain at least one part" }, 400);
    }

    // Extract text from message parts
    const prompt = body.message.parts
      .map((p) => p.text ?? (p.structuredData != null ? JSON.stringify(p.structuredData) : ""))
      .filter((t) => t.length > 0)
      .join("\n");

    if (!prompt) {
      return c.json({ error: "Message must contain text or structuredData" }, 400);
    }

    // Extract routing hints from metadata
    const routingStrategy = body.metadata?.routing_strategy as string | undefined;
    const requiredCapabilities = body.metadata?.required_capabilities as string[] | undefined;

    // Auth is mandatory — the relay's internal task endpoint enforces it,
    // but we fail-fast here to give a clear error to A2A callers.
    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      return c.json({ error: "Authorization header required" }, 401);
    }

    // Forward to the relay's native task submission endpoint.
    // The relay handles routing, budget, settlement, and receipt verification.
    // The `Idempotency-Key` is required by the task endpoint (400 otherwise);
    // the A2A boundary mints its own since A2A callers do not carry one.
    const internalUrl = `${relayUrl}/agent/${motebitId}/task`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: authHeader,
      "Idempotency-Key": crypto.randomUUID(),
    };

    try {
      const taskBody: Record<string, unknown> = {
        prompt,
        submitted_by: `a2a:${(body.metadata?.caller_id as string | undefined) ?? "unknown"}`,
      };
      if (requiredCapabilities) taskBody.required_capabilities = requiredCapabilities;
      if (routingStrategy) taskBody.routing_strategy = routingStrategy;

      const resp = await fetch(internalUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(taskBody),
      });

      if (!resp.ok) {
        const text = await resp.text();

        // Map motebit errors to A2A task states
        if (resp.status === 402) {
          const task: A2ATask = {
            id: crypto.randomUUID(),
            status: { state: "failed", timestamp: new Date().toISOString() },
            messages: [
              {
                role: "agent",
                parts: [{ text: "Insufficient budget for task execution" }],
              },
            ],
          };
          return c.json(task, 402);
        }
        return c.json({ error: text }, resp.status as 400);
      }

      const result = (await resp.json()) as {
        task_id: string;
        status: string;
        result?: string;
        receipt?: unknown;
        routing_choice?: unknown;
      };

      // Build A2A Task response
      const task: A2ATask = {
        id: result.task_id,
        status: {
          state:
            result.status === "completed"
              ? "completed"
              : result.status === "failed" || result.status === "denied"
                ? "failed"
                : "working",
          timestamp: new Date().toISOString(),
        },
      };

      if (result.result) {
        task.artifacts = [
          {
            name: "result",
            parts: [{ text: result.result }],
          },
        ];
      }

      // Attach signed receipt as motebit extension
      if (result.receipt != null) {
        task["x-motebit-receipt"] = result.receipt;
        // Also include receipt as structured data artifact for A2A consumers
        task.artifacts = task.artifacts ?? [];
        task.artifacts.push({
          name: "execution-receipt",
          parts: [{ structuredData: result.receipt }],
        });
      }

      return c.json(task);
    } catch (err: unknown) {
      return c.json(
        {
          id: crypto.randomUUID(),
          status: { state: "failed", timestamp: new Date().toISOString() },
          messages: [
            {
              role: "agent",
              parts: [{ text: err instanceof Error ? err.message : String(err) }],
            },
          ],
        } satisfies A2ATask,
        500,
      );
    }
  });

  // ---------------------------------------------------------------------------
  // AP2 Protocol Bridge — Agent Payments Protocol (Google, V0.1)
  // ---------------------------------------------------------------------------
  //
  // Maps AP2 mandates to motebit primitives:
  //   Intent Mandate  → DelegationToken (signed authorization + scope + TTL)
  //   Payment Mandate ← ExecutionReceipt (signed proof of execution)
  //
  // The relay remains the economic checkpoint — AP2 mandates authorize tasks
  // that flow through the standard task submission pipeline with 5% fee.

  /**
   * POST /ap2/agents/:motebitId/mandate — Submit an AP2 Intent Mandate.
   *
   * Translates the mandate into a motebit task, routes through the relay,
   * and returns an AP2 Payment Mandate with the signed ExecutionReceipt.
   */
  /** @internal */
  app.post("/ap2/agents/:motebitId/mandate", async (c) => {
    const motebitId = c.req.param("motebitId");

    const mandate = await c.req.json<AP2IntentMandate>();

    if (mandate.type !== "intent_mandate") {
      return c.json({ error: "Expected type: intent_mandate" }, 400);
    }
    if (!mandate.intent || typeof mandate.intent !== "string") {
      return c.json({ error: "Missing or empty intent field" }, 400);
    }

    // Check TTL — reject expired mandates
    if (mandate.ttl_ms != null) {
      const mandateTime = new Date(mandate.timestamp).getTime();
      if (!Number.isFinite(mandateTime)) {
        return c.json({ error: "Invalid timestamp" }, 400);
      }
      if (Date.now() > mandateTime + mandate.ttl_ms) {
        return c.json({ error: "Intent mandate has expired (TTL exceeded)" }, 400);
      }
    }

    // Auth is mandatory for mandate execution
    const authHeader = c.req.header("Authorization");
    if (!authHeader) {
      return c.json({ error: "Authorization header required" }, 401);
    }

    // Map Intent Mandate → motebit task
    const prompt = mandate.prompt_playback ?? mandate.intent;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: authHeader,
    };

    const taskBody: Record<string, unknown> = {
      prompt,
      submitted_by: `ap2:${mandate.signer ?? "unknown"}`,
    };

    // Forward budget constraint from mandate
    if (mandate.max_amount != null) {
      taskBody.wall_clock_ms = mandate.ttl_ms ?? 300_000;
    }

    try {
      const resp = await fetch(`${relayUrl}/agent/${motebitId}/task`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify(taskBody),
      });

      if (!resp.ok) {
        const text = await resp.text();
        if (resp.status === 402) {
          return c.json(
            {
              error: "payment_required",
              message: "Insufficient budget for mandate execution",
              mandate_id: mandate.intent.slice(0, 32),
            },
            402,
          );
        }
        return c.json({ error: text }, resp.status as 400);
      }

      const result = (await resp.json()) as {
        task_id: string;
        status: string;
        result?: string;
        receipt?: Record<string, unknown>;
        routing_choice?: unknown;
      };

      // Build AP2 Payment Mandate from execution result
      const paymentMandate: AP2PaymentMandate = {
        type: "payment_mandate",
        payment_mandate_id: `pm_${result.task_id}`,
        payment_details_id: result.task_id,
        total: mandate.max_amount ?? { currency: "USDC", value: 0 },
        modality: "human_not_present",
        merchant_agent: `motebit:${motebitId.slice(0, 8)}`,
        timestamp: new Date().toISOString(),
      };

      // Attach motebit receipt — cryptographic proof that AP2 can't provide alone
      if (result.receipt != null) {
        paymentMandate["x-motebit-receipt"] = result.receipt;
      }

      return c.json({
        status: result.status === "completed" ? "completed" : "failed",
        task_id: result.task_id,
        result: result.result,
        payment_mandate: paymentMandate,
        routing_choice: result.routing_choice,
      });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });
}
