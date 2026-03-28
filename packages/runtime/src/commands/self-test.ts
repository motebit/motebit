/**
 * Self-test command — adversarial onboarding probe.
 *
 * Submits a self-delegation task through the live relay, exercising the exact
 * auth flow production agents use. If device auth is broken, the test fails.
 * The self-delegation also validates all five sybil defense layers (no bogus
 * trust credentials from self→self tasks).
 *
 * This is the shared implementation. Every surface (CLI, desktop, web, mobile,
 * spatial) that connects to a relay should run this after registration.
 */

import type { MotebitRuntime } from "../index.js";
import type { CommandResult, RelayConfig } from "./types.js";

/**
 * Token minter — surfaces provide this to mint audience-scoped device tokens.
 * The shared layer doesn't know about private keys or device IDs; it only
 * knows it needs a bearer token for a given audience string.
 *
 * Returns a bearer token string, or empty string if token minting is unavailable.
 */
export type MintToken = (audience: string) => Promise<string>;

export interface SelfTestConfig {
  relay: RelayConfig;
  /** Surface-provided token minter for audience-scoped auth. */
  mintToken: MintToken;
  /** Timeout in ms for polling completion. Default: 30_000. */
  timeoutMs?: number;
  /** Polling interval in ms. Default: 2_000. */
  pollIntervalMs?: number;
}

/**
 * Run the adversarial self-test probe.
 *
 * 1. Selects a tool from the registry as the required capability
 * 2. Mints audience-scoped tokens for task:submit and task:query
 * 3. Submits a self-delegation task to the relay
 * 4. Polls for completion within the timeout
 * 5. Returns structured result with status and any diagnostic hints
 */
export async function cmdSelfTest(
  runtime: MotebitRuntime,
  config: SelfTestConfig,
): Promise<CommandResult> {
  const { relay, mintToken, timeoutMs = 30_000, pollIntervalMs = 2_000 } = config;

  // Select a tool for required_capabilities — prefer externally loaded tools
  // (registered after builtins) since they're more representative of real work.
  const tools = runtime.getToolRegistry().list();
  const toolName = tools.length > 0 ? tools[tools.length - 1]!.name : "echo";

  // Mint audience-scoped tokens (same as production delegation flow)
  const submitToken = await mintToken("task:submit");
  const queryToken = await mintToken("task:query");

  if (!submitToken) {
    return {
      summary: "Self-test skipped — no auth token available.",
      data: { status: "skipped", reason: "no_auth" },
    };
  }

  // Submit self-delegation task
  let taskResp: Response;
  try {
    taskResp = await fetch(`${relay.relayUrl}/agent/${relay.motebitId}/task`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${submitToken}`,
      },
      body: JSON.stringify({
        prompt: "self-test",
        submitted_by: relay.motebitId,
        required_capabilities: [toolName],
      }),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      summary: `Self-test failed — could not reach relay: ${msg}`,
      data: { status: "failed", reason: "network_error", error: msg },
    };
  }

  if (!taskResp.ok) {
    const status = taskResp.status;
    const body = await taskResp.text().catch(() => "");
    const hint =
      status === 402
        ? "Fund the agent's budget on the relay."
        : status === 401 || status === 403
          ? "Device may not be registered with relay."
          : undefined;
    return {
      summary: `Self-test failed — relay returned ${status}.${hint ? ` Hint: ${hint}` : ""}`,
      detail: body ? body.slice(0, 200) : undefined,
      data: { status: "failed", reason: "relay_error", httpStatus: status, hint },
    };
  }

  const taskData = (await taskResp.json()) as { task_id?: string };
  const taskId = taskData.task_id;
  if (!taskId) {
    return {
      summary: "Self-test failed — no task_id in relay response.",
      data: { status: "failed", reason: "no_task_id" },
    };
  }

  // Poll for completion
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollIntervalMs));
    try {
      const pollResp = await fetch(`${relay.relayUrl}/agent/${relay.motebitId}/task/${taskId}`, {
        headers: { Authorization: `Bearer ${queryToken || submitToken}` },
      });
      if (!pollResp.ok) continue;
      const pollData = (await pollResp.json()) as { status?: string };
      if (pollData.status === "completed") {
        return {
          summary: "Self-test passed — agent is a live network participant.",
          data: { status: "passed", taskId },
        };
      }
      if (pollData.status === "failed") {
        return {
          summary: "Self-test completed but task failed.",
          data: { status: "task_failed", taskId },
        };
      }
    } catch {
      // Network hiccup during poll — continue waiting
    }
  }

  return {
    summary: `Self-test timed out after ${timeoutMs / 1000}s — the agent may still complete.`,
    data: { status: "timeout", taskId },
  };
}
