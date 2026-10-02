/**
 * A booted relay CHILD is under the network guard too.
 *
 * The booted-entry harness spawns the real deployed entry with the
 * production-shaped env (`X402_PAY_TO_ADDRESS` set), so the child's x402
 * facilitator handshake dials `x402.org` and its deposit detector dials the
 * public Base Sepolia RPC. The vitest worker's guard cannot see a child
 * process; the harness therefore preloads `network-guard.preload.mjs` into
 * every child (NODE_OPTIONS `--import`). This probe boots the compiled
 * artifact and requires that the child's boot-time egress is REFUSED — one
 * marker line per refused dial — while the relay still boots and serves.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BOOT_TIMEOUT_MS,
  DIST_TIER,
  bootRealEntry,
  killBootedEntry,
  type BootedEntry,
} from "./booted-entry-harness.js";

async function until(cond: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!cond() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  return cond();
}

describe("booted relay child: deny-by-default network", () => {
  let booted: BootedEntry;
  beforeAll(async () => {
    booted = await bootRealEntry(DIST_TIER);
  }, BOOT_TIMEOUT_MS);
  afterAll(() => {
    killBootedEntry(booted);
  });

  it("refuses the child's boot-time egress (facilitator + deposit RPC) and still serves", async () => {
    await until(() => booted.egressRefusals().length >= 2, 10_000);
    const refused = booted.egressRefusals();
    expect(refused.length, booted.log()).toBeGreaterThan(0);
    // Every refusal names a non-loopback target; none is a loopback dial.
    for (const target of refused) expect(target).not.toMatch(/127\.0\.0\.1|localhost/);
    expect(
      refused.some((t) => /x402\.org|base\.org/.test(t)),
      refused.join("\n"),
    ).toBe(true);
    const health = await fetch(`${booted.baseUrl}/health`);
    expect(health.status).toBeLessThan(500);
  }, 20_000);
});
