/**
 * A remote embedding backend is EGRESS: `embedText` POSTs its input to a
 * service off the device (web always, mobile in cloud mode, via the proxy's
 * /v1/embed). The service is external, so it receives only text whose tier is
 * context-safe (none / personal). Anything above — and any input whose tier
 * the caller did not state (fail-closed) — is embedded locally (the on-device
 * model, else the deterministic hash fallback) and never sent.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { SensitivityLevel } from "@motebit/sdk";
import { EMBEDDING_DIMENSIONS, embedText, resetPipeline, setRemoteEmbedUrl } from "../embeddings";

// Local model load fails → the local path is the deterministic hash fallback.
vi.mock("@xenova/transformers", () => {
  throw new Error("Simulated download failure");
});

const URL = "https://embed.example/v1/embed";

function captureRemote(): string[] {
  const bodies: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return new Response(
      JSON.stringify({ ok: true, embeddings: [new Array<number>(384).fill(0.05)] }),
      { headers: { "Content-Type": "application/json" } },
    );
  });
  return bodies;
}

describe("embedText — the remote embed service is external egress", () => {
  afterEach(() => {
    setRemoteEmbedUrl(null);
    resetPipeline();
    vi.restoreAllMocks();
  });

  for (const tier of [SensitivityLevel.None, SensitivityLevel.Personal]) {
    it(`a ${tier} input is embedded remotely`, async () => {
      const bodies = captureRemote();
      setRemoteEmbedUrl(URL);
      const vec = await embedText(`context safe ${tier}`, tier);
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toContain(`context safe ${tier}`);
      expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
    });
  }

  for (const tier of [
    SensitivityLevel.Medical,
    SensitivityLevel.Financial,
    SensitivityLevel.Secret,
  ]) {
    it(`a ${tier} input never leaves the device`, async () => {
      const bodies = captureRemote();
      setRemoteEmbedUrl(URL);
      const vec = await embedText(`EMBEDCANARY ${tier}`, tier);
      expect(bodies).toEqual([]);
      expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(vec.some((v) => v !== 0)).toBe(true);
    });
  }

  it("an input whose tier is not stated never leaves the device (fail-closed)", async () => {
    const bodies = captureRemote();
    setRemoteEmbedUrl(URL);
    await embedText("EMBEDCANARY unlabeled");
    expect(bodies).toEqual([]);
  });

  it("a local embedding of withheld text is the same vector the remote fallback would produce locally", async () => {
    captureRemote();
    setRemoteEmbedUrl(URL);
    const withheld = await embedText("same words", SensitivityLevel.Secret);
    setRemoteEmbedUrl(null);
    const local = await embedText("same words", SensitivityLevel.Secret);
    expect(withheld).toEqual(local);
  });
});
