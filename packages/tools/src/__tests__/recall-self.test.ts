/**
 * recall_self handler tests — the live-vs-committed boundary marker.
 *
 * Every hit list ships under a [SELF_DESCRIPTION] banner so the model can
 * never mistake the committed repo corpus (design + intent) for live
 * runtime or network state. Witnessed 2026-07-09 in prod: a corpus
 * marketplace chunk was recited as the current relay roster. The banner is
 * the dispatch-layer half of the typed-truth fix; the prompt clause
 * (PERCEPTION_DOCTRINE) and the discover_agents `roster_source` stamp are
 * the other halves.
 */
import { describe, it, expect } from "vitest";
import { createRecallSelfHandler, type RecallSelfHit } from "../builtins/recall-self.js";

const HIT: RecallSelfHit = {
  source: "architecture",
  title: "Marketplace",
  content: "Molecules: research ($0.25/report), code-review ($0.50/review)…",
  score: 0.91,
};

describe("recall_self — committed-corpus banner", () => {
  it("prefixes every non-empty result with the SELF_DESCRIPTION boundary marker", async () => {
    const handler = createRecallSelfHandler(async () => [HIT]);
    const result = await handler({ query: "who is discoverable" });
    expect(result.ok).toBe(true);
    const data = result.data as string;
    expect(data.startsWith("[SELF_DESCRIPTION")).toBe(true);
    expect(data).toContain("not live state");
    expect(data).toContain("discover_agents");
    // The hits still render after the banner.
    expect(data).toContain("Marketplace");
    expect(data).toContain("score=0.91");
  });

  it("does not banner the empty-result path (nothing to misattribute)", async () => {
    const handler = createRecallSelfHandler(async () => []);
    const result = await handler({ query: "quantum baking" });
    expect(result.ok).toBe(true);
    expect((result.data as string).startsWith("[SELF_DESCRIPTION")).toBe(false);
    expect(result.data).toContain("No interior knowledge matched");
  });

  it("refuses a missing query", async () => {
    const handler = createRecallSelfHandler(async () => [HIT]);
    const result = await handler({});
    expect(result.ok).toBe(false);
  });
});
