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
  buildRouteBpfRequest,
  buildRouteBppRequest,
  freezeParams,
  NEUTRAL_SYSTEM_PROMPT,
} from "../bench/intelligence-parity/params.js";
import {
  contentKeys,
  indexToolResults,
  parseProvider,
  PROVIDER_KEY_ENV,
  replayHeaders,
  requireProviderKey,
} from "../bench/intelligence-parity/protocol.js";
import { runDirectRoute, runReplayRoute } from "../bench/intelligence-parity/route-direct.js";
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
  judgeWireBody,
  loadRubric,
  maskIdentity,
  parseJudgeReply,
  seededRng,
} from "../bench/intelligence-parity/judge.js";
import {
  bootstrapCI,
  buildReport,
  interactionCheck,
  latencyDelta,
  latencyStats,
  mean,
  median,
  outputLengthRatio,
  percentile,
  qualityContrast,
  renderMarkdown,
  winRate,
} from "../bench/intelligence-parity/report.js";
import {
  assertEstimateWithinBudget,
  costUsd,
  estimateRun,
  parsePrices,
  priceFor,
  SpendLimitExceeded,
  SpendMeter,
} from "../bench/intelligence-parity/spend.js";
import {
  DEFAULT_QUALITY_SUBSET,
  loadPrompts,
  parseArgs,
  runRoutes,
  selectPrompts,
  selectQuality,
} from "../bench/intelligence-parity/run.js";
import type {
  BenchPrompt,
  Judgment,
  RouteId,
  RouteResult,
  RunFile,
  Scores,
  Usage,
  WireExchange,
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
  /** The exact body string and headers each call carried — the byte-level record. */
  const raw: string[] = [];
  const headers: Array<Record<string, string>> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.endsWith("/v1/messages")) throw new Error(`unexpected fetch in test: ${url}`);
    if (typeof init?.body !== "string") throw new Error("fake expects a string body");
    raw.push(init.body);
    headers.push({ ...(init.headers as Record<string, string>) });
    const body = JSON.parse(init.body) as Record<string, unknown>;
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
  return { fetchImpl, received, raw, headers };
}

/** A fake OpenAI-compatible `/chat/completions` (SSE chunks, `[DONE]`). */
function fakeOpenAi(reply: (body: Record<string, unknown>) => string) {
  const received: Array<Record<string, unknown>> = [];
  const raw: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.endsWith("/chat/completions")) throw new Error(`unexpected fetch in test: ${url}`);
    raw.push(String(init?.body));
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    received.push(body);
    const text = reply(body);
    const usage = {
      prompt_tokens: 120,
      completion_tokens: 9,
      prompt_tokens_details: { cached_tokens: 20 },
    };
    if (body["stream"] !== true) {
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
          usage,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    const enc = new TextEncoder();
    const chunks = [
      { choices: [{ index: 0, delta: { role: "assistant", content: text.slice(0, 2) } }] },
      { choices: [{ index: 0, delta: { content: text.slice(2) } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      { choices: [], usage },
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(`data: ${JSON.stringify(c)}\n\n`));
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  return { fetchImpl, received, raw };
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

describe("parameter freezing — derived routes send exactly A's parameters", () => {
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
        .filter((k) => !contentKeys("anthropic").has(k))
        .sort(),
    );
    for (const k of Object.keys(frozen)) expect(frozen[k]).toEqual(a[k as keyof typeof a]);
    // Deep copy — mutating B's params never reaches A's record.
    (frozen["tools"] as Array<Record<string, unknown>>)[0]!["name"] = "mutated";
    expect(a.tools[0]!.name).toBe("t");
    // On the OpenAI wire `system` is not a top-level key, and stream_options IS a parameter.
    expect(
      Object.keys(
        freezeParams({ model: "g", messages: [], stream: true, stream_options: {} }, "openai"),
      ).sort(),
    ).toEqual(["model", "stream_options"]);
  });

  it("end to end: B′ replays A's captured request BYTE FOR BYTE; B″ = neutral system + A's trimmed messages + A's params; B = neutral + full history", async () => {
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
    // The bytes the adapter handed to fetch, as the FAKE saw them (independent of the tap).
    const aIndex = fake.received.indexOf(
      fake.received.find(
        (b) => b["stream"] === true && JSON.stringify(b) === JSON.stringify(aWire),
      )!,
    );
    const aRaw = fake.raw[aIndex]!;
    expect(a.captured[0]!.raw).toBe(aRaw);
    // Credentials never land in the record.
    expect(JSON.stringify(a.captured)).not.toContain("test-key");

    // --- B′: byte-for-byte replay ---
    let mark = fake.raw.length;
    const bp = await runReplayRoute({
      prompt_id: p.id,
      repetition: 0,
      apiKey: "test-key",
      captured: a.captured,
      aStoppedForTools: a.rounds_stopped_for_tools,
      params: frozen,
      tap,
    });
    expect(bp.error).toBeUndefined();
    expect(fake.raw.length - mark).toBe(a.captured.length);
    const bpRaw = fake.raw[mark]!;
    expect(bpRaw).toBe(aRaw);
    expect(Buffer.from(bpRaw, "utf8").equals(Buffer.from(aRaw, "utf8"))).toBe(true);
    // Headers too: A's own, with the redacted credential re-supplied.
    expect(fake.headers[mark]).toEqual(fake.headers[aIndex]);
    expect(bp.diverged_at_round).toBeUndefined();
    expect(bp.answer).toBe("Four.");

    // --- B″: neutral system prompt, A's TRIMMED messages, A's params + tools ---
    mark = fake.received.length;
    const bpp = await runDirectRoute({
      route: "Bpp",
      prompt_id: p.id,
      repetition: 0,
      apiKey: "test-key",
      baseUrl: FAKE_BASE,
      body: buildRouteBppRequest(aWire),
      params: frozen,
      toolResults: indexToolResults(a.requests),
      tap,
    });
    expect(bpp.error).toBeUndefined();
    const bppWire = fake.received[mark]!;
    expect(bppWire["system"]).toBe(NEUTRAL_SYSTEM_PROMPT);
    expect(bppWire["messages"]).toEqual(aWire["messages"]);
    for (const [k, v] of Object.entries(aWire)) {
      if (k === "system") continue;
      expect(bppWire[k], `B″ key ${k}`).toEqual(v);
    }
    expect(Object.keys(bppWire).sort()).toEqual(Object.keys(aWire).sort());

    // --- B: neutral system, FULL untrimmed history, A's params ---
    mark = fake.received.length;
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
      if (contentKeys("anthropic").has(k)) continue;
      expect(bWire[k], `param ${k}`).toEqual(v);
    }
    expect(
      Object.keys(bWire)
        .filter((k) => !contentKeys("anthropic").has(k))
        .sort(),
    ).toEqual(Object.keys(frozen).sort());
    expect(bWire["system"]).toBe(NEUTRAL_SYSTEM_PROMPT);
    expect(bWire["messages"]).toEqual([...history, { role: "user", content: p.prompt }]);
    expect(b.answer).toBe("Four.");
    expect(b.usage.output_tokens).toBe(7);
  }, 60_000);

  it("B″ keeps A's trimmed messages (trim note included) and B′ᶠ restores the full history under A's system prompt", () => {
    const history = [
      { role: "user" as const, content: "turn one" },
      { role: "assistant" as const, content: "reply one" },
      { role: "user" as const, content: "turn two" },
      { role: "assistant" as const, content: "reply two" },
    ];
    const turn = {
      role: "user",
      content: [{ type: "text", text: "now", cache_control: { type: "ephemeral" } }],
    };
    const aWire = {
      model: "m",
      max_tokens: 100,
      tools: [{ name: "t" }],
      system: [{ type: "text", text: "MOTEBIT SYSTEM" }],
      messages: [
        { role: "user", content: "[This conversation continues from earlier.]" },
        { role: "user", content: "turn two" },
        { role: "assistant", content: "reply two" },
        turn,
      ],
      stream: true,
    };
    const bpp = buildRouteBppRequest(aWire);
    expect(bpp["system"]).toBe(NEUTRAL_SYSTEM_PROMPT);
    expect(bpp["messages"]).toEqual(aWire.messages);
    expect(bpp["tools"]).toEqual(aWire.tools);
    const bpf = buildRouteBpfRequest(aWire, history);
    expect(bpf["system"]).toEqual(aWire.system);
    expect(bpf["messages"]).toEqual([...history, turn]);
    expect(bpf["max_tokens"]).toBe(100);
    // A is never mutated by derivation.
    expect(aWire.system[0]!.text).toBe("MOTEBIT SYSTEM");

    // OpenAI wire: motebit's system prompt is its system-ROLE messages (static head + per-turn context).
    const oWire = {
      model: "g",
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: "STATIC DOCTRINE" },
        { role: "user", content: "turn two" },
        { role: "assistant", content: "reply two" },
        { role: "system", content: "DYNAMIC CONTEXT" },
        { role: "user", content: "now" },
      ],
      stream: true,
    };
    expect(buildRouteBppRequest(oWire, "openai")["messages"]).toEqual([
      { role: "system", content: NEUTRAL_SYSTEM_PROMPT },
      { role: "user", content: "turn two" },
      { role: "assistant", content: "reply two" },
      { role: "user", content: "now" },
    ]);
    expect(buildRouteBpfRequest(oWire, history, "openai")["messages"]).toEqual([
      { role: "system", content: "STATIC DOCTRINE" },
      ...history,
      { role: "system", content: "DYNAMIC CONTEXT" },
      { role: "user", content: "now" },
    ]);
    expect(buildRouteBRequest({ model: "g" }, history, "now", "openai")["messages"]).toEqual([
      { role: "system", content: NEUTRAL_SYSTEM_PROMPT },
      ...history,
      { role: "user", content: "now" },
    ]);
  });

  it("replay re-supplies only the redacted credential", () => {
    expect(
      replayHeaders(
        { "x-api-key": "[redacted]", "anthropic-version": "2023-06-01", "anthropic-beta": "x" },
        "K",
      ),
    ).toEqual({ "x-api-key": "K", "anthropic-version": "2023-06-01", "anthropic-beta": "x" });
    expect(replayHeaders({ Authorization: "[redacted]" }, "K")).toEqual({
      Authorization: "Bearer K",
    });
  });

  it("openai provider end to end: A runs OpenAIProvider through the same tap; B′ replays its bytes; B″ strips motebit's system messages", async () => {
    const fake = fakeOpenAi(() => "Four, plainly.");
    tap = installWireTap({ underlying: fake.fetchImpl });
    const p = prompt({ id: "t-openai" });
    const a = await runMotebitRoute(p, 0, {
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-5.4-mini",
      baseUrl: "https://fake-openai.test/v1",
      tap,
    });
    expect(a.error).toBeUndefined();
    expect(a.protocol).toBe("openai");
    expect(a.captured[0]!.url).toBe("https://fake-openai.test/v1/chat/completions");
    expect(a.answer).toContain("Four");
    // prompt_tokens includes cached tokens; the tap splits them so pricing is not double-counted.
    expect(a.usage).toMatchObject({
      input_tokens: 100,
      cache_read_input_tokens: 20,
      output_tokens: 9,
    });
    const round1 = a.requests[0]!;
    const sys = (round1["messages"] as Array<Record<string, unknown>>).filter(
      (m) => m["role"] === "system",
    );
    expect(sys.length).toBeGreaterThanOrEqual(1);
    expect(a.motebit.system_prompt_chars).toBeGreaterThan(0);

    const mark = fake.raw.length;
    const bp = await runReplayRoute({
      prompt_id: p.id,
      repetition: 0,
      apiKey: "sk-test",
      captured: a.captured,
      aStoppedForTools: a.rounds_stopped_for_tools,
      params: a.params,
      tap,
    });
    expect(bp.error).toBeUndefined();
    expect(fake.raw[mark]).toBe(a.captured[0]!.raw);

    const bpp = await runDirectRoute({
      route: "Bpp",
      protocol: "openai",
      prompt_id: p.id,
      repetition: 0,
      apiKey: "sk-test",
      baseUrl: "https://fake-openai.test/v1",
      body: buildRouteBppRequest(round1, "openai"),
      params: a.params,
      toolResults: new Map(),
      tap,
    });
    expect(bpp.error).toBeUndefined();
    const sent = fake.received.at(-1)!;
    const msgs = sent["messages"] as Array<Record<string, unknown>>;
    expect(msgs[0]).toEqual({ role: "system", content: NEUTRAL_SYSTEM_PROMPT });
    expect(msgs.filter((m) => m["role"] === "system")).toHaveLength(1);
    expect(msgs.slice(1)).toEqual(
      (round1["messages"] as Array<Record<string, unknown>>).filter((m) => m["role"] !== "system"),
    );
    for (const k of Object.keys(a.params)) expect(sent[k], `param ${k}`).toEqual(round1[k]);
    expect(bpp.answer).toBe("Four, plainly.");
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

    // B′ replays EVERY one of A's rounds, byte for byte — round 2 carries A's
    // own tool result, so no tool is re-run and no body is rebuilt.
    expect(a.rounds_stopped_for_tools).toEqual([true, false]);
    const mark = fake.raw.length;
    const bp = await runReplayRoute({
      prompt_id: p.id,
      repetition: 0,
      apiKey: "k",
      captured: a.captured,
      aStoppedForTools: a.rounds_stopped_for_tools,
      params: a.params,
      tap,
    });
    expect(fake.raw.slice(mark)).toEqual(a.captured.map((c) => c.raw));
    expect(bp.model_rounds).toBe(2);
    expect(bp.diverged_at_round).toBeUndefined();
    expect(bp.answer).toBe("It is noon UTC.");
  }, 60_000);

  it("B′ stops and records divergence when the replayed model leaves A's trajectory", async () => {
    let replaying = false;
    const fake = fakeAnthropic((body) => {
      const last = (body["messages"] as Array<Record<string, unknown>>).at(-1)!;
      const sawResult =
        Array.isArray(last["content"]) &&
        (last["content"] as Array<Record<string, unknown>>).some(
          (b) => b["type"] === "tool_result",
        );
      if (replaying) return { text: "I'd guess noon." }; // answers without the tool A used
      return sawResult
        ? { text: "It is noon UTC." }
        : { toolUse: { id: "tu_1", name: "current_time", input: {} } };
    });
    tap = installWireTap({ underlying: fake.fetchImpl });
    const p = prompt({ id: "t-diverge", category: "tool", tools_expected: true, prompt: "Time?" });
    const a = await runMotebitRoute(p, 0, { apiKey: "k", model: MODEL, baseUrl: FAKE_BASE, tap });
    expect(a.rounds_stopped_for_tools[0]).toBe(true);
    replaying = true;
    const mark = fake.raw.length;
    const bp = await runReplayRoute({
      prompt_id: p.id,
      repetition: 0,
      apiKey: "k",
      captured: a.captured,
      aStoppedForTools: a.rounds_stopped_for_tools,
      params: a.params,
      tap,
    });
    expect(bp.diverged_at_round).toBe(1);
    expect(fake.raw.length - mark).toBe(1);
    expect(fake.raw[mark]).toBe(a.captured[0]!.raw);
    expect(bp.answer).toBe("I'd guess noon.");
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
    const ex = (system: string, messages: unknown[], stream = true): WireExchange => ({
      url: "u",
      protocol: "anthropic",
      request_raw: "",
      request_headers: {},
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
    const sent: Array<Parameters<Parameters<typeof judgePrompt>[4]>[0]> = [];
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

// === 4. Report math + repetition statistics ===

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

const sc = (v: number): Scores => ({ correctness: v, completeness: v, depth: v, clarity: v });

function judgment(
  prompt_id: string,
  repetition: number,
  scores: Partial<Record<RouteId, number>>,
  pairwise: Judgment["pairwise"] = [],
): Judgment {
  return {
    prompt_id,
    category: "factual",
    repetition,
    judge_model: "j",
    scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, sc(v!)])),
    pairwise,
    presentation_order: [],
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
    const js = [
      judgment("p", 0, {}, [{ a: "A", b: "Bp", winner: "A" }]),
      judgment("p", 1, {}, [{ a: "Bp", b: "A", winner: "Bp" }]),
      judgment("p", 2, {}, [{ a: "A", b: "Bp", winner: "tie" }]),
      judgment("q", 0, {}, [{ a: "A", b: "Bp", winner: "A" }]),
    ];
    const ab = winRate(js, "A", "Bp");
    expect(ab).toMatchObject({ wins: 2, losses: 1, ties: 1, n: 4 });
    expect(ab.rate).toBeCloseTo(2.5 / 4);
    expect(winRate(js, "Bp", "A").rate).toBeCloseTo(1.5 / 4);
    expect(winRate([], "A", "B").rate).toBeNull();
  });

  it("latency uses every prompt; A ↔ B′ is a paired per-sample delta", () => {
    const run: RunFile = {
      bench: "intelligence-parity",
      version: 2,
      started_at: "t",
      provider: "anthropic",
      model: "m",
      routes: ["A", "B", "Bp", "Bpp"],
      repetitions: 1,
      quality_subset: [],
      spend_usd: 0.5,
      runs: [
        {
          prompt_id: "p1",
          category: "factual",
          repetition: 0,
          quality: false,
          results: {
            A: res("A", 900, 2000, 200),
            Bp: res("Bp", 600, 1500, 100),
            Bpp: res("Bpp", 500, 1400, 50),
            B: res("B", 600, 1500, 100),
          },
        },
        {
          prompt_id: "p2",
          category: "coding",
          repetition: 0,
          quality: false,
          results: {
            A: res("A", 1100, 3000, 300),
            Bp: res("Bp", 700, 2500, 300),
            Bpp: res("Bpp", 700, 2500, 150),
            B: res("B", 700, 2500, 300),
          },
        },
        {
          prompt_id: "p3",
          category: "coding",
          repetition: 0,
          quality: false,
          results: { A: { ...res("A", 50, 60, 1), error: "boom" }, Bp: res("Bp", 800, 2600, 100) },
        },
      ],
    };
    expect(latencyStats(run, "A")).toMatchObject({
      n: 2,
      ttft_median: 900,
      ttft_p90: 1100,
      total_median: 2000,
    });
    expect(latencyStats(run, "Bp")).toMatchObject({ n: 3, ttft_median: 700, total_median: 2500 });
    const d = latencyDelta(run, "A", "Bp");
    // Per-sample deltas: ttft 300, 400; total 500, 500 (the errored sample is excluded).
    expect(d.ttft.median.estimate).toBe(300);
    expect(d.ttft.p90).toBe(400);
    expect(d.total.median).toMatchObject({ estimate: 500, lo: 500, hi: 500, n: 2, clusters: 2 });
    const ratio = outputLengthRatio(run, "Bp", "Bpp");
    expect(ratio.aggregate).toBeCloseTo(400 / 200);
    expect(ratio.median_per_sample).toBe(2);
    const rep = buildReport(run, null);
    expect(rep.sections.map((x) => [x.key, x.x, x.y])).toEqual([
      ["runtime", "A", "Bp"],
      ["system_prompt", "Bp", "Bpp"],
      ["trimming", "Bpp", "B"],
      ["user_gap", "A", "C"],
    ]);
    expect(rep.errors).toEqual([{ prompt_id: "p3", repetition: 0, route: "A", error: "boom" }]);
    const md = renderMarkdown(rep);
    expect(md).toContain("## Runtime / pipeline effect (A ↔ B′)");
    expect(md).toContain("## System-prompt effect (B′ ↔ B″)");
    expect(md).toContain("## Context-trimming effect (B″ ↔ B)");
    expect(md).toContain("## User gap (A ↔ C)");
    expect(md).toContain("+300 ms");
    // No 2×2 ⇒ no attribution, and the report says so.
    expect(md).toContain("_Not tested_");
    expect(md).toMatch(/must not be summed/);
    expect(md).not.toMatch(/share of A − B/);
  });
});

describe("repetition statistics", () => {
  it("bootstrapCI resamples clusters, is seeded, and collapses on constant data", () => {
    const constant = bootstrapCI([[2, 2], [2]], mean, 1);
    expect(constant).toEqual({ estimate: 2, lo: 2, hi: 2, n: 3, clusters: 2 });
    const clusters = [[1, 2, 3], [4, 5], [9], [0, 1]];
    const x = bootstrapCI(clusters, mean, 42);
    const y = bootstrapCI(clusters, mean, 42);
    expect(x).toEqual(y);
    expect(x.estimate).toBeCloseTo(25 / 8);
    expect(x.lo!).toBeLessThanOrEqual(x.estimate!);
    expect(x.hi!).toBeGreaterThanOrEqual(x.estimate!);
    // Bounds can only be values a cluster-resample can produce: within [min cluster mean, max cluster mean].
    expect(x.lo!).toBeGreaterThanOrEqual(0.5);
    expect(x.hi!).toBeLessThanOrEqual(9);
    expect(bootstrapCI([], mean, 1)).toEqual({
      estimate: null,
      lo: null,
      hi: null,
      n: 0,
      clusters: 0,
    });
  });

  it("qualityContrast reports the distribution over samples, not one verdict", () => {
    // 2 prompts × 3 samples. A beats B′ by 1 point on p, ties on q.
    const js = [
      judgment("p", 0, { A: 8, Bp: 7 }, [{ a: "A", b: "Bp", winner: "A" }]),
      judgment("p", 1, { A: 9, Bp: 8 }, [{ a: "Bp", b: "A", winner: "A" }]),
      judgment("p", 2, { A: 7, Bp: 6 }, [{ a: "A", b: "Bp", winner: "tie" }]),
      judgment("q", 0, { A: 5, Bp: 5 }, [{ a: "A", b: "Bp", winner: "tie" }]),
      judgment("q", 1, { A: 6, Bp: 6 }, [{ a: "A", b: "Bp", winner: "Bp" }]),
      judgment("q", 2, { A: 4, Bp: 4 }, [{ a: "A", b: "Bp", winner: "tie" }]),
    ];
    const q = qualityContrast(js, "A", "Bp");
    expect(q.diff.n).toBe(6);
    expect(q.diff.clusters).toBe(2);
    expect(q.diff.estimate).toBeCloseTo(0.5);
    expect(q.mean_x).toBeCloseTo(39 / 6);
    expect(q.mean_y).toBeCloseTo(36 / 6);
    expect([q.diff_p10, q.diff_median, q.diff_p90]).toEqual([0, 0, 1]);
    // With two clusters, a resample is (p,p), (p,q) or (q,q): mean diff ∈ {1, 0.5, 0}.
    expect(q.diff.lo).toBe(0);
    expect(q.diff.hi).toBe(1);
    expect(q.win).toMatchObject({ wins: 2, losses: 1, ties: 3, n: 6 });
    expect(q.win_rate.estimate).toBeCloseTo(3.5 / 6);
    expect(q.per_prompt).toEqual([
      { prompt_id: "p", samples: 3, mean_x: 8, mean_y: 7, wins: 2, losses: 0, ties: 1 },
      { prompt_id: "q", samples: 3, mean_x: 5, mean_y: 5, wins: 0, losses: 1, ties: 2 },
    ]);
    // Symmetric.
    expect(qualityContrast(js, "Bp", "A").diff.estimate).toBeCloseTo(-0.5);
  });

  it("interaction check: additive 2×2 licenses attribution; a real interaction forbids it", () => {
    // Additive: system effect +1 regardless of trimming; trimming effect −0.5; runtime 0.
    const additive: Judgment[] = [];
    const interacting: Judgment[] = [];
    for (const [i, pid] of ["p", "q", "r"].entries()) {
      for (let rep = 0; rep < 3; rep++) {
        const base = 5 + i + (rep % 2) * 0.25;
        additive.push(
          judgment(pid, rep, {
            A: base + 0.5,
            Bp: base + 0.5,
            Bpp: base - 0.5,
            Bpf: base + 1,
            B: base,
          }),
        );
        // System prompt helps only on the trimmed conversation.
        interacting.push(
          judgment(pid, rep, { A: base + 2, Bp: base + 2, Bpp: base, Bpf: base, B: base }),
        );
      }
    }
    const ok = interactionCheck(additive);
    expect(ok.tested).toBe(true);
    expect(ok.interaction.estimate).toBeCloseTo(0);
    expect(ok.separable).toBe(true);
    expect(ok.attribution).not.toBeNull();
    // Gap A − B = +0.5 = runtime 0 + system +1 + trimming −0.5.
    expect(ok.attribution!.gap.estimate).toBeCloseTo(0.5);
    expect(ok.attribution!.runtime).toBeCloseTo(0);
    expect(ok.attribution!.system_prompt).toBeCloseTo(2);
    expect(ok.attribution!.trimming).toBeCloseTo(-1);

    const bad = interactionCheck(interacting);
    expect(bad.interaction.estimate).toBeCloseTo(2);
    expect(bad.separable).toBe(false);
    expect(bad.attribution).toBeNull();

    const none = interactionCheck([judgment("p", 0, { A: 5, Bp: 5, Bpp: 4, B: 4 })]);
    expect(none.tested).toBe(false);
    expect(none.separable).toBe(false);

    const runFile: RunFile = {
      bench: "intelligence-parity",
      version: 2,
      started_at: "t",
      provider: "anthropic",
      model: "m",
      routes: ["A", "B", "Bp", "Bpp", "Bpf"],
      repetitions: 3,
      quality_subset: ["p", "q", "r"],
      spend_usd: 0,
      runs: [],
    };
    const judged = (judgments: Judgment[]) => ({
      bench: "intelligence-parity/judgments" as const,
      version: 2 as const,
      judge_provider: "anthropic" as const,
      judge_model: "j",
      judgments,
      spend_usd: 0,
    });
    expect(renderMarkdown(buildReport(runFile, judged(additive)))).toMatch(/share of A − B/);
    const mdBad = renderMarkdown(buildReport(runFile, judged(interacting)));
    expect(mdBad).toMatch(/depends on whether the conversation was trimmed/);
    expect(mdBad).toMatch(/no additive attribution/);
    expect(mdBad).not.toMatch(/share of A − B/);
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
    expect(() => priceFor("gpt-imaginary")).toThrow(/No price[\s\S]*--prices=gpt-imaginary=/);
  });

  it("operator-supplied --prices price a non-tabled model and fail closed when malformed", () => {
    const prices = parsePrices("gpt-5.4-mini=0.5:4:0.05, gemini-2.5-flash=0.3:2.5");
    expect(prices["gpt-5.4-mini"]).toEqual({ input: 0.5, output: 4, cache_read: 0.05 });
    // cache_read defaults to the input price — the pessimistic choice.
    expect(prices["gemini-2.5-flash"]).toEqual({ input: 0.3, output: 2.5, cache_read: 0.3 });
    expect(
      costUsd(
        "gpt-5.4-mini",
        {
          input_tokens: 1_000_000,
          output_tokens: 1_000_000,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        prices,
      ),
    ).toBeCloseTo(4.5);
    expect(() => parsePrices("gpt-x=1")).toThrow(/malformed/);
    expect(() => parsePrices("=1:2")).toThrow(/malformed/);
    expect(() => parsePrices("gpt-x=a:b")).toThrow(/malformed/);
    expect(() => parsePrices("gpt-x=-1:2")).toThrow(/malformed/);
  });

  it("the estimate prices EVERY route × repetitions + the judge before any call", () => {
    const prompts = loadPrompts();
    const qualityIds = new Set(DEFAULT_QUALITY_SUBSET);
    const base = {
      prompts,
      repetitions: 3,
      qualityIds,
      model: "claude-sonnet-5",
      judgeModel: "claude-opus-5-5",
    };
    const full = estimateRun({ ...base, routes: ["A", "B", "Bp", "Bpp", "Bpf"] });
    expect(Object.keys(full.by_route).sort()).toEqual(["A", "B", "Bp", "Bpf", "Bpp", "judge"]);
    for (const v of Object.values(full.by_route)) expect(v).toBeGreaterThan(0);
    expect(Object.values(full.by_route).reduce((a, b) => a + b, 0)).toBeCloseTo(full.usd);
    // Each route adds cost: dropping any one lowers the route spend by exactly its share
    // (and the judge's, which then reads one answer fewer).
    for (const r of ["B", "Bp", "Bpp", "Bpf"] as const) {
      const without = estimateRun({
        ...base,
        routes: (["A", "B", "Bp", "Bpp", "Bpf"] as RouteId[]).filter((x) => x !== r),
      });
      expect(without.usd - without.by_route.judge!).toBeCloseTo(
        full.usd - full.by_route.judge! - full.by_route[r]!,
      );
      expect(without.by_route.judge!).toBeLessThan(full.by_route.judge!);
    }
    // Repetitions multiply the quality subset only; latency prompts run once.
    const one = estimateRun({ ...base, routes: ["A"], repetitions: 1, judgeModel: null });
    const three = estimateRun({ ...base, routes: ["A"], judgeModel: null });
    const perPromptA = (ids: Set<string>) =>
      estimateRun({
        ...base,
        prompts: prompts.filter((p) => ids.has(p.id)),
        routes: ["A"],
        repetitions: 1,
        judgeModel: null,
      }).usd;
    expect(three.usd - one.usd).toBeCloseTo(2 * perPromptA(qualityIds));
    // B′ᶠ runs on the quality subset only.
    const bpfOnly = estimateRun({ ...base, routes: ["A", "Bpf"], judgeModel: null });
    const bpfQualityOnly = estimateRun({
      ...base,
      prompts: prompts.filter((p) => qualityIds.has(p.id)),
      routes: ["A", "Bpf"],
      judgeModel: null,
    });
    expect(bpfOnly.by_route.Bpf).toBeCloseTo(bpfQualityOnly.by_route.Bpf!);
    // The judge is priced per judged sample, and sees route C when supplied.
    const withC = estimateRun({ ...base, routes: ["A", "B", "Bp", "Bpp", "Bpf"], routeC: true });
    expect(withC.by_route.judge!).toBeGreaterThan(full.by_route.judge!);
    expect(() => assertEstimateWithinBudget(full, full.usd + 0.01)).not.toThrow();
    expect(() => assertEstimateWithinBudget(full, full.usd / 2)).toThrow(/exceeds --max-usd/);
    // Unpriced judge is refused at estimate time, not after spending.
    expect(() => estimateRun({ ...base, routes: ["A"], judgeModel: "gpt-imaginary" })).toThrow(
      /No price/,
    );
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
        "--routes=A,B,Bp,Bpp",
      ]);
      const prompts = selectPrompts(loadPrompts(), ["fact-tcp-handshake", "fact-unix-epoch"]);
      const run = await runRoutes(opts, prompts, "k", meter, () => {});
      // A ran once and crossed the limit; no direct route, repetition or second prompt was sent.
      expect(run.runs).toHaveLength(1);
      expect(run.runs[0]!.quality).toBe(true);
      expect(Object.keys(run.runs[0]!.results)).toEqual(["A"]);
      expect(fake.received.filter((b) => b["stream"] === true)).toHaveLength(1);
      expect(run.spend_usd).toBeGreaterThanOrEqual(0.5);
      expect(() => meter.check()).toThrow(SpendLimitExceeded);
    } finally {
      globalThis.fetch = prev;
    }
  }, 60_000);

  it("a full fake run: latency prompts once, quality prompts × repetitions, every route on each", async () => {
    const fake = fakeAnthropic(() => ({ text: "ok" }));
    const prev = globalThis.fetch;
    globalThis.fetch = fake.fetchImpl;
    try {
      const opts = parseArgs([
        "run",
        "--model=claude-sonnet-5",
        `--base-url=${FAKE_BASE}`,
        "--routes=A,B,Bp,Bpp,Bpf",
        "--repetitions=2",
        "--quality-subset=fact-tcp-handshake",
      ]);
      const prompts = selectPrompts(loadPrompts(), ["fact-tcp-handshake", "fact-unix-epoch"]);
      const run = await runRoutes(opts, prompts, "k", new SpendMeter(100), () => {});
      expect(run.quality_subset).toEqual(["fact-tcp-handshake"]);
      expect(
        run.runs.map((r) => [
          r.prompt_id,
          r.repetition,
          r.quality,
          Object.keys(r.results).sort().join(),
        ]),
      ).toEqual([
        ["fact-tcp-handshake", 0, true, "A,B,Bp,Bpf,Bpp"],
        ["fact-tcp-handshake", 1, true, "A,B,Bp,Bpf,Bpp"],
        ["fact-unix-epoch", 0, false, "A,B,Bp,Bpp"],
      ]);
      for (const r of run.runs) {
        const a = r.results.A as import("../bench/intelligence-parity/types.js").RouteAResult;
        expect(r.results.Bp!.requests[0]).toEqual(a.requests[0]);
      }
    } finally {
      globalThis.fetch = prev;
    }
  }, 120_000);
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
    // The designated quality subset is 6 real prompts.
    expect(DEFAULT_QUALITY_SUBSET).toHaveLength(6);
    for (const id of DEFAULT_QUALITY_SUBSET) expect(prompts.some((p) => p.id === id)).toBe(true);
  });

  it("refuses ambiguous or self-defeating options", () => {
    expect(() =>
      parseArgs(["run", "--model=claude-opus-5-5", "--judge-model=claude-opus-5-5"]),
    ).toThrow(/self-preference/);
    expect(() => parseArgs(["run", "--routes=B"])).toThrow(/must include A/);
    expect(() => parseArgs(["run", "--routes=Bpp"])).toThrow(/must include A/);
    expect(() => parseArgs(["run", "--routes=A,C"])).toThrow(/Unknown live route/);
    expect(() => parseArgs(["run", "--max-usd=0"])).toThrow();
    expect(() => parseArgs(["run", "--repetitions=0"])).toThrow(/positive integer/);
    expect(() => selectPrompts(loadPrompts(), ["no-such-prompt"])).toThrow(/names nothing/);
    expect(selectPrompts(loadPrompts(), ["coding"]).every((p) => p.category === "coding")).toBe(
      true,
    );
    const d = parseArgs([]);
    expect(d.routes).toEqual(["A", "B", "Bp", "Bpp"]);
    expect(d.repetitions).toBe(3);
    expect(d.maxUsd).toBe(5);
    expect(d.provider).toBe("anthropic");
    expect(d.judgeProvider).toBe("anthropic");
    expect(d.judgeModel).toBe("claude-opus-5-5");
    // Quality subset: default intersects the selection; a named-but-unselected prompt is an error.
    const sel = selectPrompts(loadPrompts(), ["factual"]);
    expect(selectQuality(sel, null)).toEqual(["fact-tcp-handshake"]);
    expect(selectQuality(sel, "all")).toEqual(sel.map((p) => p.id));
    expect(() => selectQuality(sel, ["code-lru-cache"])).toThrow(/not selected/);
    expect(selectQuality(loadPrompts(), null)).toEqual(
      [...DEFAULT_QUALITY_SUBSET].sort(
        (a, b) =>
          loadPrompts().findIndex((p) => p.id === a) - loadPrompts().findIndex((p) => p.id === b),
      ),
    );
  });

  it("provider and judge provider are validated inputs, each reading its own secret", () => {
    for (const p of ["anthropic", "openai", "google", "groq", "deepseek"] as const) {
      expect(parseProvider(p, "--provider")).toBe(p);
      const opts = parseArgs([`--provider=${p}`, "--judge-model=some-judge"]);
      expect(opts.provider).toBe(p);
      expect(opts.model.length).toBeGreaterThan(0);
      // Its own secret: present → returned; absent → a hard error naming exactly that secret.
      expect(requireProviderKey(p, { [PROVIDER_KEY_ENV[p]]: "sekrit" })).toBe("sekrit");
      expect(() =>
        requireProviderKey(p, { ANTHROPIC_API_KEY: p === "anthropic" ? "" : "x" }),
      ).toThrow(new RegExp(`${PROVIDER_KEY_ENV[p]} is not set`));
    }
    expect(PROVIDER_KEY_ENV).toEqual({
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      google: "GOOGLE_API_KEY",
      groq: "GROQ_API_KEY",
      deepseek: "DEEPSEEK_API_KEY",
    });
    expect(parseProvider("", "--provider")).toBe("anthropic");
    expect(() => parseArgs(["--provider=mistral"])).toThrow(/Unknown --provider "mistral"/);
    expect(() => parseArgs(["--judge-provider=ollama"])).toThrow(/Unknown --judge-provider/);
    const o = parseArgs([
      "--provider=openai",
      "--model=gpt-5.4-mini",
      "--judge-provider=deepseek",
      "--judge-model=deepseek-chat",
    ]);
    expect(o.baseUrl).toBe("https://api.openai.com/v1");
    expect(o.judgeBaseUrl).toBe("https://api.deepseek.com");
    expect(() => requireProviderKey("deepseek", {}, "the judge")).toThrow(
      /DEEPSEEK_API_KEY is not set.*the judge/,
    );
    // The judge request is mapped onto the judge provider's own wire.
    const req = {
      model: "gpt-5.4",
      max_tokens: 100,
      system: "R",
      messages: [{ role: "user" as const, content: "u" }],
    };
    expect(judgeWireBody("openai", req)).toEqual({
      model: "gpt-5.4",
      messages: [
        { role: "system", content: "R" },
        { role: "user", content: "u" },
      ],
      max_completion_tokens: 100,
      stream: false,
    });
    expect(judgeWireBody("anthropic", req)).toEqual(req);
  });
});
