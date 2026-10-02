// Times out (1 s) when sum.mjs carries TOKEN_SPIKE_ALWAYS, or carries
// TOKEN_SPIKE_ONCE and this is the first such run (a load spike: the flag file
// FX_STATE-spike records it) — a timeout that does not reproduce.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it } from "vitest";

import { sum } from "./sum.mjs";

it("sums under load", async () => {
  const src = readFileSync(new URL("./sum.mjs", import.meta.url), "utf8");
  const flag = `${process.env.FX_STATE}-spike`;
  let spike = src.includes("TOKEN_SPIKE_ALWAYS");
  if (src.includes("TOKEN_SPIKE_ONCE") && !existsSync(flag)) {
    writeFileSync(flag, "spiked\n");
    spike = true;
  }
  if (spike) await new Promise((r) => setTimeout(r, 3000));
  expect(sum(2, 3)).toBe(5);
}, 1000);
