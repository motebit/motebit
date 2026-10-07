/**
 * The `motebit serve --direct` task handler — no AI loop: a task's prompt is
 * mapped onto ONE served tool, executed, and answered with a signed
 * ExecutionReceipt. Both of serve's task doors reach it: the MCP
 * `motebit_task` tool (`deps.handleAgentTask`) and the relay WebSocket
 * dispatch (`handleTask`), so a gate here covers both.
 */
import type {
  DelegationRevocation,
  DelegationToken,
  StandingDelegation,
  ToolDefinition,
  ToolResult,
} from "@motebit/sdk";
import { signExecutionReceipt, hash as sha256 } from "@motebit/encryption";
import { fromHex } from "./identity.js";

/** The slice of `MotebitRuntime` the direct handler uses. */
export interface DirectTaskRuntime {
  /** Listing only — execution goes through `executeToolGated`, never the registry. */
  getToolRegistry(): { list(): ToolDefinition[] };
  executeToolGated(
    name: string,
    args: Record<string, unknown>,
    options?: {
      delegation?: {
        token: DelegationToken;
        grant: StandingDelegation;
        revocations?: readonly DelegationRevocation[];
      };
    },
  ): Promise<ToolResult>;
}

export interface DirectTaskHandlerDeps {
  runtime: DirectTaskRuntime;
  motebitId: string;
  deviceId: string;
  publicKeyHex: string | undefined;
  privateKey: Uint8Array;
  /** `--tools` was given: prefer externally loaded tools over the builtins. */
  preferExternalTools: boolean;
  log: (msg: string) => void;
  /**
   * The standing grant presented to each execution (`serve --direct --grant`),
   * as signed artifacts — verified per task by the runtime, never trusted here.
   */
  delegationForTask?: () => {
    delegation: {
      token: DelegationToken;
      grant: StandingDelegation;
      revocations: readonly DelegationRevocation[];
    };
  } | null;
}

export function createDirectTaskHandler(deps: DirectTaskHandlerDeps) {
  return async function* (
    prompt: string,
    options?: { delegatedScope?: string; relayTaskId?: string },
  ) {
    const taskId = crypto.randomUUID();
    const submittedAt = Date.now();

    // Find the tool to execute
    const allTools = deps.runtime.getToolRegistry().list();
    // A caller's prompt never selects an owner-interior tool (#880).
    const servable = allTools.filter((t) => t.localOnly !== true);
    const loadedTools = deps.preferExternalTools
      ? servable.filter(
          (t) =>
            // Prefer externally loaded tools; fall back to first tool
            !["read_file", "write_file", "list_directory", "run_command"].includes(t.name),
        )
      : servable;
    const tool = loadedTools[0];
    if (!tool) {
      yield {
        type: "task_result" as const,
        receipt: {
          task_id: taskId,
          motebit_id: deps.motebitId,
          status: "failed",
          result: "no tools available",
        } as unknown as Record<string, unknown>,
      };
      return;
    }

    // Map prompt to the first required string parameter
    const schema = tool.inputSchema as {
      properties?: Record<string, { type?: string }>;
      required?: string[];
    };
    const requiredProps = schema.required ?? [];
    const stringParam =
      requiredProps.find((k) => schema.properties?.[k]?.type === "string") ??
      requiredProps[0] ??
      Object.keys(schema.properties ?? {})[0];
    const args: Record<string, unknown> = {};
    if (stringParam) args[stringParam] = prompt;

    // Through the runtime's policy gate, never the registry raw (M2): the SAME
    // decision a direct MCP call of this tool gets, plus the R4 invariant — an
    // R4_MONEY tool runs only under a verified in-scope standing grant
    // presented as signed artifacts; with none it is refused, never queued
    // (no human is on this path). docs/doctrine/memory-never-confers-authority.md.
    const presented = deps.delegationForTask?.() ?? null;
    let result: { ok: boolean; data?: unknown; error?: string };
    try {
      result = await deps.runtime.executeToolGated(
        tool.name,
        args,
        presented != null ? { delegation: presented.delegation } : {},
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      result = { ok: false, error: msg };
    }
    const completedAt = Date.now();

    const resultStr = result.ok
      ? typeof result.data === "string"
        ? result.data
        : JSON.stringify(result.data ?? null)
      : (result.error ?? "error");
    const enc = new TextEncoder();
    const promptHash = await sha256(enc.encode(prompt));
    const resultHash = await sha256(enc.encode(resultStr));

    const receipt: Record<string, unknown> = {
      task_id: taskId,
      motebit_id: deps.motebitId,
      device_id: deps.deviceId,
      submitted_at: submittedAt,
      completed_at: completedAt,
      status: result.ok ? "completed" : "failed",
      result: resultStr,
      tools_used: [tool.name],
      memories_formed: 0,
      prompt_hash: promptHash,
      result_hash: resultHash,
      ...(options?.relayTaskId ? { relay_task_id: options.relayTaskId } : {}),
    };

    const signed = await signExecutionReceipt(
      receipt as Parameters<typeof signExecutionReceipt>[0],
      deps.privateKey,
      deps.publicKeyHex ? fromHex(deps.publicKeyHex) : undefined,
    );
    deps.log(
      `receipt=${signed.signature.slice(0, 12)}… tool=${tool.name} prompt="${prompt.slice(0, 60)}"`,
    );
    yield {
      type: "task_result" as const,
      receipt: signed as unknown as Record<string, unknown>,
    };
  };
}
