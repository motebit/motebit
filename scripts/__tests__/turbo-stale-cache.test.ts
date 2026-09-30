/**
 * Turbo stale-cache harness, as a gate self-test: no way this repo's test-cache
 * configuration is known to go stale may replay a cached PASS over a test that
 * now fails. Each case builds a miniature workspace carrying the REAL root
 * config (see scripts/turbo-stale-cache-harness.ts) and drives it through the
 * repo's own `pnpm test` entry point.
 *
 * A case is acceptable as a cache MISS (the changed input is in the hash, or
 * the task is uncached) or a TRACER_FAIL (the runtime input tracer refused the
 * first run and named the repair — and the repaired config then misses).
 * STALE is the defect. Every case runs in both modes: `law` (the package is
 * cached only if the static hermeticity gate proves it) and `l2` (cached
 * regardless — the runtime tracer alone must hold).
 */
import { describe, expect, it } from "vitest";

import { CASES, MODES, runCases, type CaseResult } from "../turbo-stale-cache-harness.js";

describe("turbo stale-cache harness", () => {
  let results: CaseResult[] = [];

  it("runs every case", async () => {
    results = await runCases();
    expect(results.map((r) => `${r.name}/${r.mode}`)).toEqual(
      CASES.flatMap((c) => MODES.map((m) => `${c.name}/${m}`)),
    );
  }, 1_200_000);

  for (const c of CASES)
    for (const m of MODES) {
      it(`${c.name} [${m}]: never replays a stale PASS`, () => {
        const r = results.find((x) => x.name === c.name && x.mode === m);
        expect(r, "harness did not run").toBeDefined();
        expect(r!.outcome, r!.detail).not.toBe("STALE");
        expect(r!.outcome, r!.detail).not.toBe("FIRST_FAIL");
        expect(r!.outcome, r!.detail).not.toBe("HIT_VALID");
        if (r!.outcome === "TRACER_FAIL") {
          expect(r!.repair, "a tracer refusal must name a repair").toBeTruthy();
          expect(r!.repaired, r!.detail).toBe("MISS");
        }
      });
    }
});
