/**
 * Shared shapes for the intelligence-parity bench. Plain data — every record
 * here is what lands in the committed-format JSON output, so a reader of
 * `results.json` and a reader of this file see the same thing.
 */

/** Prompt categories. Closed so the report's per-category table is complete. */
export const PROMPT_CATEGORIES = [
  "factual",
  "explanation",
  "coding",
  "architecture",
  "writing",
  "synthesis",
  "long-context",
  "memory",
  "tool",
] as const;
export type PromptCategory = (typeof PROMPT_CATEGORIES)[number];

export interface ScriptedMessage {
  role: "user" | "assistant";
  content: string;
}

export interface SeedMemory {
  content: string;
  /** Defaults to `personal` — the context-safe tier, so it can reach BYOK egress. */
  sensitivity?: "none" | "personal";
  memory_type?: "episodic" | "semantic";
}

export interface BenchPrompt {
  id: string;
  category: PromptCategory;
  /** The answer needs a tool round (route A offers the deterministic tool subset). */
  tools_expected: boolean;
  /** The answer needs something the user said in an EARLIER session (seeded memory). */
  memory_expected: boolean;
  /** Prior turns of THIS conversation, oldest first. Must alternate, starting with user. */
  history?: ScriptedMessage[];
  /** Facts formed through the real memory-formation path before the turn. */
  seed_memories?: SeedMemory[];
  /** The turn under test. */
  prompt: string;
  /** What a correct answer must contain — given to the judge, never to the model. */
  reference_notes?: string;
}

export interface PromptSet {
  version: number;
  prompts: BenchPrompt[];
}

/** Route identity. `Bp` is B′: motebit's exact request replayed directly. */
export type RouteId = "A" | "B" | "Bp" | "C";

export const ROUTE_LABELS: Readonly<Record<RouteId, string>> = {
  A: "motebit runtime",
  B: "direct API, neutral prompt, untrimmed history",
  Bp: "direct API, motebit's exact request replayed",
  C: "vendor product (manually collected)",
};

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

/** One HTTP round to `/v1/messages`, as observed on the wire. */
export interface WireExchange {
  url: string;
  /** The exact JSON body sent (api key never lives in the body). */
  request_body: Record<string, unknown>;
  status: number;
  started_at: number;
  /** First streamed `text_delta`. Absent on a round that streamed no text. */
  first_text_at?: number;
  ended_at?: number;
  usage: Usage;
  stop_reason?: string;
  /** Reassembled content blocks (text / thinking / tool_use …), in order. */
  content: Array<Record<string, unknown>>;
  text: string;
  error?: string;
}

/** Everything not content: the parameters B and B′ copy from A. */
export type FrozenParams = Record<string, unknown>;

export interface RouteResult {
  route: RouteId;
  prompt_id: string;
  repetition: number;
  answer: string;
  /** Turn entry → first answer text the caller saw. */
  ttft_ms: number | null;
  total_ms: number;
  usage: Usage;
  model_rounds: number;
  tool_calls: Array<{ name: string; input: unknown }>;
  /** Every in-turn request body sent, in order (round 1 first). */
  requests: Array<Record<string, unknown>>;
  /** Params actually sent on round 1 — for A the source, for B/B′ the copy. */
  params: FrozenParams;
  error?: string;
}

export interface MotebitTurnDetail {
  /** `TurnLatency` from the runtime, verbatim. Absent on a text-free turn. */
  latency?: {
    ttft_ms: number;
    context_pipeline_ms: number;
    provider_ttft_ms: number;
    event_query_ms: number;
    embed_ms: number;
    pinned_ms: number;
    memory_retrieve_ms: number;
  };
  /** Scripted history messages the prompt carried. */
  history_messages: number;
  /** How many of them reached the model on round 1 (after trimming). */
  history_retained: number;
  history_tokens_est: number;
  history_tokens_retained_est: number;
  /** Did trimming prepend its synthetic "[This conversation continues…]" note? */
  trim_note_injected: boolean;
  memories_retrieved: number;
  /** Non-turn provider calls during the turn (classification, titles …). */
  auxiliary_calls: number;
  auxiliary_usage: Usage;
  system_prompt_chars: number;
}

export interface RouteAResult extends RouteResult {
  route: "A";
  motebit: MotebitTurnDetail;
}

export interface DirectRouteResult extends RouteResult {
  route: "B" | "Bp";
  /** Tool calls answered by replaying A's recorded result vs. refused. */
  tool_replay: { replayed: number; unavailable: number };
}

export interface PromptRun {
  prompt_id: string;
  category: PromptCategory;
  repetition: number;
  results: Partial<Record<RouteId, RouteResult>>;
}

export interface RunFile {
  bench: "intelligence-parity";
  version: 1;
  started_at: string;
  model: string;
  routes: RouteId[];
  repetitions: number;
  runs: PromptRun[];
  spend_usd: number;
}

/** Route C — one manually collected answer from a vendor product UI. */
export interface RouteCEntry {
  prompt_id: string;
  answer: string;
  /** e.g. "claude.ai (Claude Sonnet 5)", "chatgpt.com (GPT-5)". */
  source: string;
  /** ISO-8601 when the answer was collected. */
  collected_at: string;
}

export interface RouteCFile {
  bench: "intelligence-parity/route-c";
  version: 1;
  entries: RouteCEntry[];
}

export const SCORE_DIMENSIONS = ["correctness", "completeness", "depth", "clarity"] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];
export type Scores = Record<ScoreDimension, number>;

export interface PairwiseVerdict {
  a: RouteId;
  b: RouteId;
  winner: RouteId | "tie";
}

export interface Judgment {
  prompt_id: string;
  category: PromptCategory;
  repetition: number;
  judge_model: string;
  scores: Partial<Record<RouteId, Scores>>;
  pairwise: PairwiseVerdict[];
  /** The blinding map, kept for audit; never shown to the judge. */
  presentation_order: RouteId[];
  error?: string;
}

export interface JudgeFile {
  bench: "intelligence-parity/judgments";
  version: 1;
  judge_model: string;
  judgments: Judgment[];
  spend_usd: number;
}
