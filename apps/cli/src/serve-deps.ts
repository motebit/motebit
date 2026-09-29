/**
 * The principal-bearing seams of `motebit serve` (#880), extracted from
 * `daemon.ts` so each is locked by a test that goes red when it regresses.
 *
 * An MCP server serves OTHER principals. Three facts must reach the
 * runtime with every call, on both serve shapes:
 *
 *  - the request's verified caller, in every policy question and every
 *    execution (the coordinator re-validates at execution);
 *  - `foreignPrincipal` on `motebit_query`, whose text is the caller's
 *    words run through this motebit's loop — the turn is offered no
 *    `localOnly` tool;
 *  - nothing that widens: an attached frontend's forwarded caller is
 *    clamped by the coordinator (`attached-surface.ts`), and the
 *    runtime-host wire passes only `foreignPrincipal: true`.
 */
import type { CallerIdentity, MotebitServerDeps, ServedPrincipal } from "@motebit/mcp-server";
import type { MotebitRuntime } from "@motebit/runtime";
import type { PolicyDecision, ToolResult } from "@motebit/sdk";

/** The wire form of an MCP request's verified caller for the attached frames. */
export function attachedCaller(caller: CallerIdentity | undefined): {
  caller?: { motebit_id: string; trust_level: string };
} {
  return caller == null
    ? {}
    : { caller: { motebit_id: caller.motebitId, trust_level: caller.trustLevel } };
}

/** The slice of the runtime-host client the attached serve seams use. */
export interface AttachedServeClient {
  query(kind: string, params?: Record<string, unknown>): Promise<unknown>;
  act(kind: string, params?: Record<string, unknown>): Promise<unknown>;
  chat(text: string, options?: Record<string, unknown>): AsyncGenerator<unknown>;
}

/**
 * `motebit serve` attached: policy, execution and `motebit_query` over the
 * coordinator's interior. The caller rides every policy and execution
 * frame; the query's chat frame is marked foreign.
 */
export function attachedServePrincipalDeps(
  client: AttachedServeClient,
  /** Operator log for a served turn's money notice (#885). */
  log: (line: string) => void = (line) => console.warn(line),
): Pick<MotebitServerDeps, "validateTool" | "executeTool" | "sendMessage"> {
  return {
    validateTool: async (tool, args, caller) =>
      (await client.query("policy_validate", {
        name: tool.name,
        args,
        ...attachedCaller(caller),
      })) as PolicyDecision,
    executeTool: async (name, args, caller) =>
      (await client.act("tool_execute", {
        name,
        args,
        ...attachedCaller(caller),
      })) as ToolResult,
    // The AI loop is the coordinator's — one turn over the chat frame. Whose
    // turn it is comes from the request (#943 round 10): a remote caller's
    // text runs FOREIGN (#880 — without the mark the coordinator ran it as
    // an OWNER turn with every localOnly tool); the owner's own stdio host
    // runs an owner turn.
    sendMessage: async (text: string, principal: ServedPrincipal) => {
      const owner = principal === "owner";
      let response = "";
      let memoriesFormed = 0;
      for await (const chunk of client.chat(text, owner ? {} : { foreignPrincipal: true })) {
        const c = chunk as {
          type?: string;
          text?: string;
          notice?: string;
          result?: { memoriesFormed?: unknown[] };
        };
        if (c.type === "text" && typeof c.text === "string") response += c.text;
        else if (c.type === "result" && Array.isArray(c.result?.memoriesFormed)) {
          memoriesFormed = c.result.memoriesFormed.length;
        }
        // #885: the coordinator's wallet sent another payment (or a payment
        // could not be recorded) inside a served turn — the operator reads
        // the serve log, never the MCP caller's response.
        else if (c.type === "payment_notice" && typeof c.notice === "string") {
          log(`[warning] payment: ${c.notice}`);
        }
      }
      // Never a count of the owner's memory to another principal (#943).
      return { response, memoriesFormed: owner ? memoriesFormed : 0 };
    },
  };
}

/**
 * `motebit serve` coordinating: policy and `motebit_query` against the
 * process's own runtime.
 */
export function servePrincipalDeps(
  runtime: Pick<MotebitRuntime, "policy" | "sendMessage">,
): Pick<MotebitServerDeps, "validateTool" | "sendMessage"> {
  return {
    // The request's verified caller is part of the policy question. Dropping
    // it judged every remote call as the owner's own turn, so no
    // caller-scoped rule — Blocked, Unknown ⇒ approval, a tool's own
    // approval floor for remote callers — could fire on `motebit serve`.
    validateTool: (tool, args, caller) => {
      const ctx = runtime.policy.createTurnContext();
      if (caller) {
        ctx.callerMotebitId = caller.motebitId;
        ctx.callerTrustLevel = caller.trustLevel;
      }
      return runtime.policy.validate(tool, args, ctx);
    },
    // `motebit_query` runs as the request's served principal (#943 round
    // 10): a remote CALLER's words run a foreign turn (no `localOnly` tool,
    // none of the owner's interior); the owner's own stdio host runs an
    // owner turn — the principal `motebit_recall` is already served to.
    sendMessage: async (text: string, principal: ServedPrincipal) => {
      const owner = principal === "owner";
      const result = await runtime.sendMessage(text, undefined, { foreignPrincipal: !owner });
      // Never a count derived from the owner's memory to a caller.
      return {
        response: result.response,
        memoriesFormed: owner ? result.memoriesFormed.length : 0,
      };
    },
  };
}
