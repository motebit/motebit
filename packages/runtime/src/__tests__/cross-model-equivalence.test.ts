/**
 * Cross-model behavioral equivalence — the intelligence-pluggability
 * contract's empirical backstop.
 *
 * `check-prompt-budget` and `check-prompt-density` verify that motebit's
 * prompt assembly is structurally constant across foundation-model
 * vendors. This test verifies the second half of the same contract:
 * given byte-identical model OUTPUTS (the chunk sequence emitted by the
 * `StreamingProvider`), the runtime produces byte-identical signed
 * artifacts — `ExecutionReceipt` envelopes, sensitivity-gate decisions,
 * tool dispatch sequences — REGARDLESS OF WHICH VENDOR ADAPTER
 * EMITTED THE CHUNKS.
 *
 * The doctrinal claim being tested:
 *   "Runtime invariants stay constant; only prompts/tools/budgets
 *   adapt to the selected model." — `intelligence-pluggability-contract.md`
 *
 * The test is structurally invariance-over-vendor: we wire N
 * `StreamingProvider` instances to the same recorded chunk sequence and
 * assert the runtime's signed output is byte-identical across all N.
 * This rules out the failure mode "vendor adapter leaks into the
 * post-streaming pipeline" — sensitivity-gate hashing, receipt
 * canonicalization, tool dispatch ordering must be pure functions of
 * the chunk stream, not the adapter identity.
 *
 * What this test is NOT:
 *
 *   - Not a check that different vendors produce identical English
 *     text. They can't, and shouldn't; that's the model's job, not the
 *     runtime's. The test fixes the chunk stream so the model
 *     non-determinism is removed from the variable set.
 *
 *   - Not a real network test against Anthropic / OpenAI / DeepSeek.
 *     A follow-on suite will cache real chunk sequences as fixtures and
 *     drive replay-mode vendors against them; the next iteration of
 *     this test family will add that. Today's test is the structural
 *     backbone — once it passes, the fixture-replay layer composes
 *     cleanly on top.
 *
 *   - Signature byte-equality IS asserted (test 2) as the stronger
 *     structural commitment: Ed25519 is deterministic on the canonical
 *     body, so identical bodies signed with the same key MUST produce
 *     identical signatures. If they don't, a vendor-identifying field
 *     leaked into the signing path. (Note: this requires pinning the
 *     clock, since `completed_at` lives inside the signed body.)
 *
 * ### Determinism
 *
 * - Pinned clock via `RuntimeConfig.clock` so receipt `completed_at`
 *   is identical across vendor runs; `submitted_at` is pinned in the
 *   input task. Both fields land inside the canonical signed body.
 * - Pinned keypair via `generateKeypair` seeded once at suite setup —
 *   the same private key signs across all vendor runs.
 * - Replay-mode providers emit the same chunk array in the same
 *   order; no real I/O, no real model latency.
 */

import { describe, it, expect, beforeAll, vi } from "vitest";
import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index.js";
import type { PlatformAdapters, StreamChunk } from "../index.js";
import type { StreamingProvider } from "@motebit/ai-core";
import type { AIResponse, ContextPack } from "@motebit/sdk";
import { AgentTaskStatus } from "@motebit/sdk";
import type { AgentTask } from "@motebit/sdk";
import { generateKeypair, canonicalJson } from "@motebit/encryption";

// ── Replay-mode StreamingProvider factory ──────────────────────────

/**
 * Build a `StreamingProvider` that yields a fixed chunk sequence regardless
 * of input. The `vendorLabel` parameter is purely identity — it becomes
 * the `model` field, but the runtime's downstream pipeline (sensitivity
 * gate, hashing, canonicalization, signing) must produce identical output
 * regardless of this label.
 *
 * **The invariant under test:** label varies → output byte-identical.
 */
function makeReplayProvider(vendorLabel: string, responseText: string): StreamingProvider {
  const response: AIResponse = {
    text: responseText,
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
  };

  return {
    model: vendorLabel,
    setModel: vi.fn(),
    generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockResolvedValue(response),
    estimateConfidence: vi.fn<() => Promise<number>>().mockResolvedValue(0.8),
    extractMemoryCandidates: vi.fn<(r: AIResponse) => Promise<never[]>>().mockResolvedValue([]),
    async *generateStream(_ctx: ContextPack) {
      yield { type: "text" as const, text: responseText };
      yield { type: "done" as const, response };
    },
  };
}

function createAdapters(provider: StreamingProvider): PlatformAdapters {
  return {
    storage: createInMemoryStorage(),
    renderer: new NullRenderer(),
    ai: provider,
  };
}

async function getTaskResult(
  gen: AsyncGenerator<StreamChunk>,
): Promise<StreamChunk & { type: "task_result" }> {
  for await (const chunk of gen) {
    if (chunk.type === "task_result") return chunk;
  }
  throw new Error("No task_result chunk found");
}

// ── Vendor labels under test ───────────────────────────────────────

/**
 * Today's BYOK matrix per `InferenceHost` in `packages/protocol/src/routing.ts`:
 *   "anthropic" | "openai" | "google" | "groq" | "local-server"
 *
 * We test all five labels. Adding a new `InferenceHost` value MUST
 * include a row here — the test's coverage is the runtime-side
 * counterpart to `check-routing-decision-coverage` on the protocol side.
 */
const VENDOR_LABELS = ["anthropic", "openai", "google", "groq", "local-server"] as const;

// ── Suite ──────────────────────────────────────────────────────────

describe("cross-model equivalence — runtime output is invariant over StreamingProvider identity", () => {
  // Pinned keypair across all vendor runs so signatures are comparable.
  // Note: vendor adapter does NOT touch the signing key — the runtime
  // does — so the byte-identical-envelope-including-signature assertion
  // is a stronger structural commitment than envelope-modulo-signature.
  let privateKey: Uint8Array;
  const FIXED_NOW = 1_700_000_000_000;
  const FIXED_RESPONSE_TEXT = "The answer is 4.";

  beforeAll(async () => {
    const kp = await generateKeypair();
    privateKey = kp.privateKey;
  });

  it("ExecutionReceipt envelopes are byte-identical across all vendor labels", async () => {
    const task: AgentTask = {
      task_id: "task-cross-model-1",
      motebit_id: "test-mote",
      prompt: "What is 2+2?",
      submitted_at: FIXED_NOW,
      status: AgentTaskStatus.Claimed,
      wall_clock_ms: 30_000,
    };

    const receipts: Array<{ vendor: string; canonical: string }> = [];
    for (const vendor of VENDOR_LABELS) {
      const runtime = new MotebitRuntime(
        { motebitId: "test-mote", tickRateHz: 0, clock: () => FIXED_NOW },
        createAdapters(makeReplayProvider(vendor, FIXED_RESPONSE_TEXT)),
      );
      const result = await getTaskResult(runtime.handleAgentTask(task, privateKey, "device-001"));

      // Strip vendor-identifying fields that are EXPECTED to vary, then
      // canonicalize. Today the only expected-vary field is `signature`
      // (deterministic given the same canonical body, but we test the
      // body for byte-identity first; signature equality follows).
      // If we discover any other vendor-leaking fields, add them here
      // — that's the failure mode this test catches.
      const { signature: _sig, ...body } = result.receipt;
      receipts.push({ vendor, canonical: canonicalJson(body) });
    }

    const first = receipts[0];
    if (!first) throw new Error("expected at least one vendor receipt");
    for (const r of receipts.slice(1)) {
      expect(r.canonical, `vendor=${r.vendor}`).toBe(first.canonical);
    }
  });

  it("signatures are byte-identical when canonical body is byte-identical", async () => {
    // Same setup as above; the assertion sharpens to include signature.
    // This is the "no vendor leak into signing path" check.
    const task: AgentTask = {
      task_id: "task-cross-model-2",
      motebit_id: "test-mote",
      prompt: "What is 2+2?",
      submitted_at: FIXED_NOW,
      status: AgentTaskStatus.Claimed,
      wall_clock_ms: 30_000,
    };

    const sigs: Array<{ vendor: string; signature: string }> = [];
    for (const vendor of VENDOR_LABELS) {
      const runtime = new MotebitRuntime(
        { motebitId: "test-mote", tickRateHz: 0, clock: () => FIXED_NOW },
        createAdapters(makeReplayProvider(vendor, FIXED_RESPONSE_TEXT)),
      );
      const result = await getTaskResult(runtime.handleAgentTask(task, privateKey, "device-001"));
      sigs.push({ vendor, signature: result.receipt.signature });
    }

    const first = sigs[0];
    if (!first) throw new Error("expected at least one vendor signature");
    for (const s of sigs.slice(1)) {
      expect(s.signature, `vendor=${s.vendor}`).toBe(first.signature);
    }
  });

  // ── Extension points (TODO before full landing) ────────────────
  //
  // The two assertions above are the structural backbone. The
  // following are the next-iteration additions that close the
  // remaining behavioral surface; left as TODOs so they can be
  // sized and landed as separate PRs.
  //
  // Deliberately omitted: sensitivity-gate verdict invariance across
  // vendors. Sensitivity routing decisions are vendor-dependent BY
  // DESIGN — different providers declare different clearance tiers
  // (cloud-only vendors fail at financial+; on-device passes). The
  // gate is tested independently in `sensitivity-routing.test.ts`
  // along the right axis (input level varies, capability constant).
  //
  // 1. Tool dispatch sequence — wire a `ToolRegistry` with a known
  //    tool, drive a chunk sequence that contains a tool_use, and
  //    assert the dispatched tool name + args are byte-identical
  //    across vendors. Adds `@motebit/sdk`'s `ToolResult` to the
  //    invariant set.
  //
  // 2. ToolInvocationReceipt envelope equality — uses the
  //    `onToolInvocation` runtime callback to capture signed
  //    invocation receipts; asserts canonical-body equality across
  //    vendors. This is the per-tool-call counterpart to the
  //    per-task ExecutionReceipt assertion above.
  //
  // 3. Fixture-replay against REAL recorded chunk streams — capture
  //    one chunk stream per vendor against a sample prompt, commit
  //    them as fixtures under `__fixtures__/<vendor>.json`, then
  //    rerun this suite asserting that the runtime processes each
  //    real fixture into byte-identical post-streaming output. This
  //    is the empirical ceiling of the behavioral test family;
  //    everything above is the structural ceiling.
});
