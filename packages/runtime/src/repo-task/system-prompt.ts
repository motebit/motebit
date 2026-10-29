/**
 * Repo task — the context pack and the system prompt (docs/proposals/governed-repo-change-v1.md
 * § "The chain", step 4, "Interior: none").
 *
 * Every pack the run sends is built here from the verified scope and the
 * run's own conversation, nothing else: no events, no memories, no memory
 * index, no skills, no known agents or trust context, no session state, no
 * first-conversation or activation prompt, a constant neutral state vector,
 * no behaviour cues. There is no store to read them from — the run holds none.
 *
 * The system prompt is what the provider's prompt builder (`buildSystemPrompt`,
 * `@motebit/ai-core` — the same function the Anthropic and OpenAI providers
 * render from the pack) makes of that pack with the default personality. So
 * it is a pure function of (scope, tools, runtime_version, model): the run
 * computes it, records its SHA-256 as `system_prompt_digest`, and re-derives
 * it from every pack it sends, aborting if one would ever differ.
 *
 * The provider must be constructed with the default personality (no
 * `personalityConfig`) — that is the caller's half of "never reads
 * ~/.motebit/config.json" (step 4's CLI constructs it).
 */

import { buildSystemPrompt } from "@motebit/ai-core";
import type { ContextPack, ConversationMessage, MotebitState, ToolDefinition } from "@motebit/sdk";
import { BatteryMode, TrustMode } from "@motebit/sdk";
import type { RepoChangeTool, RepoTaskScope } from "@motebit/protocol";

/** A constant neutral state: the run has no state vector of its own. */
const REPO_TASK_STATE: MotebitState = Object.freeze({
  attention: 0,
  processing: 0,
  confidence: 0.5,
  affect_valence: 0,
  affect_arousal: 0,
  social_distance: 0.5,
  curiosity: 0,
  trust_mode: TrustMode.Guarded,
  battery_mode: BatteryMode.Normal,
});

/**
 * The run's one piece of system text beyond the builder's own: what this run
 * is and the bounds it acts under. Carried in the pack's `precisionContext`
 * slot, the only free-text slot the shared builder renders into the system
 * prompt (a repo task has no gradient, so the slot is otherwise empty).
 */
export function repoTaskFrame(
  scope: RepoTaskScope,
  tools: readonly RepoChangeTool[],
  runtimeVersion: string,
): string {
  return [
    `[Repo task] motebit runtime ${runtimeVersion}. You are making one change to the repository ${scope.repo}, starting from its ${scope.base_ref} branch, under a scope your principal signed.`,
    `Your only tools: ${tools.join(", ")}. You may write only: ${scope.allowed_paths.join(", ")} (at most ${scope.max_changed_files} file(s)). Any other call is refused and recorded.`,
    "You have no memory and form none in this run. When the change is made, reply with a short summary.",
  ].join("\n");
}

export interface RepoTaskPackInput {
  readonly scope: RepoTaskScope;
  readonly tools: readonly ToolDefinition[];
  readonly frame: string;
  /** The run's conversation so far: the task, the model's calls and their results. */
  readonly history: readonly ConversationMessage[];
  /** The first model call carries the task as the user message; later calls continue the history. */
  readonly first: boolean;
}

/** The context pack for one model call. */
export function buildRepoTaskPack(input: RepoTaskPackInput): ContextPack {
  return {
    recent_events: [],
    relevant_memories: [],
    current_state: REPO_TASK_STATE,
    user_message: input.first ? input.scope.task : "",
    ...(input.first ? {} : { conversation_history: [...input.history] }),
    tools: [...input.tools],
    precisionContext: input.frame,
  };
}

/**
 * The system prompt the provider renders from a pack (default personality,
 * the run's model). For a repo-task pack this does not depend on the history
 * or on which call it is.
 */
export function repoTaskSystemPrompt(pack: ContextPack, model: string): string {
  return buildSystemPrompt(pack, undefined, { model });
}
