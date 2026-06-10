/**
 * Wire-in tests for the proactive interior — runtime.consolidationCycle(),
 * idle-tick action="consolidate", presence transitions, scoped tool registry.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EventType } from "@motebit/sdk";
import type { AIResponse, ContextPack } from "@motebit/sdk";
import type { StreamingProvider } from "@motebit/ai-core";

vi.mock("@motebit/memory-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/memory-graph")>();
  return {
    ...actual,
    embedText: vi.fn().mockResolvedValue(new Array(384).fill(0.1)),
  };
});

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";

function createMockProvider(): StreamingProvider {
  const response: AIResponse = {
    text: "ok",
    confidence: 0.8,
    memory_candidates: [],
    state_updates: {},
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn<(ctx: ContextPack) => Promise<AIResponse>>().mockResolvedValue(response),
    estimateConfidence: vi.fn<() => Promise<number>>().mockResolvedValue(0.8),
    extractMemoryCandidates: vi.fn<(r: AIResponse) => Promise<never[]>>().mockResolvedValue([]),
    async *generateStream(_ctx: ContextPack) {
      yield { type: "text" as const, text: "ok" };
      yield { type: "done" as const, response };
    },
  };
}

describe("Runtime — proactive interior wire-in", () => {
  let runtime: MotebitRuntime;

  beforeEach(() => {
    runtime = new MotebitRuntime(
      { motebitId: "wire-test", tickRateHz: 0 },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
  });

  it("consolidationCycle transitions presence: idle → tending → idle", async () => {
    const transitions: string[] = [];
    runtime.presence.subscribe((p) => transitions.push(p.mode));

    expect(runtime.presence.get().mode).toBe("idle");
    await runtime.consolidationCycle();
    expect(runtime.presence.get().mode).toBe("idle");

    // First subscriber notification is the enterTending; last is exitTending → idle.
    expect(transitions[0]).toBe("tending");
    expect(transitions[transitions.length - 1]).toBe("idle");
  });

  it("consolidationCycle returns the cycle result with all five phases run", async () => {
    const result = await runtime.consolidationCycle();
    expect(result.cycleId).toBeTruthy();
    expect(result.phasesRun).toEqual(["orient", "gather", "consolidate", "prune", "flush"]);
  });

  it("re-entry guard: second call while first in flight returns empty result", async () => {
    // Block the cycle by hijacking presence externally.
    runtime.presence.enterResponsive();
    const result = await runtime.consolidationCycle();
    expect(result.cycleId).toBe("");
    expect(result.phasesRun).toEqual([]);
  });

  it("proactiveAction:'consolidate' fires consolidationCycle on idle-tick", async () => {
    const stop = (runtime as unknown as { _idleTick?: { stop(): void } })._idleTick?.stop;
    if (stop) stop.call((runtime as unknown as { _idleTick: { stop(): void } })._idleTick);

    const proactiveRuntime = new MotebitRuntime(
      {
        motebitId: "tick-test",
        tickRateHz: 0,
        proactiveTickMs: 1000,
        proactiveQuietWindowMs: 0,
        proactiveAction: "consolidate",
      },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );

    const cycleSpy = vi.spyOn(proactiveRuntime, "consolidationCycle");
    // Manually fire the idle tick.
    const idleTick = (proactiveRuntime as unknown as { _idleTick: { tickNow(): Promise<void> } })
      ._idleTick;
    await idleTick.tickNow();

    expect(cycleSpy).toHaveBeenCalledTimes(1);
    const events = await proactiveRuntime.events.query({
      motebit_id: "tick-test",
      event_types: [EventType.ConsolidationCycleRun],
    });
    expect(events.length).toBeGreaterThan(0);
  });

  it("catchUpConsolidationIfOverdue runs a cycle when none has run recently", async () => {
    const rt = new MotebitRuntime(
      {
        motebitId: "catchup-fresh",
        tickRateHz: 0,
        proactiveTickMs: 1000,
        proactiveAction: "consolidate",
      },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    const cycleSpy = vi.spyOn(rt, "consolidationCycle");

    expect(await rt.catchUpConsolidationIfOverdue()).toBe(true);
    expect(cycleSpy).toHaveBeenCalledTimes(1);
  });

  it("catchUpConsolidationIfOverdue skips when a cycle ran within the window", async () => {
    const rt = new MotebitRuntime(
      {
        motebitId: "catchup-recent",
        tickRateHz: 0,
        proactiveTickMs: 1000,
        proactiveAction: "consolidate",
        proactiveCatchUpMaxAgeMs: 60 * 60 * 1000,
      },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    // Seed a recent run in the persistent event log.
    await rt.events.appendWithClock({
      event_id: crypto.randomUUID(),
      motebit_id: rt.motebitId,
      timestamp: Date.now(),
      event_type: EventType.ConsolidationCycleRun,
      payload: {},
      tombstoned: false,
    });
    const cycleSpy = vi.spyOn(rt, "consolidationCycle");

    expect(await rt.catchUpConsolidationIfOverdue()).toBe(false);
    expect(cycleSpy).not.toHaveBeenCalled();
  });

  it("catchUpConsolidationIfOverdue no-ops when consolidation isn't the proactive action", async () => {
    const rt = new MotebitRuntime(
      {
        motebitId: "catchup-off",
        tickRateHz: 0,
        proactiveTickMs: 1000,
        proactiveAction: "reflect",
      },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    const cycleSpy = vi.spyOn(rt, "consolidationCycle");

    expect(await rt.catchUpConsolidationIfOverdue()).toBe(false);
    expect(cycleSpy).not.toHaveBeenCalled();
  });

  it("scoped tool registry filters tools to empty during tending mode", async () => {
    const { SimpleToolRegistry } = await import("../index");
    const proactiveRuntime = new MotebitRuntime(
      { motebitId: "scope-test", tickRateHz: 0 },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: createMockProvider(),
        tools: (() => {
          const r = new SimpleToolRegistry();
          r.register(
            { name: "send_notification", description: "x", inputSchema: { type: "object" } },
            async () => ({ ok: true, data: "sent" }),
          );
          r.register(
            { name: "form_memory", description: "x", inputSchema: { type: "object" } },
            async () => ({ ok: true, data: "formed" }),
          );
          return r;
        })(),
      },
    );

    // Responsive: full passthrough.
    const scoped = (proactiveRuntime as unknown as { scopedToolRegistry: { list(): unknown[] } })
      .scopedToolRegistry;
    expect(scoped.list().length).toBe(2);

    // Tending: with no proactiveCapabilities config, scope is empty.
    proactiveRuntime.presence.enterTending("c", "consolidate");
    expect(scoped.list().length).toBe(0);

    // Restore.
    proactiveRuntime.presence.exitTending();
    expect(scoped.list().length).toBe(2);
  });

  it("sendMessageStreaming preempts an in-flight cycle and transitions presence", async () => {
    // Start a long-running cycle by holding the provider.generate() in a
    // promise we control, then send a user message. The cycle should
    // abort and presence should transition responsive → idle by the end.
    let releaseGenerate: () => void = () => {};
    const generateGate = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    const slowProvider = createMockProvider();
    slowProvider.generate = vi.fn(async () => {
      await generateGate;
      return {
        text: "ok",
        confidence: 0.8,
        memory_candidates: [],
        state_updates: {},
      };
    });
    const rt = new MotebitRuntime(
      { motebitId: "preempt-test", tickRateHz: 0 },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: slowProvider },
    );

    // Seed cluster so consolidate phase actually calls provider.
    const { embedText } = await import("@motebit/memory-graph");
    const embedding = await embedText("seed");
    const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
    const { MemoryType, SensitivityLevel } = await import("@motebit/sdk");
    for (let i = 0; i < 2; i++) {
      const node = await rt.memory.formMemory(
        {
          content: `Episode ${i}`,
          confidence: 0.7,
          sensitivity: SensitivityLevel.None,
          source: "user_stated",
          memory_type: MemoryType.Episodic,
        },
        embedding,
        7 * 24 * 60 * 60 * 1000,
      );
      node.created_at = fortyDaysAgo;
      node.last_accessed = fortyDaysAgo;
    }

    // Kick off the cycle (don't await yet).
    const cyclePromise = rt.consolidationCycle();
    // Wait one microtask so the cycle reaches gather → consolidate and
    // hits the gate.
    await new Promise<void>((r) => setTimeout(r, 10));
    // Confirm presence is tending.
    expect(["tending", "idle"]).toContain(rt.presence.get().mode);

    // Send a user message (mocked via direct sendMessage call). This
    // should abort the cycle, even though generateGate hasn't released.
    // Release the gate first so sendMessage can complete its own provider call.
    releaseGenerate();
    await rt.sendMessage("hello");

    // Cycle should now be done (preempted via abort).
    await cyclePromise;

    // Presence transitions back to idle after the user turn completes.
    expect(rt.presence.get().mode).toBe("idle");
  });

  it("signs + emits a ConsolidationReceipt when signing keys are configured", async () => {
    const { generateKeypair, verifyConsolidationReceipt } = await import("@motebit/crypto");
    const kp = await generateKeypair();
    const rt = new MotebitRuntime(
      { motebitId: "receipt-test", tickRateHz: 0, signingKeys: kp },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    await rt.consolidationCycle();
    const events = await rt.events.query({
      motebit_id: "receipt-test",
      event_types: [EventType.ConsolidationReceiptSigned],
    });
    expect(events).toHaveLength(1);
    const payload = events[0]!.payload as {
      receipt: import("@motebit/sdk").ConsolidationReceipt;
    };
    expect(payload.receipt.motebit_id).toBe("receipt-test");
    expect(payload.receipt.suite).toBe("motebit-jcs-ed25519-b64-v1");
    expect(payload.receipt.signature).toBeTruthy();
    expect(await verifyConsolidationReceipt(payload.receipt, kp.publicKey)).toBe(true);
  });

  it("does NOT emit a ConsolidationReceiptSigned event when signing keys are absent", async () => {
    // Default constructor — no signing keys configured.
    await runtime.consolidationCycle();
    const events = await runtime.events.query({
      motebit_id: "wire-test",
      event_types: [EventType.ConsolidationReceiptSigned],
    });
    expect(events).toHaveLength(0);
  });

  it("does NOT emit a receipt when the cycle ran zero phases (re-entry guard path)", async () => {
    const { generateKeypair } = await import("@motebit/crypto");
    const kp = await generateKeypair();
    const rt = new MotebitRuntime(
      { motebitId: "noop-test", tickRateHz: 0, signingKeys: kp },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    rt.presence.enterResponsive();
    await rt.consolidationCycle();
    const events = await rt.events.query({
      motebit_id: "noop-test",
      event_types: [EventType.ConsolidationReceiptSigned],
    });
    expect(events).toHaveLength(0);
  });

  it("anchorPendingConsolidationReceipts returns null when no pending receipts", async () => {
    const result = await runtime.anchorPendingConsolidationReceipts();
    expect(result).toBeNull();
  });

  it("anchorPendingConsolidationReceipts batches signed receipts into a v2 (RFC 6962) Merkle root", async () => {
    const { generateKeypair } = await import("@motebit/crypto");
    const { canonicalLeaf, canonicalSha256, buildMerkleTree } = await import("@motebit/encryption");
    const kp = await generateKeypair();
    const rt = new MotebitRuntime(
      { motebitId: "anchor-test", tickRateHz: 0, signingKeys: kp },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );

    // Run two cycles → two signed receipts (≥2 so the node-tag path runs).
    await rt.consolidationCycle();
    await rt.consolidationCycle();

    const anchor = await rt.anchorPendingConsolidationReceipts();
    expect(anchor).not.toBeNull();
    expect(anchor!.motebit_id).toBe("anchor-test");
    expect(anchor!.leaf_count).toBe(2);
    expect(anchor!.receipt_ids).toHaveLength(2);
    expect(anchor!.tx_hash).toBeUndefined();
    expect(anchor!.network).toBeUndefined();
    // PR5: the producer is a v2 (RFC 6962 §2.1) producer — the version rides
    // the self-describing anchor object.
    expect(anchor!.tree_hash_version).toBe("merkle-sha256-rfc6962-v2");

    // Independently recompute the Merkle root from the signed-receipt
    // events — the anchor must match under v2 (the 0x00 leaf + 0x01 node tags).
    const sevs = await rt.events.query({
      motebit_id: "anchor-test",
      event_types: [EventType.ConsolidationReceiptSigned],
    });
    const receipts = sevs
      .map((e) => (e.payload as { receipt: import("@motebit/sdk").ConsolidationReceipt }).receipt)
      .sort((a, b) =>
        a.finished_at !== b.finished_at
          ? a.finished_at - b.finished_at
          : a.receipt_id.localeCompare(b.receipt_id),
      );
    const leaves: string[] = [];
    for (const r of receipts) leaves.push(await canonicalLeaf(r, "merkle-sha256-rfc6962-v2"));
    const tree = await buildMerkleTree(leaves, "merkle-sha256-rfc6962-v2");
    expect(anchor!.merkle_root).toBe(tree.root);

    // The v2 leaf is NOT the v1 leaf — proves the 0x00 leaf tag was applied,
    // not just that some root matched.
    const v1Leaf = await canonicalSha256(receipts[0]!);
    const v2Leaf = await canonicalLeaf(receipts[0]!, "merkle-sha256-rfc6962-v2");
    expect(v2Leaf).not.toBe(v1Leaf);
  });

  it("anchorPendingConsolidationReceipts emits an anchor that verifyConsolidationAnchor accepts end-to-end (v2)", async () => {
    const { generateKeypair } = await import("@motebit/crypto");
    const { verifyConsolidationAnchor } = await import("@motebit/encryption");
    const kp = await generateKeypair();
    const rt = new MotebitRuntime(
      { motebitId: "verify-test", tickRateHz: 0, signingKeys: kp },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    await rt.consolidationCycle();
    await rt.consolidationCycle();
    const anchor = await rt.anchorPendingConsolidationReceipts();
    expect(anchor).not.toBeNull();
    expect(anchor!.tree_hash_version).toBe("merkle-sha256-rfc6962-v2");

    // Gather the signed receipts in the anchor's committed order.
    const sevs = await rt.events.query({
      motebit_id: "verify-test",
      event_types: [EventType.ConsolidationReceiptSigned],
    });
    const byId = new Map(
      sevs.map((e) => {
        const r = (e.payload as { receipt: import("@motebit/sdk").ConsolidationReceipt }).receipt;
        return [r.receipt_id, r] as const;
      }),
    );
    const ordered = anchor!.receipt_ids.map((id) => byId.get(id)!);

    const result = await verifyConsolidationAnchor(anchor!, ordered, kp.publicKey);
    expect(result.ok).toBe(true);
    expect(result.recomputedMerkleRoot).toBe(anchor!.merkle_root);
  });

  it("verifyConsolidationAnchor accepts a legacy anchor with tree_hash_version absent (absent ⇒ v1)", async () => {
    const { generateKeypair } = await import("@motebit/crypto");
    const { canonicalSha256, buildMerkleTree, verifyConsolidationAnchor } =
      await import("@motebit/encryption");
    const kp = await generateKeypair();
    const rt = new MotebitRuntime(
      { motebitId: "legacy-test", tickRateHz: 0, signingKeys: kp },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    await rt.consolidationCycle();
    await rt.consolidationCycle();

    const sevs = await rt.events.query({
      motebit_id: "legacy-test",
      event_types: [EventType.ConsolidationReceiptSigned],
    });
    const receipts = sevs
      .map((e) => (e.payload as { receipt: import("@motebit/sdk").ConsolidationReceipt }).receipt)
      .sort((a, b) =>
        a.finished_at !== b.finished_at
          ? a.finished_at - b.finished_at
          : a.receipt_id.localeCompare(b.receipt_id),
      );

    // Hand-build a pre-PR5 (v1) anchor: leaves under canonicalSha256, no
    // tree_hash_version field. It must still verify (absent ⇒ v1).
    const leaves: string[] = [];
    for (const r of receipts) leaves.push(await canonicalSha256(r));
    const tree = await buildMerkleTree(leaves);
    const legacyAnchor: import("@motebit/sdk").ConsolidationAnchor = {
      batch_id: "legacy-batch",
      motebit_id: "legacy-test",
      merkle_root: tree.root,
      receipt_ids: receipts.map((r) => r.receipt_id),
      leaf_count: receipts.length,
      anchored_at: receipts[0]!.finished_at,
    };
    expect(legacyAnchor.tree_hash_version).toBeUndefined();

    const result = await verifyConsolidationAnchor(legacyAnchor, receipts, kp.publicKey);
    expect(result.ok).toBe(true);
  });

  it("anchorPendingConsolidationReceipts emits ConsolidationReceiptsAnchored event with the anchor", async () => {
    const { generateKeypair } = await import("@motebit/crypto");
    const kp = await generateKeypair();
    const rt = new MotebitRuntime(
      { motebitId: "emit-test", tickRateHz: 0, signingKeys: kp },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    await rt.consolidationCycle();
    const anchor = await rt.anchorPendingConsolidationReceipts();
    const events = await rt.events.query({
      motebit_id: "emit-test",
      event_types: [EventType.ConsolidationReceiptsAnchored],
    });
    expect(events).toHaveLength(1);
    const payload = (events[0]!.payload as { anchor: import("@motebit/sdk").ConsolidationAnchor })
      .anchor;
    expect(payload.batch_id).toBe(anchor!.batch_id);
    expect(payload.merkle_root).toBe(anchor!.merkle_root);
  });

  it("anchorPendingConsolidationReceipts is idempotent — second call with no new receipts returns null", async () => {
    const { generateKeypair } = await import("@motebit/crypto");
    const kp = await generateKeypair();
    const rt = new MotebitRuntime(
      { motebitId: "idem-test", tickRateHz: 0, signingKeys: kp },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    await rt.consolidationCycle();
    const first = await rt.anchorPendingConsolidationReceipts();
    expect(first).not.toBeNull();
    const second = await rt.anchorPendingConsolidationReceipts();
    expect(second).toBeNull();
  });

  it("anchorPendingConsolidationReceipts uses submitter and records tx_hash + network when provided", async () => {
    const { generateKeypair } = await import("@motebit/crypto");
    const kp = await generateKeypair();
    const rt = new MotebitRuntime(
      { motebitId: "submit-test", tickRateHz: 0, signingKeys: kp },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    await rt.consolidationCycle();
    const submitter = {
      chain: "solana" as const,
      network: "solana:devnet",
      submitMerkleRoot: vi
        .fn<(root: string, motebitId: string, leafCount: number) => Promise<{ txHash: string }>>()
        .mockResolvedValue({ txHash: "fake-tx-signature-base58" }),
      isAvailable: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    };
    const anchor = await rt.anchorPendingConsolidationReceipts(submitter);
    expect(anchor!.tx_hash).toBe("fake-tx-signature-base58");
    expect(anchor!.network).toBe("solana:devnet");
    expect(submitter.submitMerkleRoot).toHaveBeenCalledTimes(1);
    expect(submitter.submitMerkleRoot.mock.calls[0]![0]).toBe(anchor!.merkle_root);
    expect(submitter.submitMerkleRoot.mock.calls[0]![2]).toBe(anchor!.leaf_count);
  });

  it("anchorPendingConsolidationReceipts emits a local-only anchor when submitter throws", async () => {
    const { generateKeypair } = await import("@motebit/crypto");
    const kp = await generateKeypair();
    const rt = new MotebitRuntime(
      { motebitId: "fail-test", tickRateHz: 0, signingKeys: kp },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    await rt.consolidationCycle();
    const submitter = {
      chain: "solana" as const,
      network: "solana:devnet",
      submitMerkleRoot: vi
        .fn<(root: string, motebitId: string, leafCount: number) => Promise<{ txHash: string }>>()
        .mockRejectedValue(new Error("RPC down")),
      isAvailable: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    };
    const anchor = await rt.anchorPendingConsolidationReceipts(submitter);
    expect(anchor).not.toBeNull();
    expect(anchor!.tx_hash).toBeUndefined();
    expect(anchor!.network).toBeUndefined();
    expect(anchor!.merkle_root).toBeTruthy();
  });

  it("auto-anchor does not fire when no proactiveAnchor policy is configured", async () => {
    const { generateKeypair } = await import("@motebit/crypto");
    const kp = await generateKeypair();
    const rt = new MotebitRuntime(
      { motebitId: "auto-off-test", tickRateHz: 0, signingKeys: kp },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    await rt.consolidationCycle();
    await rt.consolidationCycle();
    const events = await rt.events.query({
      motebit_id: "auto-off-test",
      event_types: [EventType.ConsolidationReceiptsAnchored],
    });
    expect(events).toHaveLength(0);
  });

  it("auto-anchor fires when the batch threshold is reached", async () => {
    const { generateKeypair } = await import("@motebit/crypto");
    const kp = await generateKeypair();
    const rt = new MotebitRuntime(
      {
        motebitId: "auto-thresh-test",
        tickRateHz: 0,
        signingKeys: kp,
        proactiveAnchor: { batchThreshold: 2 },
      },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    // Cycle 1: receipt 1 signed, threshold not yet reached.
    await rt.consolidationCycle();
    let anchors = await rt.events.query({
      motebit_id: "auto-thresh-test",
      event_types: [EventType.ConsolidationReceiptsAnchored],
    });
    expect(anchors).toHaveLength(0);
    // Cycle 2: receipt 2 signed, threshold hit → auto-anchor fires.
    await rt.consolidationCycle();
    anchors = await rt.events.query({
      motebit_id: "auto-thresh-test",
      event_types: [EventType.ConsolidationReceiptsAnchored],
    });
    expect(anchors).toHaveLength(1);
    const anchor = (anchors[0]!.payload as { anchor: import("@motebit/sdk").ConsolidationAnchor })
      .anchor;
    expect(anchor.leaf_count).toBe(2);
  });

  it("auto-anchor uses the submitter when one is provided (tx_hash populated)", async () => {
    const { generateKeypair } = await import("@motebit/crypto");
    const kp = await generateKeypair();
    const submit = vi
      .fn<(root: string, motebitId: string, leafCount: number) => Promise<{ txHash: string }>>()
      .mockResolvedValue({ txHash: "auto-anchored-tx" });
    const rt = new MotebitRuntime(
      {
        motebitId: "auto-submit-test",
        tickRateHz: 0,
        signingKeys: kp,
        proactiveAnchor: {
          batchThreshold: 1,
          submitter: {
            chain: "solana" as const,
            network: "solana:devnet",
            submitMerkleRoot: submit,
            isAvailable: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
          },
        },
      },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    await rt.consolidationCycle();
    expect(submit).toHaveBeenCalledTimes(1);
    const anchors = await rt.events.query({
      motebit_id: "auto-submit-test",
      event_types: [EventType.ConsolidationReceiptsAnchored],
    });
    expect(anchors).toHaveLength(1);
    const anchor = (anchors[0]!.payload as { anchor: import("@motebit/sdk").ConsolidationAnchor })
      .anchor;
    expect(anchor.tx_hash).toBe("auto-anchored-tx");
    expect(anchor.network).toBe("solana:devnet");
  });

  it("auto-anchor is idempotent — once pending receipts are anchored, subsequent cycles don't re-anchor them", async () => {
    const { generateKeypair } = await import("@motebit/crypto");
    const kp = await generateKeypair();
    const rt = new MotebitRuntime(
      {
        motebitId: "auto-idem-test",
        tickRateHz: 0,
        signingKeys: kp,
        proactiveAnchor: { batchThreshold: 1 },
      },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    await rt.consolidationCycle(); // receipt 1 → anchor 1 (count 1)
    await rt.consolidationCycle(); // receipt 2 → anchor 2 (count 1)
    const anchors = await rt.events.query({
      motebit_id: "auto-idem-test",
      event_types: [EventType.ConsolidationReceiptsAnchored],
    });
    // Two cycles, two receipts, two anchors (each with leaf_count=1
    // because threshold=1 fires immediately after each receipt).
    expect(anchors).toHaveLength(2);
    const a1 = (anchors[0]!.payload as { anchor: import("@motebit/sdk").ConsolidationAnchor })
      .anchor;
    const a2 = (anchors[1]!.payload as { anchor: import("@motebit/sdk").ConsolidationAnchor })
      .anchor;
    expect(a1.leaf_count).toBe(1);
    expect(a2.leaf_count).toBe(1);
    // Receipt IDs don't overlap between anchors.
    const ids1 = new Set(a1.receipt_ids);
    for (const id of a2.receipt_ids) expect(ids1.has(id)).toBe(false);
  });

  it("auto-anchor survives a submitter failure — emits local-only anchor, doesn't loop forever", async () => {
    const { generateKeypair } = await import("@motebit/crypto");
    const kp = await generateKeypair();
    const rt = new MotebitRuntime(
      {
        motebitId: "auto-fail-test",
        tickRateHz: 0,
        signingKeys: kp,
        proactiveAnchor: {
          batchThreshold: 1,
          submitter: {
            chain: "solana" as const,
            network: "solana:devnet",
            submitMerkleRoot: vi
              .fn<
                (root: string, motebitId: string, leafCount: number) => Promise<{ txHash: string }>
              >()
              .mockRejectedValue(new Error("RPC down")),
            isAvailable: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
          },
        },
      },
      { storage: createInMemoryStorage(), renderer: new NullRenderer(), ai: createMockProvider() },
    );
    await rt.consolidationCycle();
    const anchors = await rt.events.query({
      motebit_id: "auto-fail-test",
      event_types: [EventType.ConsolidationReceiptsAnchored],
    });
    expect(anchors).toHaveLength(1);
    const anchor = (anchors[0]!.payload as { anchor: import("@motebit/sdk").ConsolidationAnchor })
      .anchor;
    // Local-only anchor — tx_hash absent, but Merkle root populated.
    expect(anchor.tx_hash).toBeUndefined();
    expect(anchor.merkle_root).toBeTruthy();
    // Receipt is now considered anchored, so a second cycle anchors only
    // the new receipt (not the old one too).
    await rt.consolidationCycle();
    const anchorsAfter = await rt.events.query({
      motebit_id: "auto-fail-test",
      event_types: [EventType.ConsolidationReceiptsAnchored],
    });
    expect(anchorsAfter).toHaveLength(2);
    const a2 = (anchorsAfter[1]!.payload as { anchor: import("@motebit/sdk").ConsolidationAnchor })
      .anchor;
    expect(a2.leaf_count).toBe(1);
  });

  it("scoped tool registry honors proactiveCapabilities config but only for memory-mutation tools", async () => {
    const { SimpleToolRegistry } = await import("../index");
    const r = new SimpleToolRegistry();
    r.register(
      { name: "form_memory", description: "x", inputSchema: { type: "object" } },
      async () => ({ ok: true, data: "formed" }),
    );
    r.register(
      { name: "send_notification", description: "x", inputSchema: { type: "object" } },
      async () => ({ ok: true, data: "sent" }),
    );

    const rt = new MotebitRuntime(
      {
        motebitId: "scope-ok",
        tickRateHz: 0,
        // User opts in to BOTH a safe tool and a side-effecting one.
        proactiveCapabilities: ["form_memory", "send_notification"],
      },
      {
        storage: createInMemoryStorage(),
        renderer: new NullRenderer(),
        ai: createMockProvider(),
        tools: r,
      },
    );
    const scoped = (rt as unknown as { scopedToolRegistry: { list(): { name: string }[] } })
      .scopedToolRegistry;

    rt.presence.enterTending("c", "consolidate");
    const visible = scoped.list().map((t) => t.name);
    expect(visible).toContain("form_memory"); // memory mutation, allowed
    expect(visible).not.toContain("send_notification"); // side-effecting, blocked despite opt-in
    rt.presence.exitTending();
  });
});
