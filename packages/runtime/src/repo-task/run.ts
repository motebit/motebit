/**
 * Repo task — the ephemeral, no-interior run (docs/proposals/governed-repo-change-v1.md
 * § "The chain", step 4; build order step 2).
 *
 * `runRepoTask` is a dedicated factory, not a mode of `MotebitRuntime`: the
 * run holds no storage, memory graph, event log, state vector, skills,
 * trust store, sync engine, MCP client, policy config or consolidation
 * cycle, so none of them can reach the model's context and no memory can
 * form — `memories_formed` is the literal `0` because there is no code path
 * that forms one, not because none happened to. It never reads
 * `~/.motebit/config.json` or any file: its only I/O is the four injected
 * ports (the model, the tip's tree, the git change stager, the receipt sink).
 * It writes no file: new content goes to git's object store as blobs.
 *
 * What it guarantees, each fail-closed:
 *   - **Authority before start.** `checkRepoTaskAuthority` over the
 *     pre-verified bundle at the run's clock; any failure throws
 *     `RepoTaskRefusedError` before the first model call.
 *   - **Authority on every call.** Re-run before every tool call; a lapse
 *     (the tick expired mid-run) makes that call `denied` with no I/O and
 *     ends the run after the batch.
 *   - **Exactly the scope's tools.** Built from the verified scope only and
 *     frozen; before every model call the offered entries are asserted to
 *     be the constructed objects (`assertOfferedTools`), else the run aborts.
 *   - **One system prompt.** A pure function of (scope, tools,
 *     runtime_version, model); re-derived from every pack sent and compared.
 *   - **A receipt per call, with its real status, durably recorded.** Signed
 *     by the agent, verified against the grant's delegate key, appended to
 *     the sink in call order before the run continues; a rejection aborts.
 *
 * The git-tip / pin / worktree-clean preflight and the change and bundle
 * commits are the CLI's (step 4); it fills `RepoTaskAuthorityBundle` and
 * signs the `ExecutionReceipt` from this run's result.
 */

import type { StreamingProvider } from "@motebit/ai-core";
import { wrapExternalData } from "@motebit/ai-core";
import {
  bytesToHex,
  hash,
  hashToolPayload,
  hexToBytes,
  signToolInvocationReceipt,
  verifyToolInvocationReceipt,
} from "@motebit/crypto";
import type { SignableToolInvocationReceipt } from "@motebit/crypto";
import { REPO_CHANGE_MAX_TOOL_RECEIPTS } from "@motebit/protocol";
import type { DigestRef, RepoChangeTool, ToolResult } from "@motebit/protocol";
import type { AIResponse, ConversationMessage } from "@motebit/sdk";

import type { ToolReceiptSink } from "../tool-receipt-sink.js";
import { checkRepoTaskAuthority } from "./authority.js";
import type {
  RepoTaskAuthorityBundle,
  RepoTaskAuthorityFailure,
  RepoTaskPin,
} from "./authority.js";
import { buildRepoTaskPack, repoTaskFrame, repoTaskSystemPrompt } from "./system-prompt.js";
import { assertOfferedTools, buildRepoTaskTools } from "./tools.js";
import type { RepoChangeStager, RepoTaskToolOutcome, RepoTreeReader } from "./tools.js";

/** The agent identity A: it signs every receipt, and must be the grant's delegate. */
export interface RepoTaskAgent {
  readonly motebitId: string;
  readonly deviceId: string;
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

export interface RepoTaskRunInput {
  /** The pre-verified bundle the CLI's preflight produced (scope, grant, tick, revocations, pins). */
  readonly authority: RepoTaskAuthorityBundle;
  readonly agent: RepoTaskAgent;
  /** Any provider, constructed with the default personality. */
  readonly provider: StreamingProvider;
  /** The provider's name, recorded in the change record (informational). */
  readonly providerName: string;
  readonly reader: RepoTreeReader;
  /** Stages content as blobs in git's object store and builds the change commit; never writes the worktree. */
  readonly stager: RepoChangeStager;
  /** Durable record of every signed tool receipt. */
  readonly receipts: ToolReceiptSink;
  readonly runtimeVersion: string;
  /** Injected clock (ms). Default `Date.now`. */
  readonly clock?: () => number;
  /** Fresh ids for the task and each invocation. Default `crypto.randomUUID`. */
  readonly newId?: () => string;
  /** Model calls before the run stops. Default 24. */
  readonly maxModelCalls?: number;
}

/** Why the run stopped calling the model. */
export type RepoTaskRunEnd =
  /** The model answered without asking for a tool. */
  | "model_done"
  /** The authority check failed on a tool call; that call was denied. */
  | "authority_lapsed"
  /** `maxModelCalls` was reached. */
  | "model_call_limit"
  /** The bundle's receipt ceiling (256) was reached; later calls never ran. */
  | "receipt_limit";

export interface RepoTaskRunResult {
  /** The run's fresh task id, carried by every tool receipt. */
  readonly task_id: string;
  readonly ended: RepoTaskRunEnd;
  /** Every signed tool receipt, in call order — the same ones the sink received. */
  readonly tool_receipts: readonly SignableToolInvocationReceipt[];
  /** The tools of the calls that were not denied, in the registry's order. */
  readonly tools_used: readonly RepoChangeTool[];
  /** The tick's scope, the receipt's `delegated_scope`. */
  readonly delegated_scope: string;
  /** Always 0: the run has no memory to form. */
  readonly memories_formed: 0;
  /** Hex SHA-256 of the UTF-8 bytes of the scope's task. */
  readonly prompt_hash: string;
  readonly system_prompt: string;
  readonly system_prompt_digest: DigestRef;
  /** Allowed paths staged, in first-stage order. */
  readonly written_paths: readonly string[];
  /** The model's last text. */
  readonly response: string;
  readonly provider: string;
  readonly model: string;
  readonly runtime_version: string;
  readonly submitted_at: number;
  readonly completed_at: number;
  /**
   * The detail of every tool call that failed by throwing — LOCAL ONLY. The
   * model saw only the fixed code `repo_task_tool_failed`; the receipt's
   * `result_hash` commits to that code.
   */
  readonly tool_failures: readonly RepoTaskToolFailure[];
}

/** One failed call's local detail (never shown to the model). */
export interface RepoTaskToolFailure {
  readonly tool_name: string;
  readonly tool_call_id: string;
  readonly detail: string;
}

/** What the model is told when a tool call failed: a fixed code, no host detail. */
const TOOL_FAILED = "repo_task_tool_failed";

/** The run refused to start: authority (or the agent's own key) failed before any model call. */
export class RepoTaskRefusedError extends Error {
  /** Every failed rule, each with the repo-change repair code the verifier would report. */
  readonly failures: readonly RepoTaskAuthorityFailure[];
  constructor(failures: readonly RepoTaskAuthorityFailure[]) {
    super(
      `repo task refused before the first model call: ${failures.map((f) => `${f.code}: ${f.detail}`).join("; ")}`,
    );
    this.name = "RepoTaskRefusedError";
    this.failures = failures;
  }
}

/** The run aborted mid-way, fail-closed (system prompt drift, receipt signer, sink). */
export class RepoTaskAbortedError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`repo task aborted: ${message}`, options);
    this.name = "RepoTaskAbortedError";
  }
}

const ENCODER = new TextEncoder();
const DEFAULT_MAX_MODEL_CALLS = 24;

function defaultNewId(): string {
  return crypto.randomUUID();
}

export async function runRepoTask(input: RepoTaskRunInput): Promise<RepoTaskRunResult> {
  const clock = input.clock ?? Date.now;
  const newId = input.newId ?? defaultNewId;
  const maxModelCalls = input.maxModelCalls ?? DEFAULT_MAX_MODEL_CALLS;
  const { provider } = input;
  // Snapshot every bound, deep-cloned and frozen, before the first await: a
  // caller that mutates its scope, grant, tick, revocations or pins after
  // calling cannot move the run's limits. The path predicate is a function,
  // held by reference (it is the caller's pure interpretation of data).
  const authority: RepoTaskAuthorityBundle = deepFreeze({
    scope: structuredClone(input.authority.scope),
    grant: structuredClone(input.authority.grant),
    tick: structuredClone(input.authority.tick),
    revocations: structuredClone(input.authority.revocations),
    principal: structuredClone(input.authority.principal),
    agents: structuredClone(input.authority.agents),
    expectedRepo: input.authority.expectedRepo,
    isPathPermitted: input.authority.isPathPermitted,
    spent: input.authority.spent,
  });
  const agent: RepoTaskAgent = deepFreeze({
    motebitId: input.agent.motebitId,
    deviceId: input.agent.deviceId,
    privateKey: new Uint8Array(input.agent.privateKey),
    publicKey: new Uint8Array(input.agent.publicKey),
  });
  const { scope, grant, tick } = authority;
  const agentPin: RepoTaskPin = {
    motebit_id: agent.motebitId,
    public_key: bytesToHex(agent.publicKey),
  };

  // -- Authority before start: nothing below runs on a refused bundle.
  const submittedAt = clock();
  const preflight = await checkRepoTaskAuthority(authority, agentPin, submittedAt);
  if (!preflight.ok) throw new RepoTaskRefusedError(preflight.failures);
  const authorized = preflight.tools;
  const delegateKey = hexToBytes(grant.delegate_public_key);

  const taskId = newId();
  const signRunReceipt = async (p: {
    toolName: string;
    args: Record<string, unknown>;
    startedAt: number;
    outcome: RepoTaskToolOutcome;
  }): Promise<SignableToolInvocationReceipt> => {
    const visible = p.outcome.result.ok
      ? (p.outcome.result.data ?? null)
      : (p.outcome.result.error ?? null);
    return signToolInvocationReceipt(
      {
        invocation_id: newId(),
        task_id: taskId,
        motebit_id: agent.motebitId,
        device_id: agent.deviceId,
        tool_name: p.toolName,
        started_at: p.startedAt,
        completed_at: clock(),
        status: p.outcome.status,
        args_hash: await hashToolPayload(p.args),
        result_hash: await hashToolPayload(visible),
        invocation_origin: "ai-loop",
      },
      agent.privateKey,
      agent.publicKey,
    );
  };

  // The agent's private key must sign as the grant's delegate: prove it on a
  // throwaway receipt before the first model call, so a mismatched key pair
  // refuses here rather than after a write.
  const probe = await signRunReceipt({
    toolName: "repo_task_key_probe",
    args: {},
    startedAt: submittedAt,
    outcome: { status: "denied", result: { ok: false, error: "probe" } },
  });
  if (!(await verifyToolInvocationReceipt(probe, delegateKey))) {
    throw new RepoTaskRefusedError([
      {
        code: "identity.repo_change.signer_not_delegate",
        detail: "the agent's private key does not sign as the grant's delegate",
      },
    ]);
  }

  // -- The frozen registry, from the verified scope only.
  const { registry, expected } = buildRepoTaskTools(authorized, scope, {
    reader: input.reader,
    stager: input.stager,
  });
  const toolNames = registry.entries.map((e) => e.definition.name as RepoChangeTool);
  const frame = repoTaskFrame(scope, toolNames, input.runtimeVersion);
  const model = provider.model;
  const systemPrompt = repoTaskSystemPrompt(
    buildRepoTaskPack({
      scope,
      tools: registry.entries.map((e) => e.definition),
      frame,
      history: [],
      first: true,
    }),
    model,
  );
  const systemPromptDigest: DigestRef = {
    algorithm: "sha-256",
    value: await hash(ENCODER.encode(systemPrompt)),
  };

  const history: ConversationMessage[] = [];
  const toolFailures: RepoTaskToolFailure[] = [];
  const receipts: SignableToolInvocationReceipt[] = [];
  const used = new Set<RepoChangeTool>();
  const written: string[] = [];
  let ended: RepoTaskRunEnd = "model_call_limit";
  let response = "";

  const recordRunReceipt = async (receipt: SignableToolInvocationReceipt): Promise<void> => {
    if (!(await verifyToolInvocationReceipt(receipt, delegateKey))) {
      throw new RepoTaskAbortedError(
        "a tool receipt does not verify under the grant's delegate key",
      );
    }
    try {
      await input.receipts.append(receipt);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new RepoTaskAbortedError(`the receipt sink rejected a receipt: ${msg}`, { cause: err });
    }
    receipts.push(receipt);
  };

  run: for (let call = 1; call <= maxModelCalls; call++) {
    // Exactly the constructed tools, by identity, on every model call.
    const offered = registry.entries;
    assertOfferedTools(offered, expected, authorized);
    const pack = buildRepoTaskPack({
      scope,
      tools: offered.map((e) => e.definition),
      frame,
      history,
      first: call === 1,
    });
    if (repoTaskSystemPrompt(pack, model) !== systemPrompt) {
      throw new RepoTaskAbortedError("the system prompt would differ from the recorded one");
    }

    let aiResponse: AIResponse | undefined;
    for await (const chunk of provider.generateStream(pack)) {
      if (chunk.type === "done") aiResponse = chunk.response;
    }
    if (!aiResponse) throw new RepoTaskAbortedError("the model stream ended without a response");
    response = aiResponse.text;
    const calls = aiResponse.tool_calls ?? [];
    if (calls.length === 0) {
      ended = "model_done";
      break;
    }

    if (call === 1) history.push({ role: "user", content: scope.task });
    history.push({ role: "assistant", content: aiResponse.text, tool_calls: calls });

    let lapsed = false;
    for (const toolCall of calls) {
      if (receipts.length >= REPO_CHANGE_MAX_TOOL_RECEIPTS) {
        ended = "receipt_limit";
        break run;
      }
      const startedAt = clock();
      const args = toolCall.args ?? {};
      let outcome: RepoTaskToolOutcome;
      // Authority on every call: the tick against the grant at this moment.
      const check = await checkRepoTaskAuthority(authority, agentPin, startedAt);
      const entry = offered.find((e) => e.definition.name === toolCall.name);
      if (!check.ok) {
        lapsed = true;
        outcome = {
          status: "denied",
          result: {
            ok: false,
            error: `authority: ${check.failures.map((f) => f.code).join("; ")}`,
          },
        };
      } else if (entry === undefined) {
        outcome = {
          status: "denied",
          result: { ok: false, error: `${toolCall.name} is not a tool of this run` },
        };
      } else {
        try {
          outcome = await entry.handler.invoke(args);
        } catch (err) {
          // The model sees a fixed code, never the port's message: an I/O
          // error can carry host detail (an absolute path, git's stderr).
          // The detail stays in the run's local record (`tool_failures`).
          const detail = err instanceof Error ? err.message : String(err);
          toolFailures.push({ tool_name: toolCall.name, tool_call_id: toolCall.id, detail });
          outcome = { status: "failed", result: { ok: false, error: TOOL_FAILED } };
        }
      }
      if (outcome.status === "completed" && toolCall.name === "repo_write_path") {
        const p = (args as { path?: unknown }).path;
        if (typeof p === "string" && !written.includes(p)) written.push(p);
      }
      if (outcome.status !== "denied" && entry !== undefined) {
        used.add(entry.definition.name as RepoChangeTool);
      }
      await recordRunReceipt(
        await signRunReceipt({ toolName: toolCall.name, args, startedAt, outcome }),
      );
      history.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(boundaryWrapped(outcome.result, toolCall.name)),
      });
    }
    if (lapsed) {
      ended = "authority_lapsed";
      break;
    }
  }

  return {
    task_id: taskId,
    ended,
    tool_receipts: receipts,
    tools_used: toolNames.filter((t) => used.has(t)),
    delegated_scope: tick.scope,
    memories_formed: 0,
    prompt_hash: await hash(ENCODER.encode(scope.task)),
    system_prompt: systemPrompt,
    system_prompt_digest: systemPromptDigest,
    written_paths: written,
    response,
    provider: input.providerName,
    model,
    runtime_version: input.runtimeVersion,
    submitted_at: submittedAt,
    completed_at: clock(),
    tool_failures: toolFailures,
  };
}

/**
 * Freeze a plain snapshot all the way down (objects and arrays). Typed arrays
 * cannot be frozen; the key copies are private to the run.
 */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !ArrayBuffer.isView(value)) {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

/** A tool result as the model sees it: repository bytes inside the external-data boundary. */
function boundaryWrapped(result: ToolResult, toolName: string): ToolResult {
  if (!result.ok || result.data === undefined) return result;
  return { ...result, data: wrapExternalData(result.data, toolName) };
}
