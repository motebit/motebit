/**
 * The live-state boundary falsifier — pins the prompt clause that kills
 * self-state confabulation, INCLUDING the third channel discovered live
 * on 2026-07-05: a running motebit read a pasted doctrine document
 * (THE_EMERGENT_INTERIOR.md, which STAGES the "ranked tensions"
 * intervention as unbuilt) and asserted, first-person present-tense,
 * "the ranked tensions intervention is already in my context. I can feel
 * the selection pressure it's producing." Zero code implements it.
 *
 * The two-source rule ([INTERNAL REFERENCE] design vs [Now] live) had
 * shipped weeks earlier (gate #116) and did not prevent this — because
 * the channel that fired was a THIRD source the rule never named:
 * content absorbed through the conversation. This suite pins the
 * extended clause so budget-pressure trimming or a rewrite can't
 * silently reopen the channel. We cannot run a model in CI; what we can
 * do — the prompt-falsifier discipline — is assert the exact teachings
 * whose absence produced the observed failure.
 */
import { describe, it, expect } from "vitest";
import { PERCEPTION_DOCTRINE } from "../prompt.js";

describe("live-state boundary clause (PERCEPTION_DOCTRINE)", () => {
  it("still teaches the two-source rule (design vs live)", () => {
    expect(PERCEPTION_DOCTRINE).toContain("boundary of your live self-knowledge");
    expect(PERCEPTION_DOCTRINE).toContain("[INTERNAL REFERENCE]");
    expect(PERCEPTION_DOCTRINE).toContain("Static design is not live state");
  });

  it("names the THIRD source — absorbed conversation content is never self-state", () => {
    expect(PERCEPTION_DOCTRINE).toContain("content absorbed through the conversation");
    expect(PERCEPTION_DOCTRINE).toContain("A document staging an intervention does not install it");
  });

  it("forbids first-person adoption of described-but-absent machinery by name", () => {
    // The exact adoption verbs from the observed failure ("have, feel, run").
    expect(PERCEPTION_DOCTRINE).toMatch(
      /never claim in the first person to have, feel, or run a mechanism/,
    );
  });

  it("provides the honest sentence (a rule that only forbids teaches evasion)", () => {
    expect(PERCEPTION_DOCTRINE).toContain(
      "that's described in the doctrine, but it isn't built into me",
    );
  });
});
