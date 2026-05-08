/**
 * Translate a `ComputerAction` (computer-use-v1 wire format) into
 * Playwright primitives against an open `BrowserSession`. This is the
 * load-bearing translator: every kind in `ComputerAction` MUST have a
 * Playwright mapping or the dispatcher-parity drift gate fails.
 *
 * Translation table:
 *
 *   | computer-use-v1 kind | Playwright primitive                                |
 *   | -------------------- | --------------------------------------------------- |
 *   | screenshot           | page.screenshot({ type: "png" }) → bytes_base64     |
 *   | cursor_position      | session-tracked (Playwright doesn't read cursor)    |
 *   | click                | page.mouse.click(x, y, { button })                  |
 *   | double_click         | page.mouse.dblclick(x, y, { button })               |
 *   | mouse_move           | page.mouse.move(x, y)                               |
 *   | drag                 | mouse.move + down + move(steps) + up                |
 *   | type                 | page.keyboard.type(text, { delay })                 |
 *   | key                  | page.keyboard.press(translateKeyCombo(...))         |
 *   | scroll               | page.mouse.move(x, y) + page.mouse.wheel(dx, dy)    |
 *
 * The result shape is the in-flight payload the
 * `CloudBrowserDispatcher` returns from `execute()`. The runtime's
 * session manager (and its `classifyObservation` hook) consume it,
 * wrap it into a `ScreenshotObservation` / `CursorPositionObservation`
 * for the signed receipt, and apply redaction-before-AI as the
 * existing desktop path does.
 *
 * Key translation: motebit's wire format uses a small, OS-agnostic
 * key vocabulary (`Enter`, `Escape`, `ArrowDown`, `cmd+c`, etc.).
 * Playwright uses its own canonical names (`Meta+C`). The translator
 * is precise — unknown keys pass through verbatim so a future
 * Playwright addition doesn't need translator updates.
 */

import type {
  ClickAction,
  ComputerAction,
  DoubleClickAction,
  DragAction,
  KeyAction,
  MouseMoveAction,
  NavigateAction,
  ScrollAction,
  TypeAction,
  UserInputEvent,
} from "@motebit/protocol";
import type { Page } from "playwright-core";

import type { BrowserSession } from "./chromium-pool.js";
import { ServiceError } from "./errors.js";

/**
 * Wire-format result the service returns from `POST
 * /sessions/:id/actions`. The dispatcher returns this opaquely via
 * `Promise<unknown>`; the runtime's session manager reads `kind` and
 * dispatches to the right post-processing path.
 */
export interface ActionResult {
  readonly kind: string;
  readonly [key: string]: unknown;
}

/**
 * Time source — injectable for deterministic `captured_at` in tests.
 */
export interface ActionExecutorDeps {
  readonly now?: () => number;
}

export async function executeAction(
  session: BrowserSession,
  action: ComputerAction,
  deps: ActionExecutorDeps = {},
): Promise<ActionResult> {
  const now = deps.now ?? Date.now;
  switch (action.kind) {
    case "screenshot": {
      const buffer = await session.page.screenshot({ type: "png", fullPage: false });
      const viewport = session.page.viewportSize();
      return {
        kind: "screenshot",
        bytes_base64: buffer.toString("base64"),
        image_format: "png",
        width: viewport?.width ?? 0,
        height: viewport?.height ?? 0,
        captured_at: now(),
      };
    }
    case "cursor_position":
      return {
        kind: "cursor_position",
        x: session.lastCursorX,
        y: session.lastCursorY,
        captured_at: now(),
      };
    case "click":
      return doClick(session, action);
    case "double_click":
      return doDoubleClick(session, action);
    case "mouse_move":
      return doMouseMove(session, action);
    case "drag":
      return doDrag(session, action);
    case "type":
      return doType(session, action);
    case "key":
      return doKey(session, action);
    case "scroll":
      return doScroll(session, action);
    case "navigate":
      return doNavigate(session, action);
    default: {
      // Exhaustiveness — every `ComputerActionKind` must be handled.
      // If a new kind is added to `@motebit/protocol::ComputerAction`,
      // the type system prevents this default arm from compiling
      // until the new arm is added above.
      const _exhaustive: never = action;
      void _exhaustive;
      throw new ServiceError(
        "not_supported",
        `unknown action kind: ${(action as { kind: string }).kind}`,
      );
    }
  }
}

// ── Per-kind implementations ─────────────────────────────────────────

async function doClick(session: BrowserSession, action: ClickAction): Promise<ActionResult> {
  await session.page.mouse.click(action.target.x, action.target.y, {
    button: parseButton(action.button),
  });
  session.lastCursorX = action.target.x;
  session.lastCursorY = action.target.y;
  return { kind: "click", ok: true };
}

async function doDoubleClick(
  session: BrowserSession,
  action: DoubleClickAction,
): Promise<ActionResult> {
  await session.page.mouse.dblclick(action.target.x, action.target.y, {
    button: parseButton(action.button),
  });
  session.lastCursorX = action.target.x;
  session.lastCursorY = action.target.y;
  return { kind: "double_click", ok: true };
}

async function doMouseMove(
  session: BrowserSession,
  action: MouseMoveAction,
): Promise<ActionResult> {
  await session.page.mouse.move(action.target.x, action.target.y);
  session.lastCursorX = action.target.x;
  session.lastCursorY = action.target.y;
  return { kind: "mouse_move", ok: true };
}

async function doDrag(session: BrowserSession, action: DragAction): Promise<ActionResult> {
  const button = parseButton(action.button);
  await session.page.mouse.move(action.from.x, action.from.y);
  await session.page.mouse.down({ button });
  // Interpolate so dragstart/dragover handlers fire — many DOM drag
  // implementations require multiple intermediate mousemove events
  // before they recognize a drag.
  const steps = Math.max(1, Math.round((action.duration_ms ?? 100) / 16));
  await session.page.mouse.move(action.to.x, action.to.y, { steps });
  await session.page.mouse.up({ button });
  session.lastCursorX = action.to.x;
  session.lastCursorY = action.to.y;
  return { kind: "drag", ok: true };
}

async function doType(session: BrowserSession, action: TypeAction): Promise<ActionResult> {
  await session.page.keyboard.type(action.text, { delay: action.per_char_delay_ms });
  return { kind: "type", ok: true };
}

async function doKey(session: BrowserSession, action: KeyAction): Promise<ActionResult> {
  // The wire format encodes modifiers inside the `key` string itself
  // (e.g. `"cmd+c"`, `"ctrl+shift+t"`, `"Escape"`). No separate
  // modifier list — the translator splits + renames + rejoins.
  await pressKeyCombo(session.page, action.key);
  return { kind: "key", ok: true };
}

async function doScroll(session: BrowserSession, action: ScrollAction): Promise<ActionResult> {
  await session.page.mouse.move(action.target.x, action.target.y);
  await session.page.mouse.wheel(action.dx, action.dy);
  session.lastCursorX = action.target.x;
  session.lastCursorY = action.target.y;
  return { kind: "scroll", ok: true };
}

async function doNavigate(session: BrowserSession, action: NavigateAction): Promise<ActionResult> {
  // Normalize relative-looking inputs (`example.com`, `tesla.com/about`)
  // into absolute URLs. Per spec: implementations SHOULD normalize but
  // MAY reject malformed inputs with `not_supported`. The test for
  // "looks absolute" is presence of a scheme — anything else is treated
  // as a hostname-leading path and prefixed with `https://`.
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(action.url) ? action.url : `https://${action.url}`;
  try {
    // Two-phase wait. `domcontentloaded` is the navigation guarantee
    // (DOM exists, scripts can run); the `networkidle` follow-up is
    // the rendering settle so the next `screenshot` action captures
    // content, not the SPA mount placeholder.
    //
    // Witnessed 2026-05-07: after Slice Q stealth defeated Akamai's
    // first-tier check on tesla.com, the screenshot came back blank
    // white — Tesla's SPA finishes mounting ~1-2s after
    // domcontentloaded fires, and the slab dutifully rendered the
    // pre-mount blank state.
    //
    // networkidle has known reliability issues on pages with
    // persistent connections (SSE, WebSocket, long-poll analytics),
    // so it's capped at 5s with a soft fallback — those pages don't
    // hang the navigate. The screenshot then captures whatever DID
    // render in those 5s, typically enough to be useful.
    // Timeouts tightened 2026-05-08: 30s/5s was reading as a 30-second
    // load on otherwise-fast sites because cold-start Chromium + AI
    // loop overhead stacked on top. 15s for `goto` is enough for any
    // honest first-paint; honest failure faster beats waiting longer
    // for sites that aren't going to render. networkidle dropped to
    // 2s — long enough to settle SPAs that finish their mount in the
    // first second after DOMContentLoaded, short enough that
    // analytics-heavy pages don't pin the wait to its ceiling.
    await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    let visualReadinessTimeout = false;
    try {
      await session.page.waitForLoadState("networkidle", { timeout: 2_000 });
    } catch {
      // networkidle timeout — page has persistent connections or is
      // still streaming. Continue anyway; the capture surfaces
      // whatever's currently painted, and the metadata below records
      // the timeout so the AI can describe the result honestly.
      visualReadinessTimeout = true;
    }

    // Result metadata — derived from a quick in-page heuristic so the
    // AI can describe what happened without seeing the screenshot
    // bytes (the bytes are user-visible-only, projected away from the
    // AI's context per ai-core's projectForAi). Honest result-shape
    // beats a generic ok:true that lets the AI hallucinate.
    //
    // Heuristics are deliberately coarse — they're a hint, not a
    // verdict. The user's slab still shows the actual pixels; this
    // metadata exists so the AI's text response can be honest about
    // failure modes a human eye recognizes instantly (blank page,
    // bot-block splash, etc.).
    const heuristic = await session.page
      .evaluate(() => {
        const text = (document.body?.innerText ?? "").trim();
        const hasImages = document.querySelectorAll("img").length > 0;
        const hasCanvases = document.querySelectorAll("canvas").length > 0;
        const denied =
          /access denied|forbidden|cloudflare|attention required|just a moment|please verify|are you human|enable\s+javascript/i.test(
            text,
          );
        return {
          textLength: text.length,
          hasImages,
          hasCanvases,
          blankish: text.length < 32 && !hasImages && !hasCanvases,
          denied,
        };
      })
      .catch(() => ({
        textLength: 0,
        hasImages: false,
        hasCanvases: false,
        blankish: true,
        denied: false,
      }));

    // 2026-05-08: capture a screenshot inline as part of the navigate
    // result. Restores the "slab shows the page after navigate" UX
    // the user expects — independent of whether the live-screencast
    // endpoint is deployed (the live stream is additive; this is the
    // synchronous first frame). The bytes are user-visible-only
    // (`@motebit/ai-core`'s `projectForAi` strips them from the AI's
    // context with the same `bytes_omitted` directive that the
    // standalone `screenshot` action uses), so the privacy contract
    // is unchanged. JPEG 60% mirrors the screencast's quality
    // register; PNG is overkill for a navigate snapshot.
    let bytes_base64: string | undefined;
    let image_format: "jpeg" | "png" | undefined;
    let width = 0;
    let height = 0;
    try {
      const buf = await session.page.screenshot({ type: "jpeg", quality: 60, fullPage: false });
      bytes_base64 = Buffer.from(buf).toString("base64");
      image_format = "jpeg";
      const viewport = session.page.viewportSize();
      width = viewport?.width ?? 0;
      height = viewport?.height ?? 0;
    } catch {
      // Capture failure must not break the navigate result — the
      // metadata fields below still let the AI describe what
      // happened. The user's slab falls through to the navigate
      // friendly card without the inline image (still better than
      // raw JSON, since extractScreenshot returns null and the
      // generic renderer takes over).
    }

    return {
      kind: "navigate",
      ok: true,
      url: session.page.url(),
      visual_content_detected: !heuristic.blankish && !heuristic.denied,
      blank_page_detected: heuristic.blankish,
      access_denied_detected: heuristic.denied,
      visual_readiness_timeout: visualReadinessTimeout,
      ...(bytes_base64 !== undefined
        ? { bytes_base64, image_format, width, height, captured_at: Date.now() }
        : {}),
    };
  } catch (err) {
    throw new ServiceError(
      "not_supported",
      `navigate failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ── Slice 2c: user-driven input forwarding ───────────────────────────
//
// Discrete events only — click, key, paste. Wheel and drag are out
// of 2c (POST-per-event can't sustain 50+ events/sec without
// batching; see spec/computer-use-v1.md §5.5). The runtime's
// session manager has already gated this against
// `controlState.kind === "user"` before the wire reaches us; here
// we just dispatch.
//
// Coordinate system: same logical-pixel viewport coordinates the
// motebit-side `click` action uses. The capture surface translates
// CSS rect → logical pixels before posting; we hand them to
// Playwright unchanged.

export async function executeUserInput(
  session: BrowserSession,
  event: UserInputEvent,
): Promise<void> {
  switch (event.kind) {
    case "click": {
      await session.page.mouse.click(event.x, event.y, {
        button: parseButton(event.button),
      });
      session.lastCursorX = event.x;
      session.lastCursorY = event.y;
      return;
    }
    case "key": {
      const { key, modifiers } = event;
      // Any non-shift modifier turns the press into a shortcut combo.
      // Shift alone for "A" / "$" / etc. is still printable input —
      // route through type() so it behaves like character entry.
      const hasNonShiftModifier = modifiers.ctrl || modifiers.meta || modifiers.alt;
      if (hasNonShiftModifier) {
        const parts: string[] = [];
        if (modifiers.meta) parts.push("Meta");
        if (modifiers.ctrl) parts.push("Control");
        if (modifiers.alt) parts.push("Alt");
        if (modifiers.shift) parts.push("Shift");
        parts.push(key);
        await session.page.keyboard.press(parts.join("+"));
        return;
      }
      // No non-shift modifier present.
      if (Array.from(key).length === 1) {
        // Printable single character — type() drives the page through
        // the normal character-entry pipeline (autocomplete, IME,
        // input-event dispatch).
        await session.page.keyboard.type(key);
      } else {
        // Named key (Enter, Tab, Backspace, ArrowUp, F1, …) — press
        // it. Playwright accepts the wire-format names verbatim.
        await session.page.keyboard.press(key);
      }
      return;
    }
    case "paste": {
      // v1 paste-as-type. A future slice may upgrade to CDP
      // `Input.insertText` for true paste semantics (faster on long
      // text, fires `paste` event instead of N keypresses).
      await session.page.keyboard.type(event.text);
      return;
    }
    case "wheel": {
      // Slice 2c-batching — coalesced wheel events. The capture
      // surface samples native WheelEvents at ≤60Hz and sums dx/dy
      // over the window; we receive ONE wire event per ~16ms even
      // under sustained scrolling. Same Playwright primitive as
      // motebit-side `scroll`: anchor the cursor, then dispatch the
      // wheel delta.
      await session.page.mouse.move(event.x, event.y);
      await session.page.mouse.wheel(event.dx, event.dy);
      session.lastCursorX = event.x;
      session.lastCursorY = event.y;
      return;
    }
    case "navigate": {
      // Slice 2d — user-driven navigation from the address bar. The
      // capture surface MUST normalize before forwarding (`example.com`
      // → `https://example.com`); we still defensively re-normalize
      // so a malformed wire input fails honestly here rather than
      // letting Playwright produce a noisier error. Mirrors the regex
      // motebit-side `doNavigate` uses.
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(event.url) ? event.url : `https://${event.url}`;
      try {
        // Single-phase wait. Unlike motebit-side `doNavigate` we don't
        // need the SPA-settle window or in-page heuristics — the
        // screencast surfaces whatever paints, and the user is
        // observing in real time.
        await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
      } catch (err) {
        throw new ServiceError(
          "platform_blocked",
          `navigate failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    // Slice 2e — browser history navigation. Empty-history
    // semantics: page.goBack / goForward return null when there's
    // nothing to navigate to. We treat null as success (no-op) —
    // matches a real browser at the start of its history; the
    // user sees no change, which is the right UX. A thrown error
    // surfaces as platform_blocked.
    case "back": {
      try {
        await session.page.goBack({ waitUntil: "domcontentloaded", timeout: 15_000 });
      } catch (err) {
        throw new ServiceError(
          "platform_blocked",
          `back failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    case "forward": {
      try {
        await session.page.goForward({ waitUntil: "domcontentloaded", timeout: 15_000 });
      } catch (err) {
        throw new ServiceError(
          "platform_blocked",
          `forward failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
    case "reload": {
      try {
        await session.page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
      } catch (err) {
        throw new ServiceError(
          "platform_blocked",
          `reload failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function parseButton(b: string | undefined): "left" | "right" | "middle" {
  return b === "right" ? "right" : b === "middle" ? "middle" : "left";
}

/**
 * Press a key combination by interpreting motebit's wire-format key
 * string. The string is `Mod1+Mod2+Key` shaped (e.g. `"cmd+c"`,
 * `"ctrl+shift+t"`, `"Escape"`). Translation renames motebit-shape
 * modifier tokens (`cmd → Meta`, `ctrl → Control`, `alt → Alt`,
 * `shift → Shift`) and passes the final key through verbatim —
 * Playwright's `keyboard.press` accepts the same `Mod+Key` syntax
 * once the modifier names are translated.
 */
async function pressKeyCombo(page: Page, key: string): Promise<void> {
  const parts = key.includes("+") ? key.split("+") : [key];
  const combo = parts.map(translateKeyToken).join("+");
  await page.keyboard.press(combo);
}

function translateKeyToken(token: string): string {
  const lower = token.toLowerCase();
  // Modifier-shaped token in a combined key — translate it.
  if (lower === "cmd" || lower === "ctrl" || lower === "alt" || lower === "shift") {
    return translateModifier(lower);
  }
  // Single character — pass through verbatim (Playwright accepts both
  // upper and lower case; preserve what the caller sent so audit
  // receipts stay byte-identical to the wire input).
  return token;
}

function translateModifier(m: string): string {
  switch (m.toLowerCase()) {
    case "cmd":
      return "Meta";
    case "ctrl":
      return "Control";
    case "alt":
      return "Alt";
    case "shift":
      return "Shift";
    default:
      // Unknown — pass through verbatim. Playwright rejects unknown
      // modifiers with a Playwright-shaped error, which this layer
      // catches and remaps to `platform_blocked`.
      return m;
  }
}
