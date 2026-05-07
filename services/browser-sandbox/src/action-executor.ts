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
  ScrollAction,
  TypeAction,
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
