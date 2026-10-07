/**
 * Blind judge — scores the routes' answers without knowing which is which.
 *
 * Blinding is three moves, all here so the test can hold them:
 *   1. ORDER — answers are shuffled per prompt with a seeded RNG (repeatable).
 *   2. LABELS — the judge sees "Response 1…N" only; the route map stays in the
 *      output file for de-blinding and never enters the judge prompt.
 *   3. MARKERS — self-identifying text is masked. Route A's persona introduces
 *      itself by name, and a vendor product may name its model or company; any
 *      of those would tell the judge the route. Masked uniformly in EVERY
 *      answer so the mask itself is not a tell.
 *
 * The judge model defaults to a different model than the one under test (a
 * model grading its own outputs is the self-preference bias this avoids).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { BenchPrompt, Judgment, PairwiseVerdict, RouteId, Scores, Usage } from "./types.js";
import { SCORE_DIMENSIONS } from "./types.js";
import type { BenchProvider } from "./types.js";
import { directHeaders, endpointFor, protocolOf } from "./protocol.js";
import { openAiRequestShape } from "../../../packages/ai-core/src/index.js";
import { ZERO_USAGE } from "./wire-tap.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RUBRIC_PATH = path.join(HERE, "rubric.md");

/** Identity markers masked out of every answer before the judge sees it. */
const IDENTITY_PATTERNS: readonly RegExp[] = [
  /\bmotebits?\b/gi,
  /\bclaude(?:\.ai)?(?:[- ](?:opus|sonnet|haiku|fable|mythos))?(?:[- ]?\d+(?:[.-]\d+)*)?\b/gi,
  /\bchat\s?gpt\b/gi,
  /\bgpt-?\d+(?:\.\d+)?(?:-[a-z]+)?\b/gi,
  /\bopenai\b/gi,
  /\banthropic\b/gi,
  /\bgemini\b/gi,
  /\bdeepseek\b/gi,
  /\bgroq\b/gi,
  /\bllama[- ]?\d+(?:\.\d+)*\b/gi,
];
export const IDENTITY_MASK = "[assistant]";

export function maskIdentity(text: string): string {
  let out = text;
  for (const re of IDENTITY_PATTERNS) out = out.replace(re, IDENTITY_MASK);
  // Runtime-internal markup that only one route could emit.
  out = out.replace(/<\/?(?:state|memory|thinking)[^>]*>/gi, "");
  out = out.replace(/\[from:[a-z_]+\]/gi, "");
  return out.trim();
}

/** mulberry32 — tiny seeded PRNG so a judged run can be re-blinded identically. */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface BlindedSet {
  /** presentation_order[i] is the route shown as "Response i+1". */
  presentation_order: RouteId[];
  texts: string[];
}

export function blind(
  answers: ReadonlyArray<{ route: RouteId; text: string }>,
  rng: () => number,
): BlindedSet {
  const items = answers.map((a) => ({ route: a.route, text: maskIdentity(a.text) }));
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return { presentation_order: items.map((i) => i.route), texts: items.map((i) => i.text) };
}

/** The ONLY text the judge receives. Contains no route id, label or map. */
export function buildJudgeUserMessage(prompt: BenchPrompt, blinded: BlindedSet): string {
  const parts: string[] = [];
  if (prompt.seed_memories && prompt.seed_memories.length > 0) {
    parts.push(
      "Facts the user shared with the assistant in an EARLIER conversation (the assistant may or may not have retained them):",
      ...prompt.seed_memories.map((m) => `- ${maskIdentity(m.content)}`),
      "",
    );
  }
  if (prompt.history && prompt.history.length > 0) {
    parts.push("The conversation so far:");
    for (const m of prompt.history) {
      parts.push(`[${m.role}] ${maskIdentity(m.content)}`);
    }
    parts.push("");
  }
  parts.push(`The user's message being answered:\n${maskIdentity(prompt.prompt)}`, "");
  if (prompt.reference_notes) {
    parts.push(
      `Grader's reference notes (what a correct answer must get right):\n${prompt.reference_notes}`,
      "",
    );
  }
  blinded.texts.forEach((t, i) => {
    parts.push(`=== Response ${i + 1} ===`, t.length > 0 ? t : "(empty response)", "");
  });
  return parts.join("\n");
}

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return Number.NaN;
  return Math.min(10, Math.max(1, n));
}

/** Parse the judge's JSON and DE-BLIND it back onto route ids. */
export function parseJudgeReply(
  reply: string,
  order: readonly RouteId[],
): { scores: Partial<Record<RouteId, Scores>>; pairwise: PairwiseVerdict[] } {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("judge reply contained no JSON object");
  const data = JSON.parse(reply.slice(start, end + 1)) as {
    scores?: Record<string, Record<string, unknown>>;
    pairwise?: Array<{ a?: unknown; b?: unknown; winner?: unknown }>;
  };
  const routeOf = (label: unknown): RouteId | undefined => {
    const n = Number(String(label).replace(/[^0-9]/g, ""));
    return Number.isInteger(n) && n >= 1 && n <= order.length ? order[n - 1] : undefined;
  };
  const scores: Partial<Record<RouteId, Scores>> = {};
  for (const [label, s] of Object.entries(data.scores ?? {})) {
    const route = routeOf(label);
    if (!route) continue;
    const row = {} as Scores;
    let ok = true;
    for (const dim of SCORE_DIMENSIONS) {
      row[dim] = clampScore(s[dim]);
      if (Number.isNaN(row[dim])) ok = false;
    }
    if (ok) scores[route] = row;
  }
  const pairwise: PairwiseVerdict[] = [];
  for (const p of data.pairwise ?? []) {
    const a = routeOf(p.a);
    const b = routeOf(p.b);
    if (!a || !b || a === b) continue;
    const w = String(p.winner).toLowerCase() === "tie" ? "tie" : routeOf(p.winner);
    if (w === undefined || (w !== "tie" && w !== a && w !== b)) continue;
    pairwise.push({ a, b, winner: w });
  }
  return { scores, pairwise };
}

/** A judge request in one provider-neutral shape; each transport maps it onto its wire. */
export interface JudgeRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: "user"; content: string }>;
}

export interface JudgeTransport {
  /** Send the judge request; return reply text + usage. */
  (body: JudgeRequest): Promise<{ text: string; usage: Usage }>;
}

/** The judge's request body on the provider's own wire (non-streaming). */
export function judgeWireBody(provider: BenchProvider, req: JudgeRequest): Record<string, unknown> {
  if (protocolOf(provider) === "anthropic") return { ...req };
  return {
    model: req.model,
    messages: [{ role: "system", content: req.system }, ...req.messages],
    // Same budget-field rule the product's OpenAI adapter applies per model family.
    ...(openAiRequestShape(req.model) === "reasoning-era"
      ? { max_completion_tokens: req.max_tokens }
      : { max_tokens: req.max_tokens }),
    stream: false,
  };
}

export function judgeTransport(
  provider: BenchProvider,
  apiKey: string,
  baseUrl: string,
): JudgeTransport {
  const protocol = protocolOf(provider);
  return async (req) => {
    const res = await fetch(endpointFor(protocol, baseUrl), {
      method: "POST",
      headers: directHeaders(protocol, apiKey),
      body: JSON.stringify(judgeWireBody(provider, req)),
    });
    if (!res.ok) throw new Error(`judge HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    if (protocol === "anthropic") {
      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        usage?: Partial<Usage>;
      };
      return {
        text: (data.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join(""),
        usage: { ...ZERO_USAGE, ...data.usage } as Usage,
      };
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        prompt_tokens_details?: { cached_tokens?: number };
      };
    };
    const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      text: data.choices?.[0]?.message?.content ?? "",
      usage: {
        input_tokens: Math.max(0, (data.usage?.prompt_tokens ?? 0) - cached),
        output_tokens: data.usage?.completion_tokens ?? 0,
        cache_read_input_tokens: cached,
        cache_creation_input_tokens: 0,
      },
    };
  };
}

export const JUDGE_MAX_TOKENS = 4096;

export async function judgePrompt(
  prompt: BenchPrompt,
  repetition: number,
  answers: ReadonlyArray<{ route: RouteId; text: string }>,
  judgeModel: string,
  transport: JudgeTransport,
  rubric: string,
): Promise<{ judgment: Judgment; usage: Usage }> {
  const blinded = blind(answers, seededRng(hashSeed(`${prompt.id}#${repetition}`)));
  const base: Judgment = {
    prompt_id: prompt.id,
    category: prompt.category,
    repetition,
    judge_model: judgeModel,
    scores: {},
    pairwise: [],
    presentation_order: blinded.presentation_order,
  };
  try {
    const { text, usage } = await transport({
      model: judgeModel,
      max_tokens: JUDGE_MAX_TOKENS,
      system: rubric,
      messages: [{ role: "user", content: buildJudgeUserMessage(prompt, blinded) }],
    });
    const parsed = parseJudgeReply(text, blinded.presentation_order);
    return { judgment: { ...base, ...parsed }, usage };
  } catch (err) {
    return {
      judgment: { ...base, error: err instanceof Error ? err.message : String(err) },
      usage: { ...ZERO_USAGE },
    };
  }
}

export function loadRubric(): string {
  return fs.readFileSync(RUBRIC_PATH, "utf8");
}
