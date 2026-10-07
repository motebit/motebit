/**
 * #962 round 5 — the CLI push loop's two hardening clauses.
 *
 * C2: relay-provided text reaches the terminal from this path
 * (`bootstrapReplDevice`'s "Device registration: <status> <body>", the sync
 * failure line carrying a relay's error text). A hostile relay's body with
 * OSC title-set and clear-screen escapes was echoed verbatim, twice (REPL
 * startup and the push loop's re-bootstrap). Printed text is stripped of
 * C0/C1 control characters and ESC sequences, and capped.
 *
 * Cost: every idle process pushes/pulls each interval; while the relay is
 * unreachable that was 2 880 requests a day, with no backoff. Consecutive
 * failures back off exponentially with jitter (capped), reset on success;
 * the one-line report at start and on recovery stays.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncEngine, SyncResult } from "@motebit/sync-engine";
import { bootstrapReplDevice, syncFailureLine } from "../runtime-factory.js";
import { startRunEventSync, type PushingRuntime } from "../cli-event-push.js";
import type { DaemonRelaySync } from "../daemon-relay-sync.js";

/** 5 079 characters: an OSC window-title set, clear screen, cursor home, a C1 CSI. */
const HOSTILE =
  "\x1b]0;pwned by relay\x07\x1b[2J\x1b[H\x1b[31mERROR\x1b[0m\r\n\x9b2J\x00" +
  "A".repeat(5_000) +
  "\x1bPtmux;\x1b\x1b]52;c;ZXZpbA==\x07\x1b\\" +
  "B".repeat(30);

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

function assertSafe(line: string): void {
  expect(CONTROL.test(line), `control characters in ${JSON.stringify(line.slice(0, 80))}`).toBe(
    false,
  );
  expect(line.length).toBeLessThanOrEqual(260);
  expect(line).not.toContain("]0;");
  expect(line).not.toContain("[2J");
}

describe("#962 round 5 C2 — relay text reaches the terminal sanitized and truncated", () => {
  it("bootstrapReplDevice: a hostile relay body", async () => {
    const line = await bootstrapReplDevice({
      syncUrl: "http://relay.test",
      motebitId: "m",
      deviceId: "d",
      publicKeyHex: "00",
      privateKey: new Uint8Array(32),
      fetchImpl: () => Promise.resolve(new Response(HOSTILE, { status: 400 })),
    });
    expect(line).not.toBeNull();
    expect(line!.startsWith("Device registration: 400")).toBe(true);
    expect(line).toContain("ERROR");
    assertSafe(line!);
  });

  it("syncFailureLine: a relay's error text", () => {
    const line = syncFailureLine({ getLastError: () => new Error(`push 400: ${HOSTILE}`) });
    expect(line).not.toBeNull();
    expect(line!.startsWith("Sync failed")).toBe(true);
    assertSafe(line!);
  });

  it("the push loop: every reported line", async () => {
    const lines: string[] = [];
    const { runtime } = stubRuntime(() => new Error(`push 400: ${HOSTILE}`));
    const push = startRunEventSync(runtime, RELAY_SYNC, {
      syncUrl: "http://relay.test",
      log: (l) => lines.push(l),
      pushIntervalMs: 60_000,
    });
    await vi.waitFor(() => expect(lines.length).toBeGreaterThan(0));
    push.stop();
    for (const l of lines) assertSafe(l);
  });
});

// ── backoff ─────────────────────────────────────────────────────────────────

const RELAY_SYNC = { transport: { remote: {} } } as unknown as DaemonRelaySync;
const OK: SyncResult = { pulled: 0, pushed: 0, conflicts: [] } as unknown as SyncResult;

function stubRuntime(error: () => Error | null): { runtime: PushingRuntime; calls: number[] } {
  const calls: number[] = [];
  const sync = {
    sync: () => {
      calls.push(Date.now());
      return Promise.resolve(OK);
    },
    getLastError: error,
  } as unknown as SyncEngine;
  return {
    runtime: { motebitId: "m", sync, connectSync: () => {} },
    calls,
  };
}

const gaps = (ts: number[]): number[] => ts.slice(1).map((t, i) => t - ts[i]!);

describe("#962 round 5 — push/pull backoff while the relay is unreachable", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function drive(opts: {
    random: number;
    failFor: number;
    total: number;
    interval?: number;
  }): Promise<{ calls: number[]; lines: string[] }> {
    vi.useFakeTimers({ now: 0 });
    vi.spyOn(Math, "random").mockReturnValue(opts.random);
    const lines: string[] = [];
    const { runtime, calls } = stubRuntime(() =>
      Date.now() < opts.failFor ? new Error("fetch failed: ECONNREFUSED") : null,
    );
    const push = startRunEventSync(runtime, RELAY_SYNC, {
      syncUrl: "http://relay.test",
      log: (l) => lines.push(l),
      pushIntervalMs: opts.interval ?? 30_000,
    });
    for (let t = 0; t < opts.total; t += 1_000) await vi.advanceTimersByTimeAsync(1_000);
    push.stop();
    return { calls, lines };
  }

  it("N consecutive failures ⇒ growing intervals", async () => {
    const { calls } = await drive({ random: 1, failFor: Infinity, total: 20 * 60_000 });
    const g = gaps(calls).slice(0, 4);
    expect(g.length).toBe(4);
    for (let i = 1; i < g.length; i++) expect(g[i]!).toBeGreaterThan(g[i - 1]!);
    // 20 minutes unreachable: far fewer than one request per 30 s interval.
    expect(calls.length).toBeLessThan(10);
  });

  it("capped (~10 min) and jittered", async () => {
    const hi = await drive({ random: 1, failFor: Infinity, total: 3 * 60 * 60_000 });
    const hiGaps = gaps(hi.calls);
    expect(Math.max(...hiGaps)).toBeLessThanOrEqual(10 * 60_000 + 1_000);
    expect(Math.max(...hiGaps)).toBeGreaterThanOrEqual(5 * 60_000);
    vi.useRealTimers();
    vi.restoreAllMocks();
    const lo = await drive({ random: 0, failFor: Infinity, total: 3 * 60 * 60_000 });
    // Jitter: the same streak waits less with a low draw — never in lockstep.
    expect(gaps(lo.calls)[2]!).toBeLessThan(hiGaps[2]!);
    expect(lo.calls.length).toBeGreaterThan(hi.calls.length);
  });

  it("reset on success: back to the plain interval; one line at start, one on recovery", async () => {
    const failFor = 10 * 60_000;
    const { calls, lines } = await drive({ random: 1, failFor, total: 40 * 60_000 });
    const after = calls.filter((t) => t >= failFor);
    expect(after.length).toBeGreaterThan(3);
    const g = gaps(after);
    for (const x of g) expect(x).toBe(30_000);
    expect(lines.filter((l) => /fail/i.test(l)).length).toBe(1);
    expect(lines.filter((l) => /resumed/i.test(l)).length).toBe(1);
  });
});
