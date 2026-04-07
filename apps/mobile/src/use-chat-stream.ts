/**
 * `useChatStream` — React hook that owns the chat stream consumer and
 * approval handler for the mobile App. Extracted from `App.tsx` as
 * Target 8 of the mobile extraction plan.
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
import type { MobileApp } from "./mobile-app";

export interface ChatStreamMessage {
  id: string;
  role: "user" | "assistant" | "system" | "approval";
  content: string;
  timestamp: number;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  riskLevel?: number;
  approvalResolved?: boolean;
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
  } = deps;

  const consumeStream = useCallback(
    async (stream: AsyncGenerator<StreamChunk>) => {
      let assistantContent = "";
      const assistantId = crypto.randomUUID();

      // Add placeholder
      setMessages((prev) => [
        ...prev,
        { id: assistantId, role: "assistant", content: "...", timestamp: Date.now() },
      ]);

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

          case "tool_status":
            if (chunk.status === "calling") {
              addSystemMessage(`Calling ${chunk.name}...`);
            }
            break;

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
            const status =
              chunk.receipt != null && chunk.receipt.status === "failed" ? "\u2717" : "\u2713";
            const toolInfo =
              chunk.receipt != null
                ? ` (${chunk.receipt.tools_used.length} tool${chunk.receipt.tools_used.length !== 1 ? "s" : ""})`
                : "";
            addSystemMessage(`Delegated to ${chunk.server} ${status}${toolInfo}`);
            break;
          }

          case "injection_warning":
            addSystemMessage(`Warning: injection patterns detected in ${chunk.tool_name}`);
            break;

          case "result":
            // Final update
            setMessages((prev) =>
              prev.map((m) =>
                m.id === assistantId
                  ? { ...m, content: stripTags(assistantContent) || "...", timestamp: Date.now() }
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
    },
    [setMessages, addSystemMessage, pushTTSChunk, flushTTS],
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
