import { describe, it, expect, afterEach, vi } from "vitest";
import { embedText, EMBEDDING_DIMENSIONS, resetPipeline } from "../embeddings";

// Successful ONNX path — split into its own file because @xenova/transformers
// must be mocked to SUCCEED here, the opposite of the throw-mock in
// embeddings.test.ts. One module-mock state per file (the idiomatic vitest
// rule) keeps both deterministic; mixing both states in one file via vi.doMock
// is what previously flaked under CI timing.
//
// The factory is self-contained (defines its fake inline) because vi.mock is
// hoisted above module-scope variables — it cannot close over them. The fake
// `pipeline` returns an extractor that yields a constant 384-dim vector, so the
// success code path is exercised without a real model download.
vi.mock("@xenova/transformers", () => {
  const data = new Float32Array(384).fill(0.05);
  const extractor = async () => ({ data });
  return { pipeline: async () => extractor };
});

describe("embedText (successful ONNX pipeline path)", () => {
  afterEach(() => resetPipeline());

  it("uses pipeline output when the model loads", async () => {
    resetPipeline();
    const vec = await embedText("test pipeline");
    expect(vec).toHaveLength(EMBEDDING_DIMENSIONS);
    // The fake extractor returns a constant vector filled with 0.05.
    expect(vec[0]).toBeCloseTo(0.05, 5);
  });
});
