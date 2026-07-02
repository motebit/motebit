/**
 * `useChatStream` — React hook that owns the chat stream consumer and
 * approval handler for the mobile App.
 *
 * Owns:
 *
 *   - `pendingApprovalRef`     — message-id of the approval card that's
 *                                 currently waiting for user decision,
 *                                 or null. Read by handleApproval to
 *                                 clear the ref after resolve; also
 *                                 written externally by the goal
 *                                 scheduler callback (goals push an
 *                                 approval card and stash the id).
 *   - `pendingGoalApprovalRef` — boolean flag: is the pending approval
 *                                 from a goal run, or from a chat turn?
 *                                 Drives the resume path in
 *                                 handleApproval (resumeGoalAfterApproval
 *                                 vs resolveApprovalVote).
 *
 * Returns:
 *
 *   - `consumeStream(stream)`  — feeds a StreamChunk async iterable into
 *                                 the chat UI: appends assistant text,
 *                                 surfaces tool_status + delegation
 *                                 events as system messages, suspends
 *                                 on approval_request, finalizes on
 *                                 `result` with stripped tags.
 *   - `handleApproval(id, ok)` — user-side approval response. Marks the
 *                                 approval card resolved, then streams
 *                                 the continuation (goal or chat).
 *   - `pendingApprovalRef`     — exposed so the goals callback can set
 *                                 it when a goal pushes an approval
 *                                 card.
 *   - `pendingGoalApprovalRef` — same.
 *
 * The hook is a thin wrapper — the real logic is in `consumeStream`
 * and `handleApproval`. The reason it's a hook rather than a pure
 * function (like slash-commands) is that the two refs must survive
 * across renders and are shared with external callers (the goals
 * callback). `useRef` is the right primitive for that.
 */

import { useCallback } from "react";
import type { StreamChunk } from "@motebit/runtime";
import { stripTags, stripPartialActionTag } from "@motebit/ai-core";
import type { ExecutionReceipt } from "@motebit/sdk";
import type { MobileApp } from "./mobile-app";

export interface ChatStreamMessage {
  id: string;
  role: "user" | "assistant" | "system" | "approval" | "receipt";
  content: string;
  timestamp: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  riskLevel?: number;
  approvalResolved?: boolean;
  /** Full signed receipt for role === "receipt" messages. */
  receipt?: ExecutionReceipt;
  /**
   * Interior reasoning — the model's `<thinking>` trace for this turn (the
   * `mind` register). Rendered as a calm, opt-in, collapsed disclosure under
   * the assistant reply, never the reply itself. INTERIOR-ONLY: held in local
   * UI state, never persisted or synced. Accumulated across the turn's
   * reasoning rounds; absent when the model emitted no reasoning.
   */
  reasoning?: string;
}

export interface UseChatStreamDeps {
  app: MobileApp;
  setMessages: React.Dispatch<React.SetStateAction<ChatStreamMessage[]>>;
  addSystemMessage: (content: string) => void;
  pushTTSChunk: (delta: string) => void;
  flushTTS: () => void;
  setIsProcessing: (processing: boolean) => void;
  /** Ref owned by the caller so the goals callback can set it too. */
  pendingApprovalRef: React.MutableRefObject<string | null>;
  /** Ref owned by the caller so the goals callback can set it too. */
  pendingGoalApprovalRef: React.MutableRefObject<boolean>;
  /**
   * Setter for the chat surface's task-step narration register
   * (the `motebit × virtual_browser` cell of the slab chrome
   * matrix). Called on every `task_step_narration` chunk with the
   * validated text; called with `null` on every termination path
   * (success, abort, catch) so a stale narration never outlives
   * the turn that emitted it. Mirrors web's clear-on-every-path
   * discipline in `apps/web/src/ui/chat.ts` — `result` chunk +
   * the surrounding `finally`. Doctrine: `chrome-as-state-render.md`
   * § "Hybrid narration source"; memory anchor
   * `feedback_streaming_state_cleanup_every_path`.
   */
  setTaskStepNarration: (narration: string | null) => void;
}

export interface UseChatStreamResult {
  consumeStream: (stream: AsyncGenerator<StreamChunk>) => Promise<void>;
  handleApproval: (messageId: string, approved: boolean) => Promise<void>;
}

export function useChatStream(deps: UseChatStreamDeps): UseChatStreamResult {
  const {
    app,
    setMessages,
    addSystemMessage,
    pushTTSChunk,
    flushTTS,
    setIsProcessing,
    pendingApprovalRef,
    pendingGoalApprovalRef,
    setTaskStepNarration,
  } = deps;

  const consumeStream = useCallback(
    async (stream: AsyncGenerator<StreamChunk>) => {
      let assistantContent = "";
      let assistantReasoning = "";
      const assistantId = crypto.randomUUID();

      // Add placeholder
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "...", timestamp: Date.now() },
      ]);

      try {
        for await (const chunk of stream) {
          switch (chunk.type) {
            case "text":
              assistantContent += chunk.text;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: stripPartialActionTag(assistantContent) }
                    : m,
                ),
              );
              pushTTSChunk(chunk.text);
              break;

            case "reasoning":
              // Interior cognition for the owner-facing `mind` register —
              // rendered as a calm, opt-in collapsed disclosure under the reply
              // (App.tsx), never the reply text. Accumulate the turn's reasoning
              // rounds. INTERIOR-ONLY: local UI state, never persisted/synced.
              if (chunk.text.trim() !== "") {
                assistantReasoning = assistantReasoning
                  ? `${assistantReasoning}\n\n${chunk.text}`
                  : chunk.text;
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId ? { ...m, reasoning: assistantReasoning } : m,
                  ),
                );
              }
              break;

            case "tool_status":
              if (chunk.status === "calling") {
                addSystemMessage(`Calling ${chunk.name}...`);
              }
              break;

            case "task_step_narration": {
              // Feed the validated narration into the slab chrome's
              // `motebit × virtual_browser` register. The runtime's
              // `validateTaskStepNarration` already corrected wire-
              // truth contradictions before the chunk left the loop,
              // so the chrome renders `text` verbatim. Doctrine:
              // `chrome-as-state-render.md` § "Hybrid narration
              // source." Mirrors `apps/web/src/ui/chat.ts` —
              // chrome-as-state-render's task-step narration triple
              // (wire field + prompt clause + runtime validation)
              // now feeds two surfaces from one wire.
              setTaskStepNarration(chunk.text);
              break;
            }

            case "approval_request": {
              const approvalId = crypto.randomUUID();
              pendingApprovalRef.current = approvalId;
              setMessages((prev) => [
                ...prev,
                {
                  id: approvalId,
                  role: "approval",
                  content: "",
                  timestamp: Date.now(),
                  toolName: chunk.name,
                  toolArgs: chunk.args,
                  riskLevel: chunk.risk_level,
                  approvalResolved: false,
                },
              ]);
              // Stream pauses here — will resume via handleApproval
              return;
            }

            case "delegation_start":
              addSystemMessage(`Delegating to ${chunk.server}...`);
              break;

            case "delegation_complete": {
              // If a full signed receipt arrived, emerge it as a receipt
              // artifact message — renders via <ReceiptArtifact>, verifies
              // locally with Ed25519. Falls back to the short system line
              // when only a receipt summary is present (motebit-tool
              // delegations without signed chain).
              if (chunk.full_receipt) {
                const full = chunk.full_receipt;
                setMessages((prev) => [
                  ...prev,
                  {
                    id: crypto.randomUUID(),
                    role: "receipt",
                    content: "",
                    timestamp: Date.now(),
                    receipt: full,
                  },
                ]);
              } else {
                const status =
                  chunk.receipt != null && chunk.receipt.status === "failed" ? "\u2717" : "\u2713";
                const toolInfo =
                  chunk.receipt != null
                    ? ` (${chunk.receipt.tools_used.length} tool${chunk.receipt.tools_used.length !== 1 ? "s" : ""})`
                    : "";
                addSystemMessage(`Delegated to ${chunk.server} ${status}${toolInfo}`);
              }
              break;
            }

            case "injection_warning":
              addSystemMessage(`Warning: injection patterns detected in ${chunk.tool_name}`);
              break;

            case "result":
              // Final update — thread the leverage moment (felt-accumulation
              // Inc 3) onto the message, produced-not-authored; absent is the
              // fail-closed default (no consequential recall → no attribution).
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? {
                        ...m,
                        content: stripTags(assistantContent) || "...",
                        timestamp: Date.now(),
                        accrualBasis: chunk.result.accrualBasis,
                      }
                    : m,
                ),
              );
              break;
          }
        }

        // Ensure final content is set and speak via TTS if voice enabled
        if (assistantContent) {
          const finalText = stripTags(assistantContent);
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantId ? { ...m, content: finalText, timestamp: Date.now() } : m,
            ),
          );

          // TTS — flush remaining streamed speech
          flushTTS();
        }
      } finally {
        // Per-turn streaming-surface state must clear on EVERY
        // termination path: success exit (after the for-await
        // drains), the approval-request `return`, AND propagated
        // errors. A stale narration would otherwise render against
        // an unrelated state on a subsequent turn — same hazard
        // `apps/web/src/ui/chat.ts` clears in its `finally`.
        // Memory anchor: `feedback_streaming_state_cleanup_every_path`.
        setTaskStepNarration(null);
      }
    },
    [setMessages, addSystemMessage, pushTTSChunk, flushTTS, setTaskStepNarration],
  );

  const handleApproval = useCallback(
    async (messageId: string, approved: boolean) => {
      // Mark card as resolved
      setMessages((prev) =>
        prev.map((m) => (m.id === messageId ? { ...m, approvalResolved: true } : m)),
      );

      const isGoalApproval = pendingGoalApprovalRef.current;

      if (isGoalApproval) {
        // Goal approval: stream the continuation via resumeGoalAfterApproval
        pendingGoalApprovalRef.current = false;
        try {
          await consumeStream(app.resumeGoalAfterApproval(approved));
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          addSystemMessage(`[Goal error: ${errMsg}]`);
        } finally {
          pendingApprovalRef.current = null;
        }
      } else {
        // Regular chat approval
        setIsProcessing(true);
        try {
          await consumeStream(app.resolveApprovalVote(approved, app.motebitId));
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          addSystemMessage(`[Error: ${errMsg}]`);
        } finally {
          setIsProcessing(false);
          pendingApprovalRef.current = null;
        }
      }
    },
    [consumeStream, app, setMessages, addSystemMessage, setIsProcessing],
  );

  return { consumeStream, handleApproval };
}
