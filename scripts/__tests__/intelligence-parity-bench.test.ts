/**
 * intelligence-parity bench — harness self-tests. NO network: every
 * `/v1/messages` call is answered by an in-process fake beneath the wire tap,
 * so route A runs the real `MotebitRuntime` + `AnthropicProvider` against a
 * fake transport and nothing is spent.
 */
import { afterEach, describe, expect, it } from "vitest";
import { installWireTap, type WireTap } from "../bench/intelligence-parity/wire-tap.js";
import {
  buildRouteBRequest,
  buildRouteBpRequest,
  CONTENT_KEYS,
  freezeParams,
  indexToolResults,
  NEUTRAL_SYSTEM_PROMPT,
} from "../bench/intelligence-parity/params.js";
import { runDirectRoute } from "../bench/intelligence-parity/route-direct.js";
import {
  measureRetention,
  runMotebitRoute,
  splitRounds,
} from "../bench/intelligence-parity/route-motebit.js";
import {
  blind,
  buildJudgeUserMessage,
  hashSeed,
  IDENTITY_MASK,
  judgePrompt,
  loadRubric,
  maskIdentity,
  parseJudgeReply,
  seededRng,
} from "../bench/intelligence-parity/judge.js";
import {
  buildReport,
  latencyStats,
  median,
  outputLengthRatio,
  percentile,
  renderMarkdown,
  winRate,
} from "../bench/intelligence-parity/report.js";
import {
  assertEstimateWithinBudget,
  costUsd,
  estimateRun,
  priceFor,
  SpendLimitExceeded,
  SpendMeter,
} from "../bench/intelligence-parity/spend.js";
import {
  loadPrompts,
  parseArgs,
  runRoutes,
  selectPrompts,
} from "../bench/intelligence-parity/run.js";
import type {
  BenchPrompt,
  Judgment,
  RouteResult,
  RunFile,
  Usage,
} from "../bench/intelligence-parity/types.js";
import { ROUTE_LABELS } from "../bench/intelligence-parity/types.js";

// === Fake Anthropic transport ===

interface FakeTurn {
  text?: string;
  toolUse?: { id: string; name: string; input: Record<string, unknown> };
  usage?: Partial<Usage>;
}

function sse(events: Array<Record<string, unknown>>): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const e of events) {
        controller.enqueue(
          enc.encode(`event: ${String(e["type"])}\ndata: ${JSON.stringify(e)}\n\n`),
        );
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function turnEvents(turn: FakeTurn): Array<Record<string, unknown>> {
  const u = {
    input_tokens: 100,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    ...turn.usage,
  };
  const ev: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: {
        usage: {
          input_tokens: u.input_tokens,
          cache_read_input_tokens: u.cache_read_input_tokens,
          cache_creation_input_tokens: u.cache_creation_input_tokens,
          output_tokens: 1,
        },
      },
    },
  ];
  let i = 0;
  if (turn.text !== undefined) {
    ev.push({ type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
    // Split so reassembly is exercised.
    const half = Math.ceil(turn.text.length / 2);
    ev.push({
      type: "content_block_delta",
      index: i,
      delta: { type: "text_delta", text: turn.text.slice(0, half) },
    });
    ev.push({
      type: "content_block_delta",
      index: i,
      delta: { type: "text_delta", text: turn.text.slice(half) },
    });
    ev.push({ type: "content_block_stop", index: i });
    i += 1;
  }
  if (turn.toolUse) {
    const json = JSON.stringify(turn.toolUse.input);
    ev.push({
      type: "content_block_start",
      index: i,
      content_block: { type: "tool_use", id: turn.toolUse.id, name: turn.toolUse.name, input: {} },
    });
    ev.push({
      type: "content_block_delta",
      index: i,
      delta: { type: "input_json_delta", partial_json: json.slice(0, 3) },
    });
    ev.push({
      type: "content_block_delta",
      index: i,
      delta: { type: "input_json_delta", partial_json: json.slice(3) },
    });
    ev.push({ type: "content_block_stop", index: i });
  }
  ev.push({
    type: "message_delta",
    delta: { stop_reason: turn.toolUse ? "tool_use" : "end_turn" },
    usage: { output_tokens: u.output_tokens || 7 },
  });
  ev.push({ type: "message_stop" });
  return ev;
}

/** A fake `/v1/messages`. `script` decides each reply from the request body. */
function fakeAnthropic(script: (body: Record<string, unknown>, n: number) => FakeTurn) {
  const received: Array<Record<string, unknown>> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.endsWith("/v1/messages")) throw new Error(`unexpected fetch in test: ${url}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    received.push(body);
    const turn = script(body, received.length);
    if (body["stream"] === true) return sse(turnEvents(turn));
    return new Response(
      JSON.stringify({
        content: [{ type: "text", text: turn.text ?? "" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  return { fetchImpl, received };
}

const FAKE_BASE = "https://fake-anthropic.test";
const MODEL = "claude-sonnet-5";

let tap: WireTap | null = null;
afterEach(() => {
  tap?.restore();
  tap = null;
});

function prompt(over: Partial<BenchPrompt> = {}): BenchPrompt {
  return {
    id: "t-basic",
    category: "factual",
    tools_expected: false,
    memory_expected: false,
    prompt: "What is 2 + 2?",
    ...over,
  };
}

// === 1. Parameter freezing ===

describe("parameter freezing — B sends exactly A's parameters", () => {
  it("copies every non-content key of A's observed round-1 body, and nothing else", () => {
    const a = {
      model: "m",
      max_tokens: 4096,
      temperature: 0.7,
      thinking: { type: "adaptive" },
      output_config: { effort: "high" },
      tools: [
        { name: "t", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
      ],
      system: [{ type: "text", text: "motebit system" }],
      messages: [{ role: "user", content: "hi" }],
      stream: true,
    };
    const frozen = freezeParams(a);
    expect(Object.keys(frozen).sort()).toEqual(
      Object.keys(a)
        .filter((k) => !CONTENT_KEYS.has(k))
        .sort(),
    );
    for (const k of Object.keys(frozen)) expect(frozen[k]).toEqual(a[k as keyof typeof a]);
    // Deep copy — mutating B's params never reaches A's record.
    (frozen["tools"] as Array<Record<string, unknown>>)[0]!["name"] = "mutated";
    expect(a.tools[0]!.name).toBe("t");
  });

  it("end to end: B's wire body carries A's wire params, a neutral system and the FULL history; B′ replays A verbatim", async () => {
    const fake = fakeAnthropic(() => ({ text: "Four." }));
    tap = installWireTap({ underlying: fake.fetchImpl });
    const history = [
      { role: "user" as const, content: "My name is Ada." },
      { role: "assistant" as const, content: "Hi Ada." },
    ];
    const p = prompt({ id: "t-freeze", history });
    const a = await runMotebitRoute(p, 0, {
      apiKey: "test-key",
      model: MODEL,
      baseUrl: FAKE_BASE,
      tap,
    });
    expect(a.error).toBeUndefined();
    expect(a.requests.length).toBeGreaterThanOrEqual(1);
    const aWire = a.requests[0]!;
    expect(aWire["model"]).toBe(MODEL);
    const frozen = freezeParams(aWire);
    expect(a.params).toEqual(frozen);

    const mark = fake.received.length;
    const b = await runDirectRoute({
      route: "B",
      prompt_id: p.id,
      repetition: 0,
      apiKey: "test-key",
      baseUrl: FAKE_BASE,
      body: buildRouteBRequest(frozen, history, p.prompt),
      params: frozen,
      toolResults: indexToolResults(a.requests),
      tap,
    });
    expect(b.error).toBeUndefined();
    const bWire = fake.received[mark]!;
    for (const [k, v] of Object.entries(aWire)) {
      if (CONTENT_KEYS.has(k)) continue;
      expect(bWire[k], `param ${k}`).toEqual(v);
    }
    expect(
      Object.keys(bWire)
        .filter((k) => !CONTENT_KEYS.has(k))
        .sort(),
    ).toEqual(Object.keys(frozen).sort());
    expect(bWire["system"]).toBe(NEUTRAL_SYSTEM_PROMPT);
    expect(bWire["messages"]).toEqual([...history, { role: "user", content: p.prompt }]);

    const bp = await runDirectRoute({
      route: "Bp",
      prompt_id: p.id,
      repetition: 0,
      apiKey: "test-key",
      baseUrl: FAKE_BASE,
      body: buildRouteBpRequest(aWire),
      params: frozen,
      toolResults: new Map(),
      tap,
    });
    expect(bp.error).toBeUndefined();
    expect(fake.received.at(-1)).toEqual({ ...aWire, stream: true });
    expect(b.answer).toBe("Four.");
    expect(b.usage.output_tokens).toBe(7);
  }, 60_000);
});

// === 2. Route A measurements ===

describe("route A — measured off the real runtime", () => {
  it("records rounds, tool calls and usage from the wire; B replays A's tool result for an identical call", async () => {
    const fake = fakeAnthropic((body) => {
      const msgs = body["messages"] as Array<Record<string, unknown>>;
      const last = msgs.at(-1)!;
      const sawResult =
        Array.isArray(last["content"]) &&
        (last["content"] as Array<Record<string, unknown>>).some(
          (b) => b["type"] === "tool_result",
        );
      return sawResult
        ? { text: "It is noon UTC." }
        : { toolUse: { id: "tu_1", name: "current_time", input: {} } };
    });
    tap = installWireTap({ underlying: fake.fetchImpl });
    const p = prompt({
      id: "t-tool",
      category: "tool",
      tools_expected: true,
      prompt: "What time is it?",
    });
    const a = await runMotebitRoute(p, 0, { apiKey: "k", model: MODEL, baseUrl: FAKE_BASE, tap });
    expect(a.error).toBeUndefined();
    expect(a.tool_calls.map((t) => t.name)).toContain("current_time");
    expect(a.model_rounds).toBeGreaterThanOrEqual(2);
    expect(a.usage.input_tokens).toBe(100 * a.model_rounds);
    // In-turn non-streaming passes are counted separately, never as rounds.
    expect(a.motebit.auxiliary_calls).toBeGreaterThanOrEqual(0);
    const offered = (a.params["tools"] as Array<Record<string, unknown>>).map((t) => t["name"]);
    expect(offered).toEqual(
      expect.arrayContaining(["current_time", "recall_memories", "recall_self"]),
    );

    const index = indexToolResults(a.requests);
    expect([...index.keys()]).toContain("current_time:{}");
    const b = await runDirectRoute({
      route: "B",
      prompt_id: p.id,
      repetition: 0,
      apiKey: "k",
      baseUrl: FAKE_BASE,
      body: buildRouteBRequest(a.params, [], p.prompt),
      params: a.params,
      toolResults: index,
      tap,
    });
    expect(b.tool_replay).toEqual({ replayed: 1, unavailable: 0 });
    expect(b.model_rounds).toBe(2);
    expect(b.answer).toBe("It is noon UTC.");
  }, 60_000);

  it("measures history retention on the committed long conversation; B always sends all of it", async () => {
    const long = loadPrompts().find((p) => p.id === "longctx-turn1-recall")!;
    const fake = fakeAnthropic(() => ({ text: "BLUEHERON." }));
    tap = installWireTap({ underlying: fake.fetchImpl });
    const a = await runMotebitRoute(long, 0, {
      apiKey: "k",
      model: MODEL,
      baseUrl: FAKE_BASE,
      tap,
    });
    expect(a.error).toBeUndefined();
    const m = a.motebit;
    expect(m.history_messages).toBe(long.history!.length);
    expect(m.history_retained).toBeLessThanOrEqual(m.history_messages);
    // Whatever the product's budget is, the measurement is coherent with it:
    // dropped history ⇔ the runtime's synthetic trim note.
    expect(m.trim_note_injected).toBe(m.history_retained < m.history_messages);
    const bBody = buildRouteBRequest(a.params, long.history!, long.prompt);
    expect((bBody["messages"] as unknown[]).length).toBe(long.history!.length + 1);
  }, 60_000);

  it("measureRetention counts the kept suffix and detects the trim note", () => {
    const history = [
      { role: "user" as const, content: "turn one" },
      { role: "assistant" as const, content: "reply one" },
      { role: "user" as const, content: "turn two" },
      { role: "assistant" as const, content: "reply two" },
    ];
    const body = {
      messages: [
        {
          role: "user",
          content:
            "[This conversation continues from earlier. Some messages have been trimmed for context.]",
        },
        { role: "user", content: "turn two" },
        { role: "assistant", content: "reply two" },
        { role: "user", content: [{ type: "text", text: "now" }] },
      ],
    };
    expect(measureRetention(history, body)).toEqual({
      retained: 2,
      tokensRetained: 5,
      trimNote: true,
    });
  });

  it("splitRounds keeps auxiliary calls out of the turn", () => {
    const ex = (system: string, messages: unknown[], stream = true) => ({
      url: "u",
      request_body: { system, messages, stream },
      status: 200,
      started_at: 0,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [],
      text: "",
    });
    const r1 = ex("S", [
      { role: "user", content: [{ type: "text", text: "q", cache_control: {} }] },
    ]);
    // Round 2's system differs: the runtime re-assembles it per iteration.
    const r2 = ex("S2", [
      { role: "user", content: "q" },
      { role: "assistant", content: "x" },
      { role: "user", content: "y" },
    ]);
    const aux = ex("S", [{ role: "user", content: "q" }], false); // non-streaming generate()
    const other = ex("CLASSIFY", [{ role: "user", content: "different" }]);
    const { rounds, auxiliary } = splitRounds([r1, aux, r2, other]);
    expect(rounds).toEqual([r1, r2]);
    expect(auxiliary).toEqual([aux, other]);
  });
});

// === 3. Blinding ===

describe("blinding — no route identity reaches the judge", () => {
  const answers = [
    {
      route: "A" as const,
      text: "Hi, I'm Motebit — your motebit says 4. <state>calm</state> [from:user_stated]",
    },
    { route: "B" as const, text: "As Claude, made by Anthropic, I can tell you it's 4." },
    { route: "Bp" as const, text: "Claude Sonnet 5 here: 4." },
    { route: "C" as const, text: "ChatGPT (GPT-5, by OpenAI): the answer is 4." },
  ];

  it("masks self-identification uniformly and drops runtime-only markup", () => {
    for (const a of answers) {
      const m = maskIdentity(a.text);
      expect(m).not.toMatch(/motebit|claude|anthropic|chat\s?gpt|openai|gpt-?5|<state>|\[from:/i);
    }
    expect(maskIdentity("I'm Motebit")).toBe(`I'm ${IDENTITY_MASK}`);
  });

  it("judge input carries no route id, label, map or marker; order is a seeded permutation", () => {
    const blinded = blind(answers, seededRng(hashSeed("p#0")));
    expect([...blinded.presentation_order].sort()).toEqual(["A", "B", "Bp", "C"]);
    expect(blind(answers, seededRng(hashSeed("p#0"))).presentation_order).toEqual(
      blinded.presentation_order,
    );
    const p = prompt({
      prompt: "What is 2+2? (ask motebit)",
      seed_memories: [{ content: "User likes Claude." }],
    });
    const msg = buildJudgeUserMessage(p, blinded);
    for (const label of Object.values(ROUTE_LABELS)) expect(msg).not.toContain(label);
    expect(msg).not.toMatch(
      /\broute\b|\bBp\b|B′|presentation_order|motebit|claude|anthropic|openai|chat\s?gpt/i,
    );
    expect(msg).toContain("=== Response 1 ===");
    expect(msg).toContain("=== Response 4 ===");
    // The rubric (system) is route-blind too.
    expect(loadRubric()).not.toMatch(/motebit|route|direct|vendor/i);
  });

  it("shuffling actually varies the order across prompts", () => {
    const orders = new Set(
      Array.from({ length: 20 }, (_, i) =>
        blind(answers, seededRng(hashSeed(`p${i}#0`))).presentation_order.join(),
      ),
    );
    expect(orders.size).toBeGreaterThan(3);
  });

  it("de-blinds the judge's reply back onto routes", () => {
    const order = ["Bp", "A", "B"] as const;
    const parsed = parseJudgeReply(
      `Here: {"scores":{"1":{"correctness":9,"completeness":8,"depth":7,"clarity":12},"2":{"correctness":5,"completeness":5,"depth":5,"clarity":5}},` +
        `"pairwise":[{"a":"1","b":"2","winner":"1"},{"a":"2","b":"3","winner":"tie"},{"a":"1","b":"1","winner":"1"}]}`,
      [...order],
    );
    expect(parsed.scores.Bp).toEqual({ correctness: 9, completeness: 8, depth: 7, clarity: 10 });
    expect(parsed.scores.A?.correctness).toBe(5);
    expect(parsed.scores.B).toBeUndefined();
    expect(parsed.pairwise).toEqual([
      { a: "Bp", b: "A", winner: "Bp" },
      { a: "A", b: "B", winner: "tie" },
    ]);
  });

  it("judgePrompt sends only the blinded message + rubric to the transport", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const { judgment } = await judgePrompt(
      prompt(),
      0,
      answers.slice(0, 2),
      "judge-x",
      async (body) => {
        sent.push(body);
        return {
          text: '{"scores":{"1":{"correctness":8,"completeness":8,"depth":8,"clarity":8},"2":{"correctness":6,"completeness":6,"depth":6,"clarity":6}},"pairwise":[{"a":"1","b":"2","winner":"1"}]}',
          usage: {
            input_tokens: 10,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      },
      "RUBRIC",
    );
    const wire = JSON.stringify(sent[0]);
    expect(wire).not.toMatch(/motebit|anthropic|claude|\broute\b|presentation_order/i);
    expect(sent[0]!["system"]).toBe("RUBRIC");
    expect(judgment.pairwise).toHaveLength(1);
    const winner = judgment.presentation_order[0];
    expect(judgment.pairwise[0]!.winner).toBe(winner);
  });
});

// === 4. Report math ===

function res(
  route: RouteResult["route"],
  ttft: number | null,
  total: number,
  out: number,
): RouteResult {
  return {
    route,
    prompt_id: "p",
    repetition: 0,
    answer: "",
    ttft_ms: ttft,
    total_ms: total,
    usage: {
      input_tokens: 0,
      output_tokens: out,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    model_rounds: 1,
    tool_calls: [],
    requests: [],
    params: {},
  };
}

describe("report math", () => {
  it("nearest-rank percentiles only report observed values", () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(median(xs)).toBe(50);
    expect(percentile(xs, 90)).toBe(90);
    expect(percentile([5], 90)).toBe(5);
    expect(percentile([], 50)).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
  });

  it("win rates count ties as half and are symmetric", () => {
    const j = (
      pairwise: Judgment["pairwise"],
      category: Judgment["category"] = "factual",
    ): Judgment => ({
      prompt_id: "p",
      category,
      repetition: 0,
      judge_model: "j",
      scores: {},
      pairwise,
      presentation_order: [],
    });
    const js = [
      j([{ a: "A", b: "B", winner: "A" }]),
      j([{ a: "B", b: "A", winner: "B" }]),
      j([{ a: "A", b: "B", winner: "tie" }]),
      j([{ a: "A", b: "B", winner: "A" }], "coding"),
    ];
    const ab = winRate(js, "A", "B");
    expect(ab).toMatchObject({ wins: 2, losses: 1, ties: 1, n: 4 });
    expect(ab.rate).toBeCloseTo(2.5 / 4);
    expect(winRate(js, "B", "A").rate).toBeCloseTo(1.5 / 4);
    expect(winRate([], "A", "B").rate).toBeNull();
  });

  it("latency, output ratio and the motebit tax come out of the run file", () => {
    const run: RunFile = {
      bench: "intelligence-parity",
      version: 1,
      started_at: "t",
      model: "m",
      routes: ["A", "B"],
      repetitions: 1,
      spend_usd: 0.5,
      runs: [
        {
          prompt_id: "p1",
          category: "factual",
          repetition: 0,
          results: { A: res("A", 900, 2000, 200), B: res("B", 600, 1500, 100) },
        },
        {
          prompt_id: "p2",
          category: "coding",
          repetition: 0,
          results: { A: res("A", 1100, 3000, 300), B: res("B", 700, 2500, 300) },
        },
        {
          prompt_id: "p3",
          category: "coding",
          repetition: 0,
          results: { A: { ...res("A", 50, 60, 1), error: "boom" }, B: res("B", 800, 2600, 100) },
        },
      ],
    };
    expect(latencyStats(run, "A")).toMatchObject({
      n: 2,
      ttft_median: 900,
      ttft_p90: 1100,
      total_median: 2000,
    });
    expect(latencyStats(run, "B")).toMatchObject({ n: 3, ttft_median: 700, total_median: 2500 });
    const ratio = outputLengthRatio(run);
    expect(ratio.aggregate).toBeCloseTo(500 / 400);
    expect(ratio.median_per_prompt).toBe(1);
    const rep = buildReport(run, null);
    expect(rep.ttft_tax_ms).toBe(200);
    expect(rep.total_tax_ms).toBe(-500);
    expect(rep.errors).toEqual([{ prompt_id: "p3", route: "A", error: "boom" }]);
    const md = renderMarkdown(rep);
    expect(md).toContain("## Motebit tax (A vs B)");
    expect(md).toContain("## Vendor product advantage (C vs B)");
    expect(md).toContain("## User gap (A vs C)");
    expect(md).toContain("+200 ms");
  });
});

// === 5. Spend guard ===

describe("spend guard", () => {
  it("prices list rates and dated snapshots, and refuses an unpriced model", () => {
    expect(
      costUsd("claude-sonnet-5", {
        input_tokens: 1_000_000,
        output_tokens: 100_000,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      }),
    ).toBeCloseTo(2 + 1);
    expect(
      costUsd("claude-opus-5-5", {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 1_000_000,
        cache_creation_input_tokens: 1_000_000,
      }),
    ).toBeCloseTo(0.2 + 5);
    expect(priceFor("claude-haiku-4-5-20251001")).toEqual(priceFor("claude-haiku-4-5"));
    expect(() => priceFor("gpt-imaginary")).toThrow(/No price/);
  });

  it("refuses a run whose estimate exceeds max_usd", () => {
    const prompts = loadPrompts();
    const est = estimateRun({
      prompts,
      routes: ["A", "B"],
      repetitions: 1,
      model: "claude-sonnet-5",
      judgeModel: "claude-opus-5-5",
    });
    expect(est.usd).toBeGreaterThan(0);
    expect(() => assertEstimateWithinBudget(est, est.usd + 0.01)).not.toThrow();
    expect(() => assertEstimateWithinBudget(est, est.usd / 2)).toThrow(/exceeds --max-usd/);
    const ten = estimateRun({
      prompts,
      routes: ["A", "B"],
      repetitions: 10,
      model: "claude-sonnet-5",
      judgeModel: null,
    });
    expect(ten.usd).toBeGreaterThan(est.usd);
  });

  it("the live meter stops a run before the next call once spent", async () => {
    const fake = fakeAnthropic(() => ({ text: "x", usage: { input_tokens: 400_000 } }));
    const meter = new SpendMeter(0.5); // one call at 400k input on sonnet-5 = $0.80
    expect(() => meter.check()).not.toThrow();
    const prev = globalThis.fetch;
    globalThis.fetch = fake.fetchImpl;
    try {
      const opts = parseArgs([
        "run",
        "--model=claude-sonnet-5",
        `--base-url=${FAKE_BASE}`,
        "--routes=A,B",
      ]);
      const prompts = selectPrompts(loadPrompts(), ["fact-tcp-handshake", "fact-unix-epoch"]);
      const run = await runRoutes(opts, prompts, "k", meter, () => {});
      // A ran once and crossed the limit; neither B nor the second prompt was sent.
      expect(run.runs).toHaveLength(1);
      expect(run.runs[0]!.results.B).toBeUndefined();
      expect(fake.received.filter((b) => b["stream"] === true)).toHaveLength(1);
      expect(run.spend_usd).toBeGreaterThanOrEqual(0.5);
      expect(() => meter.check()).toThrow(SpendLimitExceeded);
    } finally {
      globalThis.fetch = prev;
    }
  }, 60_000);
});

// === 6. Prompt set + CLI contract ===

describe("committed prompt set + CLI", () => {
  it("has ~25 tagged prompts covering every category, a 10+ turn conversation depending on turn 1, memory and tool prompts", () => {
    const prompts = loadPrompts();
    expect(prompts.length).toBeGreaterThanOrEqual(25);
    const cats = new Set(prompts.map((p) => p.category));
    for (const c of [
      "factual",
      "explanation",
      "coding",
      "architecture",
      "writing",
      "synthesis",
      "long-context",
      "memory",
      "tool",
    ]) {
      expect(cats.has(c as BenchPrompt["category"])).toBe(true);
    }
    const long = prompts.find((p) => p.id === "longctx-turn1-recall")!;
    expect(long.history!.length / 2).toBeGreaterThanOrEqual(10);
    expect(long.history![0]!.content).toContain("BLUEHERON");
    expect(long.reference_notes).toContain("BLUEHERON");
    expect(
      prompts.filter((p) => p.memory_expected).every((p) => (p.seed_memories ?? []).length > 0),
    ).toBe(true);
    expect(prompts.some((p) => p.tools_expected)).toBe(true);
  });

  it("refuses ambiguous or self-defeating options", () => {
    expect(() =>
      parseArgs(["run", "--model=claude-opus-5-5", "--judge-model=claude-opus-5-5"]),
    ).toThrow(/self-preference/);
    expect(() => parseArgs(["run", "--routes=B"])).toThrow(/must include A/);
    expect(() => parseArgs(["run", "--routes=A,C"])).toThrow(/Unknown live route/);
    expect(() => parseArgs(["run", "--max-usd=0"])).toThrow();
    expect(() => selectPrompts(loadPrompts(), ["no-such-prompt"])).toThrow(/names nothing/);
    expect(selectPrompts(loadPrompts(), ["coding"]).every((p) => p.category === "coding")).toBe(
      true,
    );
    expect(parseArgs([]).routes).toEqual(["A", "B"]);
  });
});
