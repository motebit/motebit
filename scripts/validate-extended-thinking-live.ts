/**
 * LIVE validation of Anthropic extended thinking + tool-use signature
 * preservation — the one thing unit tests cannot prove.
 *
 * Makes TWO real (billed, ~$0.05 total) calls to api.anthropic.com:
 *   1. Enable thinking + a tool, with a prompt that triggers the tool.
 *   2. Continue the tool call — reconstructing the assistant turn EXACTLY as
 *      motebit's buildMessages does (thinking block FIRST, with its signature,
 *      then tool_use) + a tool_result. If Anthropic returns 200, preservation
 *      works. If 400, it prints the exact rejection.
 *
 * Run:  ANTHROPIC_API_KEY=sk-ant-... npx tsx <this file>
 *       (optional VALIDATE_MODEL=claude-... , VALIDATE_BUDGET=2000)
 */

const KEY = process.env.ANTHROPIC_API_KEY;
if (!KEY) {
  console.error("✗ Set ANTHROPIC_API_KEY (a live, billed key) to run this validation.");
  process.exit(1);
}
const MODEL = process.env.VALIDATE_MODEL ?? "claude-sonnet-4-5-20250929";
const BUDGET = Number(process.env.VALIDATE_BUDGET ?? "2000");

interface Block {
  type: string;
  thinking?: string;
  signature?: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
}

async function call(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": KEY!,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = text;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep raw */
  }
  return { status: res.status, json };
}

const tool = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  input_schema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
};

const userMsg = { role: "user", content: "What's the weather in Paris right now? Use the tool." };

async function main() {
  console.log(`Model: ${MODEL}  |  thinking budget: ${BUDGET} tokens\n`);

  // ── Turn 1: thinking + tool call ─────────────────────────────────────────
  const r1 = await call({
    model: MODEL,
    max_tokens: BUDGET + 2048,
    thinking: { type: "enabled", budget_tokens: BUDGET },
    tools: [tool],
    messages: [userMsg],
  });
  console.log(`Turn 1 (thinking + tool) → HTTP ${r1.status}`);
  if (r1.status !== 200) {
    console.error("✗ Turn 1 failed — extended thinking not accepted:", r1.json);
    process.exit(1);
  }
  const content = (r1.json.content ?? []) as Block[];
  const thinking = content.find((b) => b.type === "thinking");
  const toolUse = content.find((b) => b.type === "tool_use");
  const textBlock = content.find((b) => b.type === "text");
  console.log(`  thinking block: ${thinking ? "present" : "MISSING"}`);
  console.log(`  signature:      ${thinking?.signature ? "present" : "MISSING"}`);
  console.log(`  tool_use:       ${toolUse ? `present (${toolUse.name})` : "MISSING"}`);
  if (!thinking?.signature) {
    console.error("✗ No signature-bearing thinking block — cannot validate preservation.");
    process.exit(1);
  }
  if (!toolUse) {
    console.error("✗ Model didn't call the tool this run — re-run (non-deterministic).");
    process.exit(1);
  }

  // ── Turn 2: continuation, assistant turn rebuilt the motebit/buildMessages way
  const rebuiltAssistant: Block[] = [
    { type: "thinking", thinking: thinking.thinking, signature: thinking.signature },
    ...(textBlock?.text ? [{ type: "text", text: textBlock.text } as Block] : []),
    { type: "tool_use", id: toolUse.id, name: toolUse.name, input: toolUse.input },
  ];
  const r2 = await call({
    model: MODEL,
    max_tokens: BUDGET + 2048,
    thinking: { type: "enabled", budget_tokens: BUDGET },
    tools: [tool],
    messages: [
      userMsg,
      { role: "assistant", content: rebuiltAssistant },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUse.id, content: "18°C, sunny" }],
      },
    ],
  });
  console.log(
    `\nTurn 2 (tool continuation, thinking block replayed signature-first) → HTTP ${r2.status}`,
  );
  if (r2.status === 200) {
    console.log(
      "\n✅ PASS — Anthropic accepted the tool-use continuation with motebit's reconstructed\n" +
        "   thinking block + signature. Signature preservation works end-to-end.",
    );
  } else {
    console.error(
      "\n❌ FAIL — Anthropic rejected the continuation. This is the exact case buildMessages\n" +
        "   must satisfy. Rejection detail:\n",
      r2.json,
    );
    process.exit(1);
  }
}

void main();
