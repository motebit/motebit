/**
 * Spatial voice commands — fuzzy natural-language dispatcher that
 * routes a voice transcript to the shared command layer
 * (`executeCommand`) via regex pattern matching.
 *
 * Each command returns a spoken response string, or null to fall
 * through to the AI conversation path.
 *
 * ### Two command shapes
 *
 *   1. **Shared commands** (state, balance, memories, graph, curious,
 *      gradient, reflect, discover, approvals, forget, audit,
 *      summarize, conversations, deposits, proposals, model, tools) —
 *      handled by `@motebit/runtime`'s `executeCommand` and formatted
 *      for TTS (summary + optional short detail).
 *
 *   2. **Surface-specific commands** (clear, mcp, serve,
 *      load_conversation, delete_conversation, goal) — handled inline
 *      because they need state mutation, surface-specific presentation,
 *      or streaming execution (goal execution runs a PlanExecutionVM
 *      and speaks step-completion announcements).
 *
 * The dispatcher is a plain async function rather than a class —
 * there's no internal state, only injected deps. Keeps the vocabulary
 * reviewable in one place and removes ~200 lines from the app kernel.
 */

import { executeCommand, PlanExecutionVM } from "@motebit/runtime";
import type { MotebitRuntime, RelayConfig, PlanChunk } from "@motebit/runtime";
import { matchOrAsk, stringSimilaritySignal } from "@motebit/semiring";
import type { SpatialVoicePipeline } from "./voice-pipeline";

export interface VoiceCommandDeps {
  getRuntime: () => MotebitRuntime | null;
  getRelayConfig: () => RelayConfig | null;
  voicePipeline: SpatialVoicePipeline;
  /** Delegates to SpatialApp for surface-level state mutations. */
  resetConversation: () => void;
  getMcpServers: () => Array<{ name: string }>;
  listConversations: () => Array<{ conversationId: string; title: string | null }>;
  loadConversationById: (id: string) => void;
  deleteConversation: (id: string) => void;
  executeGoal: (goalId: string, prompt: string) => AsyncGenerator<PlanChunk>;
}

/**
 * Try to handle a voice transcript as a command. Routes natural-language
 * voice input to the shared command layer via fuzzy pattern matching.
 *
 * Returns spoken response if handled, or null to fall through to AI.
 */
export async function tryVoiceCommand(
  text: string,
  deps: VoiceCommandDeps,
): Promise<string | null> {
  const runtime = deps.getRuntime();
  if (!runtime) return null;

  const lower = text.toLowerCase().trim();

  // Map natural-language patterns to shared command names + args
  const command = matchVoicePattern(lower);
  if (!command) return null;

  const { name, args } = command;

  // Surface-specific commands that can't go through the shared layer
  if (name === "clear") {
    deps.resetConversation();
    return "Conversation cleared.";
  }
  if (name === "mcp") {
    const servers = deps.getMcpServers();
    if (servers.length === 0) return "No MCP servers connected.";
    return `${servers.length} MCP servers: ${servers.map((s) => s.name).join(", ")}.`;
  }
  if (name === "serve") {
    return "Serving is configured through the relay. Use the CLI to start serving with a price.";
  }
  if (name === "load_conversation") {
    return handleLoadConversation(lower, deps);
  }
  if (name === "delete_conversation") {
    return handleDeleteConversation(lower, deps);
  }
  if (name === "goal") {
    return handleGoalExecution(text, deps);
  }

  // Shared command layer — same data extraction and formatting as all surfaces
  const relay = deps.getRelayConfig();
  try {
    const result = await executeCommand(runtime, name, args, relay ?? undefined);
    if (!result) return null;

    // For TTS: speak summary, include detail if short enough
    if (result.detail && result.detail.length < 200) {
      return `${result.summary}. ${result.detail}`;
    }
    return result.summary;
  } catch (err: unknown) {
    return `${name} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

/**
 * Match natural-language voice input to a command name.
 * Returns null if no pattern matches (fall through to AI).
 */
function matchVoicePattern(lower: string): { name: string; args?: string } | null {
  // State
  if (/^(what('?s| is) my )?state/.test(lower) || /^show ?(me )?(the )?state/.test(lower))
    return { name: "state" };

  // Balance
  if (/^(what('?s| is) my )?balance/.test(lower) || /^show ?(me )?(the )?balance/.test(lower))
    return { name: "balance" };

  // Memories
  if (/^(show |list |what are )?(my )?memories/.test(lower)) return { name: "memories" };

  // Graph
  if (/^(memory )?graph/.test(lower)) return { name: "graph" };

  // Curiosity
  if (/^(what('?s| is) )?(my )?curios/.test(lower)) return { name: "curious" };

  // Gradient
  if (/^(what('?s| is) )?(my )?gradient/.test(lower) || /^how am i doing/.test(lower))
    return { name: "gradient" };

  // Reflect
  if (/^reflect/.test(lower) || /^self.?reflect/.test(lower)) return { name: "reflect" };

  // Discover
  if (/^(discover|find|search for) agent/.test(lower) || /^who('?s| is) (on|available)/.test(lower))
    return { name: "discover" };

  // Approvals
  if (/^(show |any |pending )?approval/.test(lower)) return { name: "approvals" };

  // Forget
  if (/^forget (about |memory )?(.+)/i.test(lower)) {
    const keyword = lower.replace(/^forget (about |memory )?/i, "").trim();
    return { name: "forget", args: keyword };
  }

  // Audit
  if (/^audit (my )?(memory|memories)/.test(lower)) return { name: "audit" };

  // Summarize
  if (/^summarize/.test(lower) || /^sum up/.test(lower)) return { name: "summarize" };

  // Conversations list
  if (/^(list |show |my )?(previous |past )?(conversation|chat|session)s/.test(lower))
    return { name: "conversations" };

  // Load conversation (surface-specific — needs state mutation)
  if (/^(load|open|resume) (conversation|chat) /.test(lower)) return { name: "load_conversation" };

  // Delete conversation (surface-specific — needs state mutation)
  if (/^delete (conversation|chat) /.test(lower)) return { name: "delete_conversation" };

  // Goal execution (surface-specific — streaming)
  if (/^(goal|plan|do|execute|run):? (.+)/i.test(lower)) return { name: "goal" };

  // Deposits
  if (/^(show |my )?deposit/.test(lower)) return { name: "deposits" };

  // Proposals
  if (/^(show |my |list )?proposal/.test(lower)) return { name: "proposals" };

  // Clear
  if (/^(clear|reset|new) (conversation|chat|session)/.test(lower)) return { name: "clear" };

  // Model
  if (/^(what |which )?(model|ai)/.test(lower)) return { name: "model" };

  // MCP
  if (/^(list |show )?(mcp|servers)/.test(lower)) return { name: "mcp" };

  // Tools
  if (/^(list |show |what )?(my )?tools/.test(lower)) return { name: "tools" };

  // Serve
  if (/^(start |begin )?serv(e|ing)/.test(lower) || /^accept (task|delegation)/.test(lower))
    return { name: "serve" };

  return null;
}

// --- Surface-specific command handlers (state mutations, streaming) ---

function handleLoadConversation(lower: string, deps: VoiceCommandDeps): string {
  const convs = deps.listConversations();
  if (convs.length === 0) return "No conversations to load.";
  const keyword = lower.replace(/^(load|open|resume) (conversation|chat) ?/i, "").trim();
  if (!keyword) {
    // No disambiguation needed — the first listed conversation is the target.
    const first = convs[0]!;
    deps.loadConversationById(first.conversationId);
    return `Loaded: ${first.title ?? "untitled conversation"}.`;
  }
  const decision = matchOrAsk(
    convs,
    stringSimilaritySignal(keyword, (c) => c.title ?? ""),
    { threshold: 0.3, separation: 0.15, maxAlternatives: 3 },
  );
  if (decision.kind === "none") return `No conversation matching "${keyword}".`;
  if (decision.kind === "ambiguous") {
    const titles = decision
      .alternatives!.map((c) => c.title ?? "untitled")
      .slice(0, 3)
      .join(", ");
    return `Multiple conversations match "${keyword}": ${titles}. Say the full title.`;
  }
  deps.loadConversationById(decision.winner!.conversationId);
  return `Loaded: ${decision.winner!.title ?? "untitled conversation"}.`;
}

function handleDeleteConversation(lower: string, deps: VoiceCommandDeps): string {
  const convs = deps.listConversations();
  const keyword = lower.replace(/^delete (conversation|chat) ?/i, "").trim();
  if (!keyword) return "Which conversation? Say the title.";
  const decision = matchOrAsk(
    convs,
    stringSimilaritySignal(keyword, (c) => c.title ?? ""),
    { threshold: 0.3, separation: 0.15, maxAlternatives: 3 },
  );
  if (decision.kind === "none") return `No conversation matching "${keyword}".`;
  if (decision.kind === "ambiguous") {
    const titles = decision
      .alternatives!.map((c) => c.title ?? "untitled")
      .slice(0, 3)
      .join(", ");
    return `Multiple conversations match "${keyword}": ${titles}. Say the full title.`;
  }
  deps.deleteConversation(decision.winner!.conversationId);
  return `Deleted: ${decision.winner!.title ?? "untitled conversation"}.`;
}

async function handleGoalExecution(text: string, deps: VoiceCommandDeps): Promise<string> {
  const prompt = text.replace(/^(goal|plan|do|execute|run):?\s*/i, "").trim();
  if (!prompt) return "What should the goal be?";
  const goalId = crypto.randomUUID();
  const evm = new PlanExecutionVM();
  try {
    for await (const chunk of deps.executeGoal(goalId, prompt)) {
      evm.apply(chunk);
      // Announce step completions via TTS as they happen
      const snap = evm.snapshot();
      if (chunk.type === "step_completed" && snap.progress.total > 1) {
        await deps.voicePipeline.speak(
          `Step ${snap.progress.completed} of ${snap.progress.total}: ${chunk.step.description}.`,
        );
      }
    }
    const snap = evm.snapshot();
    if (snap.status === "completed") {
      return snap.reflection ?? `Goal complete: ${snap.title}.`;
    }
    return `Goal ${snap.status}: ${snap.failureReason ?? snap.title}.`;
  } catch (err: unknown) {
    return `Goal failed: ${err instanceof Error ? err.message : String(err)}.`;
  }
}
