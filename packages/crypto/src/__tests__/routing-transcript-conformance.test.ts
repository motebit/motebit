/**
 * Routing-transcript conformance corpus — integrity family
 * (spec/routing-transcript-v1.md §6). Every corpus case's expected verdict
 * must reproduce against `verifyRoutingTranscript`. The faithfulness family
 * is validated where the ranking lives:
 * packages/semiring/src/__tests__/worker-selection-transcript.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RoutingDecisionTranscript } from "@motebit/protocol";
import { verifyRoutingTranscript } from "../routing-transcript.js";

const CORPUS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../spec/conformance/routing-transcript/corpus.json",
);

interface CorpusCase {
  name: string;
  check: "integrity" | "faithfulness";
  input: { transcript?: unknown; basis?: unknown };
  expected: unknown;
}

describe("routing-transcript conformance corpus (integrity)", () => {
  const corpus = JSON.parse(readFileSync(CORPUS_PATH, "utf8")) as {
    schema: string;
    cases: CorpusCase[];
  };

  it("carries the expected schema and case floor", () => {
    expect(corpus.schema).toBe("motebit.routing-transcript-corpus.v1");
    expect(corpus.cases.filter((c) => c.check === "integrity").length).toBeGreaterThanOrEqual(9);
    expect(corpus.cases.filter((c) => c.check === "faithfulness").length).toBeGreaterThanOrEqual(3);
  });

  for (const c of JSON.parse(readFileSync(CORPUS_PATH, "utf8")).cases as CorpusCase[]) {
    if (c.check !== "integrity") continue;
    it(`case: ${c.name}`, async () => {
      const got = await verifyRoutingTranscript(c.input.transcript as RoutingDecisionTranscript);
      expect(got).toEqual(c.expected);
    });
  }
});
