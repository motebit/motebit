// A self-enforced timeout (vi.waitFor, not vitest's test timeout) that
// stalls ONCE: the first run with TOKEN_WAIT_ONCE in sum.mjs (a flag file
// FX_STATE-waitfor records it). Its error is not "Test timed out".
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

import { sum } from "./sum.mjs";

it("waits for the value", async () => {
  const src = readFileSync(new URL("./sum.mjs", import.meta.url), "utf8");
  const flag = `${process.env.FX_STATE}-waitfor`;
  let stall = false;
  if (src.includes("TOKEN_WAIT_ONCE") && !existsSync(flag)) {
    writeFileSync(flag, "stalled\n");
    stall = true;
  }
  let v;
  const t = setTimeout(() => (v = sum(2, 3)), stall ? 5000 : 10);
  try {
    await vi.waitFor(
      () => {
        if (v === undefined) throw new Error("the value never came");
      },
      { timeout: 400, interval: 20 },
    );
  } finally {
    clearTimeout(t);
  }
  expect(v).toBe(5);
});
