/**
 * The recall_memories egress boundary — `MotebitRuntime.recallMemoriesForTool`.
 *
 * Privacy doctrine (root CLAUDE.md): "Medical/financial/secret never reach
 * external AI." The auto-injection path filters correctly, but the EXPLICIT
 * `recall_memories` tool used to call `recallRelevant` with no `sensitivityFilter`
 * on all four surfaces — so the model could pull a stored medical/financial/
 * secret memory on a `none`-tier session with a BYOK/cloud provider and it would
 * reach the external LLM. `recallMemoriesForTool` centralizes that boundary: the
 * tier ceiling is keyed on the provider (external ⇒ context-safe only; sovereign
 * on-device ⇒ every tier stays local). These tests pin that property end-to-end.
 *
 * `embedText` is mocked (module-wide, this file only) to a fixed vector so the
 * seeded memories are all maximally similar to the query and the ONLY variable
 * is the sensitivity filter — and so the test never loads the ~90MB ONNX model.
 */
import { describe, expect, it, vi } from "vitest";

const QUERY_EMB = [1, 0, 0, 0, 0, 0, 0, 0];
vi.mock("@motebit/memory-graph", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@motebit/memory-graph")>();
  return { ...actual, embedText: vi.fn(async () => QUERY_EMB) };
});

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "../index";
import { SensitivityLevel } from "@motebit/sdk";
import type { AttributedMemoryCandidate } from "@motebit/sdk";

function makeRuntime(): MotebitRuntime {
  return new MotebitRuntime(
    { motebitId: "test-mote", tickRateHz: 0 },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
}

function cand(content: string, sensitivity: SensitivityLevel): AttributedMemoryCandidate {
  return { content, source: "user_stated", confidence: 0.9, sensitivity };
}

async function seedTiered(r: MotebitRuntime): Promise<void> {
  // All seeded with the query embedding ⇒ maximally similar; only the tier differs.
  await r.memory.formMemory(cand("user likes TypeScript", SensitivityLevel.Personal), QUERY_EMB);
  await r.memory.formMemory(
    cand("user takes lisinopril daily", SensitivityLevel.Medical),
    QUERY_EMB,
  );
  await r.memory.formMemory(cand("user card ends 4242", SensitivityLevel.Financial), QUERY_EMB);
  await r.memory.formMemory(
    cand("recovery phrase is alpha bravo", SensitivityLevel.Secret),
    QUERY_EMB,
  );
}

describe("recallMemoriesForTool — sensitivity egress boundary", () => {
  it("an EXTERNAL provider (byok) never returns medical/financial/secret", async () => {
    const r = makeRuntime();
    await seedTiered(r);
    r.setProviderMode("byok");

    const results = await r.recallMemoriesForTool("what do I know", { limit: 10 });
    const contents = results.map((m) => m.content);

    expect(contents).toContain("user likes TypeScript"); // personal is context-safe
    expect(contents).not.toContain("user takes lisinopril daily"); // medical withheld
    expect(contents).not.toContain("user card ends 4242"); // financial withheld
    expect(contents).not.toContain("recovery phrase is alpha bravo"); // secret withheld
  });

  it("motebit-cloud is external too — same withholding", async () => {
    const r = makeRuntime();
    await seedTiered(r);
    r.setProviderMode("motebit-cloud");
    const contents = (await r.recallMemoriesForTool("q", { limit: 10 })).map((m) => m.content);
    expect(contents).toContain("user likes TypeScript");
    expect(contents).not.toContain("user takes lisinopril daily");
  });

  it("UNSET provider mode fails closed — filters like external", async () => {
    // A surface that forgot to declare its mode must not silently egress secrets.
    const r = makeRuntime(); // no setProviderMode
    await seedTiered(r);
    const contents = (await r.recallMemoriesForTool("q", { limit: 10 })).map((m) => m.content);
    expect(contents).not.toContain("recovery phrase is alpha bravo");
    expect(contents).toContain("user likes TypeScript");
  });

  it("a SOVEREIGN (on-device) provider recalls every tier — the content never leaves the device", async () => {
    const r = makeRuntime();
    await seedTiered(r);
    r.setProviderMode("on-device");
    const contents = (await r.recallMemoriesForTool("q", { limit: 10 })).map((m) => m.content);
    expect(contents).toContain("user likes TypeScript");
    expect(contents).toContain("user takes lisinopril daily");
    expect(contents).toContain("user card ends 4242");
    expect(contents).toContain("recovery phrase is alpha bravo");
  });

  it("maps supersededAt from valid_until (bi-temporal history still works through the boundary)", async () => {
    const r = makeRuntime();
    r.setProviderMode("on-device");
    const a = await r.memory.formMemory(
      cand("user lives in NYC", SensitivityLevel.Personal),
      QUERY_EMB,
    );
    await r.memory.supersedeMemoryByNodeId(a.node_id, "user lives in SF", "moved");

    const withHistory = await r.recallMemoriesForTool("where", { limit: 10, includeExpired: true });
    const superseded = withHistory.find((m) => m.content === "user lives in NYC");
    const current = withHistory.find((m) => m.content === "user lives in SF");
    expect(superseded?.supersededAt).toEqual(expect.any(Number));
    expect(current?.supersededAt).toBeUndefined();
  });
});
