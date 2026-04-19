/**
 * WebView-based creature renderer for React Native.
 *
 * Uses a WKWebView (iOS) which has full WebGL2 support — same engine as
 * Safari. This gives us the exact same Three.js pipeline as the web app:
 * PMREMGenerator, transmission, glass material, everything.
 *
 * Architecture:
 * - React Native sends state updates via postMessage → WebView
 * - WebView runs Three.js with ThreeJSAdapter-equivalent setup
 * - Creature geometry, material, animation are inlined in the HTML
 *   (same code as packages/render-engine/src/creature.ts)
 * - Touch events are handled by Three.js OrbitControls inside the WebView
 *
 * This adapter implements the same interface as ExpoGLAdapter so MobileApp
 * can swap between them without any other changes.
 */

import { CANONICAL_SPEC } from "@motebit/render-engine";
import type {
  RenderAdapter,
  RenderFrame,
  InteriorColor,
  AudioReactivity,
  SatelliteSink,
  SpatialExpression,
} from "@motebit/render-engine";
import type { RenderSpec } from "@motebit/sdk";
import { TrustMode } from "@motebit/sdk";
import type { WebView } from "react-native-webview";
import { CREATURE_HTML } from "../creature-webview";

type WebViewRef = WebView;

export class WebViewGLAdapter implements RenderAdapter {
  private webViewRef: WebViewRef | null = null;
  private spec: RenderSpec = CANONICAL_SPEC;
  private pendingMessages: string[] = [];
  private ready = false;

  /** Called by App.tsx when the WebView ref is available. */
  setWebViewRef(ref: WebViewRef | null): void {
    this.webViewRef = ref;
    if (ref && this.pendingMessages.length > 0) {
      for (const msg of this.pendingMessages) {
        ref.injectJavaScript(`window.__onMessage(${msg}); true;`);
      }
      this.pendingMessages = [];
    }
  }

  /** Called when the WebView sends a message back (e.g. "ready"). */
  onWebViewMessage(data: string): void {
    if (data === "ready") {
      this.ready = true;
      // Flush pending messages
      if (this.webViewRef && this.pendingMessages.length > 0) {
        for (const msg of this.pendingMessages) {
          this.webViewRef.injectJavaScript(`window.__onMessage(${msg}); true;`);
        }
        this.pendingMessages = [];
      }
    }
  }

  private send(msg: Record<string, unknown>): void {
    const json = JSON.stringify(msg);
    if (this.ready && this.webViewRef) {
      this.webViewRef.injectJavaScript(`window.__onMessage(${json}); true;`);
    } else {
      this.pendingMessages.push(json);
    }
  }

  /** Returns the HTML source for the WebView. */
  getHTML(): string {
    return CREATURE_HTML;
  }

  // === RenderAdapter interface ===

  init(_target: unknown): Promise<void> {
    // WebView handles its own init when the HTML loads.
    return Promise.resolve();
  }

  render(frame: RenderFrame): void {
    this.send({
      type: "render",
      cues: frame.cues,
      delta_time: frame.delta_time,
      time: frame.time,
    });
  }

  getSpec(): RenderSpec {
    return this.spec;
  }

  resize(width: number, height: number): void {
    this.send({ type: "resize", width, height });
  }

  setBackground(_color: number | null): void {
    // Background controlled by environment
  }

  setDarkEnvironment(): void {
    this.send({ type: "setEnvironment", mode: "dark" });
  }

  setLightEnvironment(): void {
    this.send({ type: "setEnvironment", mode: "light" });
  }

  setInteriorColor(color: InteriorColor): void {
    this.send({ type: "setInteriorColor", color });
  }

  setAudioReactivity(energy: AudioReactivity | null): void {
    this.send({ type: "setAudioReactivity", energy });
  }

  setTrustMode(mode: TrustMode): void {
    this.send({ type: "setTrustMode", mode });
  }

  setListeningIndicator(active: boolean): void {
    this.send({ type: "setListeningIndicator", active });
  }

  /**
   * The creature's THREE.Group lives inside the WebView and is not
   * reachable from the React-Native side. Returns null so callers that
   * expect a same-process group (web/desktop mount path) degrade cleanly
   * into a no-op; the mobile satellite path goes through
   * `createSatelliteSink()` instead, which forwards expressions as
   * postMessage payloads.
   */
  getCreatureGroup(): unknown {
    return null;
  }

  /**
   * Send a SatelliteExpression to the WebView's in-scene renderer. The
   * bundle loaded via `@motebit/render-engine`'s browser IIFE owns the
   * actual CredentialSatelliteRenderer inside the WebView; this side
   * just pipes data over the existing postMessage channel (same shape
   * as render / setInteriorColor / setTrustMode above).
   */
  setSatelliteExpression(expression: SpatialExpression): void {
    this.send({ type: "setSatelliteExpression", expression });
  }

  /**
   * A SatelliteSink backed by postMessage — the mobile path into
   * `mountCredentialSatellites`. Dispose clears the in-WebView set; tick
   * is omitted because the WebView's own rAF loop drives the animation.
   */
  createSatelliteSink(): SatelliteSink {
    return {
      setExpression: (expr) => this.setSatelliteExpression(expr),
      dispose: () => this.setSatelliteExpression({ kind: "satellite", items: [] }),
    };
  }

  dispose(): void {
    this.ready = false;
    this.pendingMessages = [];
    this.webViewRef = null;
  }

  // Touch gesture handlers — handled by OrbitControls inside WebView.
  // These are no-ops since the WebView captures its own touch events.
  handleTouchStart(): void {}
  handleTouchEnd(): void {}
  handlePan(_dx: number, _dy: number): void {}
  handlePinch(_scale: number): void {}
  handleDoubleTap(): void {}
}
