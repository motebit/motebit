/**
 * `VerifiedGrant` is branded: only `verifyGrantForTurn` can produce one.
 *
 * The assertions here are TYPE-level — each `@ts-expect-error` below is a
 * compile error the brand must keep producing. If the brand is removed or
 * weakened, the directive becomes unused and `tsc --noEmit` (the package
 * typecheck) fails. The runtime `it` blocks only keep vitest honest that the
 * file is collected. Doctrine: docs/doctrine/memory-never-confers-authority.md
 * (one audited producer; gate check-money-authority is the static twin).
 */
import { describe, it, expect } from "vitest";
import type { VerifiedGrant } from "../grant-verifier.js";
import type { MotebitRuntime } from "../motebit-runtime.js";

type StreamingOptions = NonNullable<Parameters<MotebitRuntime["sendMessageStreaming"]>[2]>;

describe("VerifiedGrant brand", () => {
  it("an object literal shaped like a grant is not a VerifiedGrant", () => {
    // @ts-expect-error — outside construction of a VerifiedGrant must not compile
    const forged: VerifiedGrant = { grant_id: "g-forged", verified_at: 0, token_issued_at: 0 };
    expect(forged.grant_id).toBe("g-forged");
  });

  it("the runtime's verifiedGrant turn option refuses an unbranded grant", () => {
    const opts: StreamingOptions = {
      // @ts-expect-error — the turn option takes only a producer-minted grant
      verifiedGrant: { grant_id: "g-forged", verified_at: 0, token_issued_at: 0 },
    };
    expect(opts).toBeDefined();
  });
});
