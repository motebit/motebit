/**
 * v1.3 — `startScreencast` unit tests.
 *
 * The CDP session is faked: `newCDPSession` returns a tiny EventEmitter-
 * shaped object exposing `on`, `send`, and `detach`. Tests drive
 * `Page.screencastFrame` synthetically and assert frames are decoded
 * + acked + delivered to `onFrame`. The fake also exercises the
 * disposer path (`Page.stopScreencast` + `detach`) and idempotent
 * re-stop.
 */

import { describe, it, expect, vi } from "vitest";
import type { Page } from "playwright-core";

import { startScreencast } from "../screencast.js";

interface FakeCdp {
  on: (evt: string, fn: (event: Record<string, unknown>) => void) => void;
  send: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
  emit: (evt: string, payload: Record<string, unknown>) => void;
}

function makeFakeCdp(): FakeCdp {
  const handlers = new Map<string, Array<(e: Record<string, unknown>) => void>>();
  const send = vi.fn(async () => undefined);
  const detach = vi.fn(async () => undefined);
  return {
    on: (evt, fn) => {
      const list = handlers.get(evt) ?? [];
      list.push(fn);
      handlers.set(evt, list);
    },
    send,
    detach,
    emit: (evt, payload) => {
      for (const h of handlers.get(evt) ?? []) h(payload);
    },
  };
}

function makeFakePage(cdp: FakeCdp): Page {
  return {
    context: () => ({
      newCDPSession: async () => cdp,
    }),
  } as unknown as Page;
}

describe("startScreencast", () => {
  it("starts the CDP screencast with the configured format + quality", async () => {
    const cdp = makeFakeCdp();
    await startScreencast(makeFakePage(cdp), () => {});
    const startCall = cdp.send.mock.calls.find((c) => c[0] === "Page.startScreencast");
    expect(startCall).toBeDefined();
    expect(startCall?.[1]).toMatchObject({
      format: "jpeg",
      quality: 90,
      maxWidth: 1920,
      maxHeight: 1200,
      everyNthFrame: 1,
    });
  });

  it("decodes Page.screencastFrame events into ScreencastFrame and acks", async () => {
    const cdp = makeFakeCdp();
    const onFrame = vi.fn();
    await startScreencast(makeFakePage(cdp), onFrame);

    cdp.emit("Page.screencastFrame", {
      data: "base64-jpeg-bytes",
      sessionId: 42,
      metadata: { timestamp: 1.5, deviceWidth: 1280, deviceHeight: 800 },
    });

    expect(onFrame).toHaveBeenCalledWith({
      jpeg_base64: "base64-jpeg-bytes",
      // CDP metadata.timestamp is seconds; we normalize to ms.
      timestamp: 1500,
      device_width: 1280,
      device_height: 800,
    });

    // Ack call should fire with the cdp sessionId from the frame.
    const ackCall = cdp.send.mock.calls.find((c) => c[0] === "Page.screencastFrameAck");
    expect(ackCall?.[1]).toEqual({ sessionId: 42 });
  });

  it("falls back to Date.now() when metadata.timestamp is missing", async () => {
    const cdp = makeFakeCdp();
    const onFrame = vi.fn();
    await startScreencast(makeFakePage(cdp), onFrame);

    const before = Date.now();
    cdp.emit("Page.screencastFrame", {
      data: "x",
      sessionId: 1,
      metadata: { deviceWidth: 800, deviceHeight: 600 },
    });
    const after = Date.now();

    expect(onFrame).toHaveBeenCalledOnce();
    const ts = onFrame.mock.calls[0]?.[0].timestamp as number;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("a throwing onFrame consumer does not break the screencast (frames keep coming)", async () => {
    const cdp = makeFakeCdp();
    const onFrame = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("consumer boom");
      })
      .mockImplementation(() => undefined);
    await startScreencast(makeFakePage(cdp), onFrame);
    cdp.emit("Page.screencastFrame", { data: "a", sessionId: 1, metadata: {} });
    cdp.emit("Page.screencastFrame", { data: "b", sessionId: 1, metadata: {} });
    expect(onFrame).toHaveBeenCalledTimes(2);
  });

  it("ack is fire-and-forget — a thrown ack must not throw to the caller", async () => {
    const cdp = makeFakeCdp();
    cdp.send.mockImplementation(async (method: string) => {
      if (method === "Page.screencastFrameAck") throw new Error("cdp detached");
      return undefined;
    });
    await startScreencast(makeFakePage(cdp), () => {});
    expect(() => {
      cdp.emit("Page.screencastFrame", { data: "x", sessionId: 1, metadata: {} });
    }).not.toThrow();
  });

  it("disposer sends Page.stopScreencast and detaches the CDP session", async () => {
    const cdp = makeFakeCdp();
    const stop = await startScreencast(makeFakePage(cdp), () => {});
    cdp.send.mockClear();
    await stop();
    expect(cdp.send).toHaveBeenCalledWith("Page.stopScreencast");
    expect(cdp.detach).toHaveBeenCalledOnce();
  });

  it("disposer is idempotent — calling twice is a no-op the second time", async () => {
    const cdp = makeFakeCdp();
    const stop = await startScreencast(makeFakePage(cdp), () => {});
    await stop();
    cdp.send.mockClear();
    cdp.detach.mockClear();
    await stop();
    expect(cdp.send).not.toHaveBeenCalled();
    expect(cdp.detach).not.toHaveBeenCalled();
  });

  it("disposer swallows CDP teardown errors (best-effort cleanup)", async () => {
    const cdp = makeFakeCdp();
    cdp.send.mockImplementation(async (method: string) => {
      if (method === "Page.stopScreencast") throw new Error("already detached");
      return undefined;
    });
    cdp.detach.mockRejectedValueOnce(new Error("detach failed"));
    const stop = await startScreencast(makeFakePage(cdp), () => {});
    await expect(stop()).resolves.toBeUndefined();
  });
});
