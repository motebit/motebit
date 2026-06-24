import { describe, it, expect } from "vitest";
import { SecretRedactingProvider, redactPackForCloudEgress } from "../secret-redacting-provider.js";
import type { StreamingProvider } from "@motebit/ai-core";
import type { ContextPack, ConversationMessage, MotebitState, AIResponse } from "@motebit/sdk";

const EMPTY_RESPONSE: AIResponse = {
  text: "",
  confidence: 1,
  memory_candidates: [],
  state_updates: {},
};

/** Minimal StreamingProvider that records the pack it was handed. */
function recordingProvider(sink: { pack?: ContextPack }): StreamingProvider {
  return {
    model: "test-model",
    setModel() {},
    async generate(pack: ContextPack): Promise<AIResponse> {
      sink.pack = pack;
      return EMPTY_RESPONSE;
    },
    async *generateStream(pack: ContextPack) {
      sink.pack = pack;
      yield { type: "done" as const, response: EMPTY_RESPONSE };
    },
    async estimateConfidence() {
      return 1;
    },
    async extractMemoryCandidates() {
      return [];
    },
  };
}

function makePack(userMessage: string, history?: ConversationMessage[]): ContextPack {
  return {
    recent_events: [],
    relevant_memories: [],
    current_state: {} as unknown as MotebitState,
    user_message: userMessage,
    ...(history !== undefined ? { conversation_history: history } : {}),
  };
}

// A deterministic stand-in redactor — the decorator under test injects whatever
// redactor the runtime wires; the actual credential patterns are covered by
// @motebit/policy's redaction.test.ts.
const redact = (s: string) => s.replace(/SECRET/g, "[REDACTED]");

describe("redactPackForCloudEgress", () => {
  it("redacts user_message and user-role history, leaving other roles + the original pack untouched", () => {
    const history: ConversationMessage[] = [
      { role: "user", content: "earlier SECRET" },
      { role: "assistant", content: "ack SECRET" },
      { role: "tool", content: "tool SECRET", tool_call_id: "t1" },
    ];
    const pack = makePack("current SECRET", history);
    const out = redactPackForCloudEgress(pack, redact);

    expect(out.user_message).toBe("current [REDACTED]");
    expect(out.conversation_history?.[0]?.content).toBe("earlier [REDACTED]");
    // assistant + tool roles are NOT touched (already sanitized upstream).
    expect(out.conversation_history?.[1]?.content).toBe("ack SECRET");
    expect(out.conversation_history?.[2]?.content).toBe("tool SECRET");
    // The original pack is not mutated.
    expect(pack.user_message).toBe("current SECRET");
    expect(pack.conversation_history?.[0]?.content).toBe("earlier SECRET");
  });

  it("handles a pack with no conversation_history", () => {
    const out = redactPackForCloudEgress(makePack("hi SECRET"), redact);
    expect(out.user_message).toBe("hi [REDACTED]");
    expect(out.conversation_history).toBeUndefined();
  });
});

describe("SecretRedactingProvider", () => {
  it("redacts the outbound pack when the provider is NON-sovereign", async () => {
    const sink: { pack?: ContextPack } = {};
    const provider = new SecretRedactingProvider(recordingProvider(sink), {
      isSovereign: () => false,
      redact,
    });
    await provider.generate(makePack("my key is SECRET"));
    expect(sink.pack?.user_message).toBe("my key is [REDACTED]");
  });

  it("is a NO-OP on a SOVEREIGN provider — same pack reference, raw content kept", async () => {
    const sink: { pack?: ContextPack } = {};
    const provider = new SecretRedactingProvider(recordingProvider(sink), {
      isSovereign: () => true,
      redact,
    });
    const pack = makePack("my key is SECRET");
    await provider.generate(pack);
    expect(sink.pack).toBe(pack); // untouched, identical reference
    expect(sink.pack?.user_message).toBe("my key is SECRET");
  });

  it("redacts the streaming path too", async () => {
    const sink: { pack?: ContextPack } = {};
    const provider = new SecretRedactingProvider(recordingProvider(sink), {
      isSovereign: () => false,
      redact,
    });
    for await (const _ of provider.generateStream(makePack("stream SECRET"))) {
      // drain
    }
    expect(sink.pack?.user_message).toBe("stream [REDACTED]");
  });

  it("delegates every non-generate member transparently", async () => {
    const calls: string[] = [];
    const inner: StreamingProvider = {
      model: "test-model",
      temperature: 0.7,
      maxTokens: 1024,
      setModel: (m) => calls.push(`setModel:${m}`),
      setTemperature: (t) => calls.push(`setTemperature:${t}`),
      setMaxTokens: (n) => calls.push(`setMaxTokens:${n}`),
      async generate() {
        return EMPTY_RESPONSE;
      },
      // eslint-disable-next-line require-yield
      async *generateStream() {
        return;
      },
      async estimateConfidence() {
        return 0.42;
      },
      async extractMemoryCandidates() {
        return [];
      },
    };
    const provider = new SecretRedactingProvider(inner, { isSovereign: () => false, redact });

    expect(provider.model).toBe("test-model");
    expect(provider.temperature).toBe(0.7);
    expect(provider.maxTokens).toBe(1024);
    provider.setModel("claude-x");
    provider.setTemperature(0.5);
    provider.setMaxTokens(2048);
    expect(calls).toEqual(["setModel:claude-x", "setTemperature:0.5", "setMaxTokens:2048"]);
    expect(await provider.estimateConfidence()).toBe(0.42);
    expect(await provider.extractMemoryCandidates(EMPTY_RESPONSE)).toEqual([]);
  });
});
