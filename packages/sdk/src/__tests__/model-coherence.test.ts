/**
 * Provider ↔ model pre-flight admission (intelligence-pluggability
 * contract, commitment 1). Born live 2026-07-06: `--provider anthropic`
 * + config-resident `default_model: llama3.2:latest` composed an
 * illegal pairing the banner printed and the API rejected opaquely.
 * The predicate refuses ONLY known cross-vendor mismatches — unknown
 * ids stay permissive so new model releases never brick startup.
 */
import { describe, it, expect } from "vitest";
import {
  modelVendorHint,
  modelCapabilityTier,
  providerAcceptsModel,
  LOCAL_SERVER_SUGGESTED_MODELS,
  PROVIDER_VERIFICATION,
  PROVIDER_NOTE,
} from "../models.js";

describe("modelVendorHint", () => {
  it("attributes registry members and naming signatures", () => {
    expect(modelVendorHint("claude-sonnet-4-6")).toBe("anthropic");
    expect(modelVendorHint("claude-sonnet-9-1")).toBe("anthropic"); // future id, prefix
    expect(modelVendorHint("gpt-5.4-mini")).toBe("openai");
    expect(modelVendorHint("gemini-2.5-flash")).toBe("google");
    expect(modelVendorHint("deepseek-chat")).toBe("deepseek");
    expect(modelVendorHint("llama3.2:latest")).toBe("local"); // the incident's id
    expect(modelVendorHint("qwen2.5-coder")).toBe("local");
    expect(modelVendorHint("totally-new-thing")).toBe("unknown");
  });
});

describe("providerAcceptsModel — refuses only KNOWN cross-vendor mismatches", () => {
  it("rejects the incident pairing", () => {
    expect(providerAcceptsModel("anthropic", "llama3.2:latest")).toBe(false);
  });
  it("accepts matched pairs and future same-vendor ids", () => {
    expect(providerAcceptsModel("anthropic", "claude-sonnet-4-6")).toBe(true);
    expect(providerAcceptsModel("anthropic", "claude-sonnet-9-1")).toBe(true);
    expect(providerAcceptsModel("openai", "gpt-5.4")).toBe(true);
  });
  it("unknown ids never block (registry lags releases)", () => {
    expect(providerAcceptsModel("anthropic", "totally-new-thing")).toBe(true);
  });
  it("local-server runs whatever the user's server hosts", () => {
    expect(providerAcceptsModel("local-server", "claude-sonnet-4-6")).toBe(true);
    expect(providerAcceptsModel("local-server", "anything:tag")).toBe(true);
  });
  it("proxy routes the cloud vendors, not local tags", () => {
    expect(providerAcceptsModel("proxy", "claude-sonnet-4-6")).toBe(true);
    expect(providerAcceptsModel("proxy", "llama3.2:latest")).toBe(false);
  });
  it("groq serves open-family models", () => {
    expect(providerAcceptsModel("groq", "llama-3.3-70b-versatile")).toBe(true);
    expect(providerAcceptsModel("groq", "claude-sonnet-4-6")).toBe(false);
  });
});

describe("gpt-oss is the open-weights LOCAL family, never the hosted OpenAI API (2026-07-31)", () => {
  it("vendor hint is local for every gpt-oss form", () => {
    expect(modelVendorHint("gpt-oss")).toBe("local");
    expect(modelVendorHint("gpt-oss:20b")).toBe("local");
    expect(modelVendorHint("gpt-oss:120b")).toBe("local");
    // The hosted family is untouched by the carve-out
    expect(modelVendorHint("gpt-5.4")).toBe("openai");
    expect(modelVendorHint("gpt-5.4-mini")).toBe("openai");
  });

  it("local-server serves its whole suggested table", () => {
    for (const m of LOCAL_SERVER_SUGGESTED_MODELS) {
      expect(providerAcceptsModel("local-server", m), m).toBe(true);
    }
  });
});

describe("modelCapabilityTier — the capability floor (#501)", () => {
  it("the witnessed incident model is minimal", () => {
    expect(modelCapabilityTier("llama3.2")).toBe("minimal");
    expect(modelCapabilityTier("llama3.2:latest")).toBe("minimal");
    expect(modelCapabilityTier("llama3.2:1b")).toBe("minimal");
  });

  it("embedded parameter sizes are the honest signal — ollama tags and dash-form ids", () => {
    expect(modelCapabilityTier("qwen3:0.6b")).toBe("minimal");
    expect(modelCapabilityTier("gemma3:4b")).toBe("minimal");
    expect(modelCapabilityTier("qwen3:8b")).toBe("capable");
    expect(modelCapabilityTier("llama3.1:70b")).toBe("capable"); // a size never claims frontier
    // WebLLM / HuggingFace dash-form ids (the web surface's on-device models)
    expect(modelCapabilityTier("Llama-3.2-3B-Instruct-q4f32_1-MLC")).toBe("minimal");
    expect(modelCapabilityTier("llama-3.3-70b-versatile")).toBe("capable");
    expect(modelCapabilityTier("openai/gpt-oss-120b")).toBe("capable");
  });

  it("known-small families are minimal, including the suggested-table entry", () => {
    expect(modelCapabilityTier("phi4-mini")).toBe("minimal");
    expect(modelCapabilityTier("gpt-5.4-nano")).toBe("minimal");
    expect(modelCapabilityTier("smollm2")).toBe("minimal");
  });

  it("frontier classes, with small flagship variants demoted", () => {
    expect(modelCapabilityTier("claude-opus-5")).toBe("frontier");
    expect(modelCapabilityTier("claude-fable-5")).toBe("frontier");
    expect(modelCapabilityTier("claude-sonnet-4-6")).toBe("frontier");
    expect(modelCapabilityTier("gpt-5.4")).toBe("frontier");
    expect(modelCapabilityTier("gemini-2.5-pro")).toBe("frontier");
    expect(modelCapabilityTier("gpt-5.4-mini")).toBe("capable");
    expect(modelCapabilityTier("gemini-2.5-flash")).toBe("capable");
    expect(modelCapabilityTier("claude-haiku-4-5-20251001")).toBe("capable");
  });

  it("unknown ids are capable — registry lag must not lobotomize a new model", () => {
    expect(modelCapabilityTier("totally-new-thing")).toBe("capable");
    expect(modelCapabilityTier("")).toBe("capable");
  });

  it("the local suggested table is never accidentally all-minimal", () => {
    // phi4-mini is DELIBERATELY the minimal-hardware entry; the rest of
    // the table must stay instrument-capable or the local default
    // experience silently loses money tools.
    const tiers = LOCAL_SERVER_SUGGESTED_MODELS.map((m) => modelCapabilityTier(m));
    expect(tiers.filter((t) => t === "minimal")).toHaveLength(1);
  });
});

describe("provider verification — supported is not the same claim as witnessed (#518)", () => {
  it("marks only the providers a live turn has actually run through as verified", () => {
    // #518. Two wire adapters cover the matrix and both are live-proven, but the
    // claim is made per VENDOR, because a shared adapter hides per-vendor quirks.
    //
    // `openai` was promoted 2026-09-09 on evidence, not expectation: a
    // probe-provider-live dispatch streamed 39 chunks and reassembled a tool
    // call. Two runs earlier the SAME probe found it 400-ing on every turn
    // against a parameter the gpt-5 family had removed (#635) — which is exactly
    // what `available` existed to say.
    for (const p of ["anthropic", "local-server", "openai"] as const) {
      expect(PROVIDER_VERIFICATION[p]).toBe("verified");
    }

    // Still unwitnessed. These ride the same OpenAI-compat wire as `openai`, and
    // a passing openai turn is evidence about the SHAPE, never about Gemini's
    // compat gaps or DeepSeek's parameter rejections. Each needs its own key and
    // its own passing probe.
    for (const p of ["google", "groq", "deepseek"] as const) {
      expect(PROVIDER_VERIFICATION[p]).toBe("available");
    }
  });

  it("covers every provider in both records — no vendor can be silently unlabelled", () => {
    // A vendor added to one record but not the other would render an empty note
    // or an undefined status, which reads as "fine" rather than "unknown" —
    // the exact false-green this record exists to prevent.
    const statuses = Object.keys(PROVIDER_VERIFICATION).sort();
    const notes = Object.keys(PROVIDER_NOTE).sort();
    expect(notes).toEqual(statuses);
    for (const note of Object.values(PROVIDER_NOTE)) {
      expect(note.trim().length).toBeGreaterThan(0);
    }
  });

  it("disambiguates Groq from xAI's Grok, explicitly", () => {
    // One letter apart, unrelated things: Groq is inference hardware hosting
    // other labs' open weights; Grok is xAI's model, which motebit does not
    // support. A picker that says only "Groq" will be misread, permanently.
    expect(PROVIDER_NOTE.groq).toMatch(/not xai's grok/i);
  });

  it("says so on every unverified note, so the tiering cannot be half-applied", () => {
    for (const [provider, status] of Object.entries(PROVIDER_VERIFICATION)) {
      const note = PROVIDER_NOTE[provider as keyof typeof PROVIDER_NOTE];
      if (status === "available") {
        expect(note, `${provider} is unverified but its note does not say so`).toMatch(
          /no live turn witnessed yet/i,
        );
      } else {
        expect(note, `${provider} is verified but its note does not say so`).toMatch(
          /verified live/i,
        );
        // The other direction: a promoted row must also stop claiming the
        // opposite. "verified live, no live turn witnessed yet" would satisfy
        // the assertion above while contradicting itself in the picker.
        expect(note, `${provider} is verified but its note still says unwitnessed`).not.toMatch(
          /no live turn witnessed yet/i,
        );
      }
    }
  });
});
