/**
 * The daemon's served-task receipt bearer (#827, #836 review): a configured
 * master token first — a relay with device auth off refuses device tokens on
 * the result route, and main's master bearer worked there — else a minted
 * `task:result`. Desktop already orders them this way (SyncController
 * serving bearer tests); `motebit run` and `motebit serve` both route through
 * this helper.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { taskResultBearer } from "../task-result-bearer.js";

describe("taskResultBearer", () => {
  it("prefers a configured master token and does not mint", async () => {
    const mint = vi.fn(async () => "minted:task:result");
    expect(await taskResultBearer({ masterToken: "MASTER", mintTaskResult: mint })).toBe("MASTER");
    expect(mint).not.toHaveBeenCalled();
  });

  it("mints task:result when no master token is configured", async () => {
    const mint = vi.fn(async () => "minted:task:result");
    expect(await taskResultBearer({ masterToken: undefined, mintTaskResult: mint })).toBe(
      "minted:task:result",
    );
    expect(await taskResultBearer({ masterToken: "", mintTaskResult: mint })).toBe(
      "minted:task:result",
    );
  });

  it("returns null with neither", async () => {
    expect(await taskResultBearer({ masterToken: null, mintTaskResult: null })).toBeNull();
  });

  it("both daemon receipt posts (run and serve) go through it", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "daemon.ts"), "utf8");
    expect(src.match(/await taskResultBearer\(\{/g)?.length).toBe(2);
    expect(src.match(/masterToken: syncToken,/g)?.length).toBe(1);
  });
});
