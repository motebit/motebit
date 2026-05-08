/**
 * @vitest-environment jsdom
 *
 * v1.3 — `buildLiveBrowserElement` renders a continuous JPEG
 * screencast onto an `<img>` element whose src updates per frame.
 * Tests drive the frame source directly + assert DOM mutations.
 */
import { describe, it, expect, vi } from "vitest";
import type { ScreencastFrame, ScreencastFrameSource } from "@motebit/sdk";

import { buildLiveBrowserElement } from "../live-browser.js";

class StubBus implements ScreencastFrameSource {
  private subs = new Set<(f: ScreencastFrame) => void>();
  subscribe(cb: (f: ScreencastFrame) => void): () => void {
    this.subs.add(cb);
    return () => this.subs.delete(cb);
  }
  publish(frame: ScreencastFrame): void {
    for (const s of this.subs) s(frame);
  }
  size(): number {
    return this.subs.size;
  }
}

function makeFrame(overrides: Partial<ScreencastFrame> = {}): ScreencastFrame {
  return {
    jpeg_base64: "AAAA",
    timestamp: 1_000,
    device_width: 1280,
    device_height: 800,
    ...overrides,
  };
}

describe("buildLiveBrowserElement", () => {
  it("returns an HTMLElement with the slab-live-browser class + an img child", () => {
    const handle = buildLiveBrowserElement(new StubBus());
    expect(handle.element.classList.contains("slab-live-browser")).toBe(true);
    const img = handle.element.querySelector("img.slab-live-browser-frame");
    expect(img).toBeTruthy();
  });

  it("subscribes to the frame source on construction", () => {
    const bus = new StubBus();
    const subscribe = vi.spyOn(bus, "subscribe");
    buildLiveBrowserElement(bus);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("first frame replaces the placeholder and sets img.src to the JPEG data URL", () => {
    const bus = new StubBus();
    const handle = buildLiveBrowserElement(bus);
    expect(handle.element.querySelector(".slab-live-browser-placeholder")).toBeTruthy();

    bus.publish(makeFrame({ jpeg_base64: "FIRST" }));

    expect(handle.element.querySelector(".slab-live-browser-placeholder")).toBeFalsy();
    const img = handle.element.querySelector("img") as HTMLImageElement;
    expect(img.src).toBe("data:image/jpeg;base64,FIRST");
  });

  it("locks aspect ratio to the captured viewport on first frame", () => {
    const bus = new StubBus();
    const handle = buildLiveBrowserElement(bus);
    bus.publish(makeFrame({ device_width: 1920, device_height: 1080 }));
    const img = handle.element.querySelector("img") as HTMLImageElement;
    expect(img.style.aspectRatio).toBe("1920 / 1080");
  });

  it("subsequent frames update src in place without re-mounting", () => {
    const bus = new StubBus();
    const handle = buildLiveBrowserElement(bus);
    const initialImg = handle.element.querySelector("img");
    bus.publish(makeFrame({ jpeg_base64: "A", timestamp: 1 }));
    bus.publish(makeFrame({ jpeg_base64: "B", timestamp: 2 }));
    bus.publish(makeFrame({ jpeg_base64: "C", timestamp: 3 }));
    const finalImg = handle.element.querySelector("img");
    expect(finalImg).toBe(initialImg); // same DOM node
    expect((finalImg as HTMLImageElement).src).toBe("data:image/jpeg;base64,C");
  });

  it("drops out-of-order frames (latest-wins on timestamp)", () => {
    const bus = new StubBus();
    const handle = buildLiveBrowserElement(bus);
    bus.publish(makeFrame({ jpeg_base64: "T100", timestamp: 100 }));
    bus.publish(makeFrame({ jpeg_base64: "T50", timestamp: 50 })); // should be dropped
    const img = handle.element.querySelector("img") as HTMLImageElement;
    expect(img.src).toBe("data:image/jpeg;base64,T100");
  });

  it("dispose unsubscribes — bus stops delivering frames", () => {
    const bus = new StubBus();
    const handle = buildLiveBrowserElement(bus);
    expect(bus.size()).toBe(1);
    handle.dispose();
    expect(bus.size()).toBe(0);
    bus.publish(makeFrame({ jpeg_base64: "AFTER" }));
    const img = handle.element.querySelector("img") as HTMLImageElement;
    expect(img.src).not.toBe("data:image/jpeg;base64,AFTER");
  });

  it("dispose is idempotent", () => {
    const bus = new StubBus();
    const handle = buildLiveBrowserElement(bus);
    handle.dispose();
    expect(() => handle.dispose()).not.toThrow();
    expect(bus.size()).toBe(0);
  });

  it("frames pushed AFTER dispose are silently dropped", () => {
    const bus = new StubBus();
    const handle = buildLiveBrowserElement(bus);
    handle.dispose();
    // Even if a stale subscriber were still wired, the disposed
    // guard inside pushFrame prevents src update.
    expect(() => bus.publish(makeFrame())).not.toThrow();
  });
});
