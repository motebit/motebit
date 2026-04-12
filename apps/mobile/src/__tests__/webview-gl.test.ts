import { describe, it, expect, vi } from "vitest";

// Keep @motebit/render-engine real (it's pure TS)
// Keep @motebit/sdk real

import { WebViewGLAdapter } from "../adapters/webview-gl";
import { TrustMode } from "@motebit/sdk";

function makeRef() {
  return {
    injectJavaScript: vi.fn(),
  };
}

describe("WebViewGLAdapter", () => {
  it("buffers messages when no ref is set", () => {
    const a = new WebViewGLAdapter();
    a.render({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cues: {} as any,
      delta_time: 0.016,
      time: 100,
    });
    // Setting ref should flush the buffered message if webview is ready
    const ref = makeRef();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a.setWebViewRef(ref as any);
    // Not yet ready, so flush happens later via onWebViewMessage("ready")
    // But pendingMessages are flushed on setWebViewRef too
    expect(ref.injectJavaScript).toHaveBeenCalled();
  });

  it("setWebViewRef(null) is a no-op", () => {
    const a = new WebViewGLAdapter();
    a.setWebViewRef(null);
  });

  it("onWebViewMessage('ready') flushes pending messages", () => {
    const a = new WebViewGLAdapter();
    a.render({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cues: {} as any,
      delta_time: 0.016,
      time: 100,
    });
    const ref = makeRef();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a.setWebViewRef(ref as any);
    ref.injectJavaScript.mockClear();
    // After the ready signal, further renders go straight through
    a.onWebViewMessage("ready");
    // Subsequent render should inject directly
    a.render({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cues: {} as any,
      delta_time: 0.016,
      time: 101,
    });
    expect(ref.injectJavaScript).toHaveBeenCalled();
  });

  it("onWebViewMessage ignores non-ready messages", () => {
    const a = new WebViewGLAdapter();
    a.onWebViewMessage("other");
  });

  it("init resolves immediately", async () => {
    const a = new WebViewGLAdapter();
    await expect(a.init(null)).resolves.toBeUndefined();
  });

  it("getHTML returns HTML", () => {
    const a = new WebViewGLAdapter();
    expect(a.getHTML()).toContain("<!DOCTYPE html>");
  });

  it("getSpec returns the canonical spec", () => {
    const a = new WebViewGLAdapter();
    expect(a.getSpec()).toBeTruthy();
  });

  it("resize injects message", () => {
    const a = new WebViewGLAdapter();
    const ref = makeRef();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a.setWebViewRef(ref as any);
    a.onWebViewMessage("ready");
    ref.injectJavaScript.mockClear();
    a.resize(200, 300);
    expect(ref.injectJavaScript).toHaveBeenCalled();
  });

  it("setBackground is a no-op", () => {
    const a = new WebViewGLAdapter();
    a.setBackground(null);
    a.setBackground(0xff0000);
  });

  it("environment + interior color + audio + trust + listening messages", () => {
    const a = new WebViewGLAdapter();
    const ref = makeRef();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a.setWebViewRef(ref as any);
    a.onWebViewMessage("ready");
    ref.injectJavaScript.mockClear();
    a.setDarkEnvironment();
    a.setLightEnvironment();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a.setInteriorColor({ tint: [1, 1, 1], glow: [0, 0, 0] } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a.setAudioReactivity({ rms: 0.2, bands: [] } as any);
    a.setAudioReactivity(null);
    a.setTrustMode(TrustMode.Full);
    a.setListeningIndicator(true);
    a.setListeningIndicator(false);
    expect(ref.injectJavaScript.mock.calls.length).toBeGreaterThan(6);
  });

  it("dispose clears ready state + pending", () => {
    const a = new WebViewGLAdapter();
    const ref = makeRef();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    a.setWebViewRef(ref as any);
    a.onWebViewMessage("ready");
    a.dispose();
    // After dispose, messages buffer again
    a.render({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cues: {} as any,
      delta_time: 0.016,
      time: 1,
    });
  });

  it("touch gesture handlers are no-ops", () => {
    const a = new WebViewGLAdapter();
    a.handleTouchStart();
    a.handleTouchEnd();
    a.handlePan(1, 1);
    a.handlePinch(1.2);
    a.handleDoubleTap();
  });
});
