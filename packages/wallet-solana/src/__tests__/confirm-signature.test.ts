/**
 * HTTP-polling confirmation — every outcome of `checkSignatureOnce` and the
 * bounded loop in `confirmSignatureByPolling`, driven by a fake
 * `SignatureStatusReader` (no network, no websocket).
 */
import type { Commitment, SignatureStatus } from "@solana/web3.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  checkSignatureOnce,
  confirmSignatureByPolling,
  type SignatureStatusReader,
} from "../confirm-signature.js";

const REF = { signature: "sig-1", lastValidBlockHeight: 100 };

function status(partial: Partial<SignatureStatus>): SignatureStatus {
  return { slot: 7, confirmations: 0, err: null, ...partial } as SignatureStatus;
}

function reader(
  statuses: (SignatureStatus | null)[],
  heights: number[] = [0],
): SignatureStatusReader & {
  getSignatureStatuses: ReturnType<typeof vi.fn>;
  getBlockHeight: ReturnType<typeof vi.fn>;
} {
  let s = 0;
  let h = 0;
  return {
    getSignatureStatuses: vi.fn(async () => ({
      value: [statuses[Math.min(s++, statuses.length - 1)] ?? null],
    })),
    getBlockHeight: vi.fn(async () => heights[Math.min(h++, heights.length - 1)]!),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("checkSignatureOnce", () => {
  it("reads the height at finalized and searches transaction history", async () => {
    const conn = reader([status({ confirmationStatus: "confirmed" })]);
    await checkSignatureOnce(conn, REF, "confirmed");
    expect(conn.getBlockHeight).toHaveBeenCalledWith("finalized");
    expect(conn.getSignatureStatuses).toHaveBeenCalledWith(["sig-1"], {
      searchTransactionHistory: true,
    });
  });

  it.each<[Commitment, SignatureStatus["confirmationStatus"]]>([
    ["processed", "processed"],
    ["recent", "processed"],
    ["confirmed", "confirmed"],
    ["single", "confirmed"],
    ["finalized", "finalized"],
    ["max", "finalized"],
    ["root", "finalized"],
  ])("confirms at %s once the status reaches %s", async (commitment, level) => {
    const conn = reader([status({ confirmationStatus: level })]);
    await expect(checkSignatureOnce(conn, REF, commitment)).resolves.toEqual({
      status: "confirmed",
      slot: 7,
    });
  });

  it("stays pending (seen) while the status is below the requested commitment", async () => {
    const conn = reader([status({ confirmationStatus: "confirmed" })]);
    await expect(checkSignatureOnce(conn, REF, "finalized")).resolves.toEqual({
      status: "pending",
      seen: true,
    });
  });

  it("treats a legacy status with confirmations === null as rooted", async () => {
    const conn = reader([status({ confirmationStatus: undefined, confirmations: null })]);
    await expect(checkSignatureOnce(conn, REF, "finalized")).resolves.toEqual({
      status: "confirmed",
      slot: 7,
    });
  });

  it("treats a legacy status with a confirmation count as processed only", async () => {
    const conn = reader([status({ confirmationStatus: undefined, confirmations: 3 })]);
    await expect(checkSignatureOnce(conn, REF, "confirmed")).resolves.toEqual({
      status: "pending",
      seen: true,
    });
  });

  it("reports a landed error as failed once it is confirmed", async () => {
    const err = { InstructionError: [0, "Custom"] };
    const conn = reader([status({ confirmationStatus: "confirmed", err })]);
    await expect(checkSignatureOnce(conn, REF, "finalized")).resolves.toEqual({
      status: "failed",
      slot: 7,
      err,
    });
  });

  it("does not call a processed-only error final when confirmed is requested", async () => {
    const conn = reader([status({ confirmationStatus: "processed", err: { x: 1 } })]);
    await expect(checkSignatureOnce(conn, REF, "confirmed")).resolves.toEqual({
      status: "pending",
      seen: true,
    });
  });

  it("accepts a processed error as failed when processed is all that was asked", async () => {
    const conn = reader([status({ confirmationStatus: "processed", err: "boom" })]);
    await expect(checkSignatureOnce(conn, REF, "processed")).resolves.toEqual({
      status: "failed",
      slot: 7,
      err: "boom",
    });
  });

  it("is expired only when the status is absent and the height is past the expiry", async () => {
    await expect(checkSignatureOnce(reader([null], [101]), REF, "confirmed")).resolves.toEqual({
      status: "expired",
      blockHeight: 101,
    });
    // At the expiry height itself the blockhash is still usable.
    await expect(checkSignatureOnce(reader([null], [100]), REF, "confirmed")).resolves.toEqual({
      status: "pending",
      seen: false,
    });
  });

  it("prefers a found status over an expired height", async () => {
    const conn = reader([status({ confirmationStatus: "finalized" })], [500]);
    await expect(checkSignatureOnce(conn, REF, "confirmed")).resolves.toEqual({
      status: "confirmed",
      slot: 7,
    });
  });

  it("turns an RPC error into pending with a reason, never a verdict", async () => {
    const conn = reader([null]);
    conn.getBlockHeight.mockRejectedValueOnce(new Error("429 Too Many Requests"));
    await expect(checkSignatureOnce(conn, REF, "confirmed")).resolves.toEqual({
      status: "pending",
      seen: false,
      reason: "429 Too Many Requests",
    });
    conn.getSignatureStatuses.mockRejectedValueOnce("socket hang up");
    await expect(checkSignatureOnce(conn, REF, "confirmed")).resolves.toEqual({
      status: "pending",
      seen: false,
      reason: "socket hang up",
    });
  });
});

describe("confirmSignatureByPolling", () => {
  function clock(start = 0): { now: () => number; sleep: (ms: number) => Promise<void> } {
    let t = start;
    return {
      now: () => t,
      sleep: vi.fn(async (ms: number) => {
        t += ms;
      }),
    };
  }

  it("polls until the status reaches the commitment", async () => {
    const conn = reader([
      null,
      status({ confirmationStatus: "processed" }),
      status({ confirmationStatus: "confirmed", slot: 9 }),
    ]);
    const c = clock();
    await expect(
      confirmSignatureByPolling(conn, REF, "confirmed", { pollMs: 10, maxWaitMs: 1_000, ...c }),
    ).resolves.toEqual({ status: "confirmed", slot: 9 });
    expect(conn.getSignatureStatuses).toHaveBeenCalledTimes(3);
    expect(c.sleep).toHaveBeenCalledTimes(2);
    expect(c.sleep).toHaveBeenCalledWith(10);
  });

  it("returns failed and expired immediately without sleeping", async () => {
    const c = clock();
    await expect(
      confirmSignatureByPolling(
        reader([status({ confirmationStatus: "finalized", err: "e" })]),
        REF,
        "confirmed",
        c,
      ),
    ).resolves.toMatchObject({ status: "failed" });
    await expect(
      confirmSignatureByPolling(reader([null], [200]), REF, "confirmed", c),
    ).resolves.toEqual({ status: "expired", blockHeight: 200 });
    expect(c.sleep).not.toHaveBeenCalled();
  });

  it("returns the last pending outcome once the bounded wait is spent", async () => {
    const conn = reader([null, status({ confirmationStatus: "processed" })]);
    const c = clock();
    await expect(
      confirmSignatureByPolling(conn, REF, "confirmed", { pollMs: 30, maxWaitMs: 100, ...c }),
    ).resolves.toEqual({ status: "pending", seen: true });
    // Polls at t=0,30,60,90; the next poll would land past the deadline.
    expect(conn.getSignatureStatuses).toHaveBeenCalledTimes(4);
    expect(c.sleep).toHaveBeenCalledTimes(3);
  });

  it("defaults to a 1 s real-timer sleep and a 90 s bound", async () => {
    vi.useFakeTimers();
    const conn = reader([null]);
    const p = confirmSignatureByPolling(conn, REF, "confirmed");
    await vi.advanceTimersByTimeAsync(90_000);
    await expect(p).resolves.toEqual({ status: "pending", seen: false });
    // One poll per second from t=0 through t=90 s.
    expect(conn.getSignatureStatuses).toHaveBeenCalledTimes(91);
  });
});
