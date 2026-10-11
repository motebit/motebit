/**
 * OPT-IN real-model test (MOTEBIT_REAL_MODEL_TESTS=1). Skipped by the default
 * `test`, `test:coverage` and the pre-push hook: it loads the real
 * @xenova/transformers + onnxruntime-node, which no unit test may do.
 *
 * Reproduces the pre-push hang deterministically: a truncated model_quantized
 * .onnx in the cache makes onnxruntime-node fail with "Failed to load model
 * because protobuf parsing failed", transformers falls back to threaded wasm,
 * and two concurrent loads in one process busy-wait the event loop forever
 * (no timer fires — so vitest's own testTimeout could never end the run).
 *
 * The child runs in its own process because a blocked event loop cannot be
 * timed out from inside it. The contract: embedText settles quickly with the
 * hash fallback instead of hanging, and the corrupt model is evicted.
 * Red before the fix: the child was SIGKILLed at 30s.
 */
import { describe, it, expect, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EMBEDDING_DIMENSIONS } from "../embeddings";

const REAL = process.env.MOTEBIT_REAL_MODEL_TESTS === "1";
const CHILD = fileURLToPath(new URL("./fixtures/corrupt-model-cache-child.mts", import.meta.url));

/** A minimal, valid BERT WordPiece tokenizer — only the .onnx is corrupt. */
function writeCorruptModelCache(root: string): void {
  const dir = join(root, "Xenova", "all-MiniLM-L6-v2");
  mkdirSync(join(dir, "onnx"), { recursive: true });
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ model_type: "bert", architectures: ["BertModel"], hidden_size: 384 }),
  );
  writeFileSync(
    join(dir, "tokenizer_config.json"),
    JSON.stringify({
      tokenizer_class: "BertTokenizer",
      do_lower_case: true,
      model_max_length: 512,
    }),
  );
  const special = ["[PAD]", "[UNK]", "[CLS]", "[SEP]"];
  writeFileSync(
    join(dir, "tokenizer.json"),
    JSON.stringify({
      version: "1.0",
      truncation: null,
      padding: null,
      added_tokens: special.map((content, id) => ({
        id,
        content,
        single_word: false,
        lstrip: false,
        rstrip: false,
        normalized: false,
        special: true,
      })),
      normalizer: {
        type: "BertNormalizer",
        clean_text: true,
        handle_chinese_chars: true,
        strip_accents: null,
        lowercase: true,
      },
      pre_tokenizer: { type: "BertPreTokenizer" },
      post_processor: {
        type: "TemplateProcessing",
        single: [
          { SpecialToken: { id: "[CLS]", type_id: 0 } },
          { Sequence: { id: "A", type_id: 0 } },
          { SpecialToken: { id: "[SEP]", type_id: 0 } },
        ],
        pair: [],
        special_tokens: {
          "[CLS]": { id: "[CLS]", ids: [2], tokens: ["[CLS]"] },
          "[SEP]": { id: "[SEP]", ids: [3], tokens: ["[SEP]"] },
        },
      },
      decoder: { type: "WordPiece", prefix: "##", cleanup: true },
      model: {
        type: "WordPiece",
        unk_token: "[UNK]",
        continuing_subword_prefix: "##",
        max_input_chars_per_word: 100,
        vocab: { "[PAD]": 0, "[UNK]": 1, "[CLS]": 2, "[SEP]": 3, alpha: 4, beta: 5 },
      },
    }),
  );
  // An ONNX ModelProto cut mid-field: a torn read of a cache file another
  // process is still writing (transformers' FileCache.put is a plain,
  // non-atomic writeFile into one cache dir shared by every workspace package).
  writeFileSync(
    join(dir, "onnx", "model_quantized.onnx"),
    Buffer.from([0x08, 0x07, 0x12, 0x0c, ...Buffer.from("backend-test"), 0x3a, 0xff, 0xff]),
  );
}

describe.skipIf(!REAL)("real model: corrupt cached .onnx (opt-in)", () => {
  const root = mkdtempSync(join(tmpdir(), "motebit-corrupt-model-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("two concurrent first embeds fail fast to the hash fallback instead of hanging", () => {
    writeCorruptModelCache(root);
    const child = spawnSync(process.execPath, ["--experimental-strip-types", CHILD, root], {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
    });
    expect(child.signal, `child hung and was killed; stderr:\n${child.stderr}`).toBeNull();
    // It really took the failure path under test, not some earlier exit.
    expect(child.stderr).toContain("protobuf parsing failed");
    const line = child.stdout.trim().split("\n").pop() ?? "";
    const out = JSON.parse(line) as { ms: number; lengths: number[] };
    expect(out.lengths).toEqual([EMBEDDING_DIMENSIONS, EMBEDDING_DIMENSIONS]);
    expect(out.ms).toBeLessThan(15_000);
    // The torn model is evicted, so the next load fetches it fresh instead
    // of failing on the same bytes forever.
    expect(existsSync(join(root, "Xenova", "all-MiniLM-L6-v2"))).toBe(false);
  }, 40_000);
});
