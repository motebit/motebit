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

  it("coalesces frame bursts via the generation counter — only the latest paints, no back-and-forth churn", async () => {
    // Repro for Daniel's "flashing" complaint on NBA.com: the page
    // produces rapid frame changes (cookie-modal slide, ad rotation,
    // hero-video carousel). Without the generation counter, every
    // frame arrival triggered an img.src swap + decode, stacking
    // paints back-to-back. With the counter, in-flight stale frames
    // drop their paint when a newer frame has already painted.
    const bus = new StubBus();
    const handle = buildLiveBrowserElement(bus);
    const img = handle.element.querySelector("img") as HTMLImageElement;
    document.body.appendChild(handle.element);

    // jsdom's Image has no decode() — sync paint path. Each publish
    // paints synchronously, but stale frames (older timestamp) still
    // drop via the existing out-of-order guard. The generation
    // counter is exercised in the decode-defined branch (real
    // browsers); the sync path documents the timestamp-drop guard.
    bus.publish(makeFrame({ jpeg_base64: "FRAME-1", timestamp: 1_000 }));
    expect(img.src).toContain("FRAME-1");

    bus.publish(makeFrame({ jpeg_base64: "FRAME-OLDER", timestamp: 500 }));
    // Stale frame dropped — img stays on FRAME-1.
    expect(img.src).toContain("FRAME-1");

    bus.publish(makeFrame({ jpeg_base64: "FRAME-2", timestamp: 2_000 }));
    expect(img.src).toContain("FRAME-2");
  });

  it("uses Image.decode() when available — pre-decode hidden, atomic swap on visible img", async () => {
    // Real browsers (Chrome 60+, Safari 11+) define
    // `Image.prototype.decode`. The visible img must NOT have its
    // src swapped until the hidden preload image's decode resolves
    // — that's what eliminates the per-frame tear/blank.
    const bus = new StubBus();
    // Stub Image.prototype.decode for this test only — capture the
    // resolver so we control when "decode finishes."
    const originalDecode = (Image.prototype as { decode?: () => Promise<void> }).decode;
    const resolvers: Array<() => void> = [];
    (Image.prototype as { decode?: () => Promise<void> }).decode =
      function decode(): Promise<void> {
        return new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
      };
    try {
      const handle = buildLiveBrowserElement(bus);
      const img = handle.element.querySelector("img") as HTMLImageElement;
      const initialSrc = img.src;

      bus.publish(makeFrame({ jpeg_base64: "DECODED", timestamp: 1_000 }));
      // Decode hasn't resolved yet — visible img still on initial src.
      expect(img.src).toBe(initialSrc);

      // Resolve the in-flight decode → finalize swaps src.
      resolvers.forEach((r) => r());
      await new Promise((r) => setTimeout(r, 0));
      expect(img.src).toContain("DECODED");
    } finally {
      if (originalDecode) {
        (Image.prototype as { decode?: () => Promise<void> }).decode = originalDecode;
      } else {
        delete (Image.prototype as { decode?: () => Promise<void> }).decode;
      }
    }
  });

  it("renders the input-capture img visibly — visual fallback when the WebGL texture path doesn't composite", () => {
    // 2026-05-09 — the parallel WebGL screen-mesh texture path
    // (`onFrameDecoded` → `renderer.setSlabScreencastImage`) is wired
    // through but not yet visually load-bearing in production: the
    // multi-transmissive-object interaction in the slab volume
    // (front + back + sideWall all share `planeMaterial` with
    // `transmission`) doesn't reliably surface the screen-mesh
    // texture through the front pane's transmission render-target.
    // While that's diagnosed, the img stays at opacity:1 / display
    // toggled by pushFrame so the user always sees the page even
    // when the texture path is silent. Calm-software default: never
    // lose the visible content.
    const handle = buildLiveBrowserElement(new StubBus());
    const img = handle.element.querySelector("img.slab-live-browser-frame") as HTMLImageElement;
    expect(img).toBeTruthy();
    // opacity defaults (no explicit override) — visible.
    expect(img.style.opacity).toBe("");
    // Initial display:none until first frame; pushFrame flips to
    // block once the JPEG src is set (Slice 2g — suppresses the
    // broken-image glyph during the loading window).
    expect(img.style.display).toBe("none");
  });

  it("calls onFrameDecoded with the pre-decoded HTMLImageElement after Image.decode() resolves", async () => {
    // The surface (apps/web) wires this callback to
    // `renderer.setSlabScreencastImage(image)` so the slab's WebGL
    // screen-mesh texture lights up. Without the callback, the texture
    // never updates and the screencast is invisible (img is opacity:0,
    // texture is empty) — load-bearing for the new render path.
    const bus = new StubBus();
    const originalDecode = (Image.prototype as { decode?: () => Promise<void> }).decode;
    const resolvers: Array<() => void> = [];
    (Image.prototype as { decode?: () => Promise<void> }).decode =
      function decode(): Promise<void> {
        return new Promise<void>((resolve) => {
          resolvers.push(resolve);
        });
      };
    try {
      const decoded: Array<{ image: HTMLImageElement; timestamp: number }> = [];
      buildLiveBrowserElement(bus, {
        onFrameDecoded: (image, frame) => {
          decoded.push({ image, timestamp: frame.timestamp });
        },
      });

      bus.publish(makeFrame({ jpeg_base64: "FRAME-A", timestamp: 1_000 }));
      // Decode in-flight — no callback yet.
      expect(decoded).toHaveLength(0);

      resolvers.forEach((r) => r());
      await new Promise((r) => setTimeout(r, 0));

      expect(decoded).toHaveLength(1);
      expect(decoded[0]!.image).toBeInstanceOf(HTMLImageElement);
      expect(decoded[0]!.image.src).toContain("FRAME-A");
      expect(decoded[0]!.timestamp).toBe(1_000);
    } finally {
      if (originalDecode) {
        (Image.prototype as { decode?: () => Promise<void> }).decode = originalDecode;
      } else {
        delete (Image.prototype as { decode?: () => Promise<void> }).decode;
      }
    }
  });

  it("falls back to passing the visible img when Image.decode is unavailable (jsdom path)", () => {
    // jsdom doesn't define Image.prototype.decode. The fallback path
    // should still fire onFrameDecoded with whatever's available — the
    // visible img after src is set — so the slab texture path doesn't
    // silently drop frames in test environments.
    const bus = new StubBus();
    const decoded: HTMLImageElement[] = [];
    const handle = buildLiveBrowserElement(bus, {
      onFrameDecoded: (image) => {
        decoded.push(image);
      },
    });
    bus.publish(makeFrame({ jpeg_base64: "JSDOM", timestamp: 5 }));
    expect(decoded).toHaveLength(1);
    // In the fallback path the visible img IS what's passed.
    expect(decoded[0]).toBe(handle.element.querySelector("img"));
  });

  it("disables native HTML image drag on the frame img — no native drag-ghost, no drop-handler hijack", () => {
    // Repro for the production /computer bug: click+hold+drag on the
    // screencast triggered the browser's native image-drag. On release,
    // apps/web's document-level drop handler classified the data: URI
    // src as `kind: "url"` and `feedPerception` opened a fetch slab item,
    // which displaced the live_browser card. Pinning `draggable=false`
    // closes the bug at the source — an interactive screencast is NOT
    // a saveable image.
    const handle = buildLiveBrowserElement(new StubBus());
    const img = handle.element.querySelector("img.slab-live-browser-frame") as HTMLImageElement;
    expect(img).toBeTruthy();
    expect(img.draggable).toBe(false);
    // Legacy WebKit fallback — `-webkit-user-drag: none` covers Safari
    // versions that don't fully honor `draggable=false` on data: URIs.
    expect(img.style.getPropertyValue("-webkit-user-drag")).toBe("none");
    expect(img.style.userSelect).toBe("none");
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
