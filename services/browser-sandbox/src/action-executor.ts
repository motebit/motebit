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
  ClickElementAction,
  ComputerAction,
  DoubleClickAction,
  DragAction,
  FocusElementAction,
  KeyAction,
  MouseMoveAction,
  NavigateAction,
  ReadPageButton,
  ReadPageInput,
  ReadPageResult,
  ScrollAction,
  TypeAction,
  TypeIntoAction,
  UserInputEvent,
} from "@motebit/protocol";
import type { Page } from "playwright-core";

import type { BrowserSession } from "./chromium-pool.js";
import { ServiceError } from "./errors.js";
import { urlsAreEquivalent } from "./url-equivalence.js";

/**
 * Slice 2h — text bounds for `read_page` results. `text` is the
 * single biggest field; capping at 8KB keeps the AI context
 * reasonable (8KB ≈ 2K tokens vs ~30K for a screenshot). Headings/
 * links are typically tens of entries even on dense pages, but a
 * cap at 100 each defends against pathological cases (huge nav
 * dropdowns, tag clouds).
 */
const READ_PAGE_TEXT_MAX_BYTES = 8 * 1024;
const READ_PAGE_HEADINGS_MAX = 100;
const READ_PAGE_LINKS_MAX = 100;
// element-1 — bounds for the structurally-addressed element arrays
// returned alongside the existing text/headings/links extraction.
// Same conservative shape as headings/links — beyond the cap the AI
// asks for a more targeted observation rather than scrolling
// through a tag cloud.
const READ_PAGE_INPUTS_MAX = 100;
const READ_PAGE_BUTTONS_MAX = 100;
// Cap stored input value display in the read_page response; the AI
// only needs enough to confirm a field's current state. Matches the
// `value` snapshot cap in `doType`.
const READ_PAGE_INPUT_VALUE_MAX_CHARS = 256;
// Server-stamped attribute name for element addressing. The
// extractor walks the DOM, stamps each interactive element with
// `data-motebit-id="motebit-N"`; subsequent click_element /
// focus_element / type_into actions resolve via the same
// attribute. Re-running read_page CLEARS prior stamps and re-
// stamps fresh — ids are scoped to the response that issued them.
const ELEMENT_ID_ATTR = "data-motebit-id";

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
  /**
   * Milliseconds to wait after a frame-stale error before the one-shot
   * retry. ~100ms is enough for Playwright to bind to the new frame
   * after a same-origin redirect (Google's `?zx=…` anti-cache pattern,
   * OAuth round-trips, AJAX URL rewrites). Tests pass 0 for
   * determinism. Doctrine: motebit-computer.md §"Typed truth on
   * results" — `frame_stale` ships with executor enforcement.
   */
  readonly frameStaleRetryDelayMs?: number;
}

/**
 * Detect Playwright's "page navigated underneath the action" error
 * family. Pattern-match on the message because Playwright doesn't
 * export a named error class for these — they're all generic
 * `Error`s with discriminating messages. The four observed patterns:
 *
 *   - "Execution context was destroyed, most likely because of a navigation"
 *   - "frame was detached" / "Frame was detached"
 *   - "Target closed" / "Target page, context or browser has been closed"
 *   - "frame not attached" (transient subframe state)
 *
 * Capture is conservative — extra patterns silently fall through to
 * the route's general `platform_blocked` envelope, preserving the
 * existing failure mode rather than silently mis-classifying an
 * unrelated error as `frame_stale`.
 */
function isFrameStaleError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  return (
    msg.includes("Execution context was destroyed") ||
    msg.includes("frame was detached") ||
    msg.includes("Frame was detached") ||
    msg.includes("Target closed") ||
    msg.includes("Target page, context or browser has been closed") ||
    msg.includes("frame not attached")
  );
}

function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

/**
 * Execute one `ComputerAction`. Wraps the dispatch switch with a
 * one-shot retry on frame-stale errors — the most common failure
 * mode on real-world pages (Google's anti-cache redirect, OAuth
 * round-trips, SPA navigations during a click/type). If the retry
 * also catches a stale frame, surfaces `ServiceError("frame_stale")`
 * so the dispatcher's reason taxonomy stays closed and the AI sees a
 * typed-truth-perception field instead of an opaque 500.
 *
 * Before this wrapper, frame-stale errors fell through the route's
 * global error handler into `platform_blocked` (HTTP 500) — the AI
 * received "the platform is blocking key presses" prose for what
 * was actually a recoverable redirect race. Doctrine:
 * motebit-computer.md §"Typed truth on results."
 */
export async function executeAction(
  session: BrowserSession,
  action: ComputerAction,
  deps: ActionExecutorDeps = {},
): Promise<ActionResult> {
  try {
    return await dispatchAction(session, action, deps);
  } catch (err: unknown) {
    if (!isFrameStaleError(err)) throw err;
    // First attempt caught a stale frame. Wait briefly for Playwright
    // to bind to the new frame after the navigation race, then retry
    // once. This recovers transient redirects (Google's `?zx=…`
    // anti-cache, OAuth, AJAX URL rewrites) without the AI seeing the
    // race.
    await delay(deps.frameStaleRetryDelayMs ?? 100);
    try {
      return await dispatchAction(session, action, deps);
    } catch (retryErr: unknown) {
      if (!isFrameStaleError(retryErr)) throw retryErr;
      // Even the retry caught a stale frame — the page is moving
      // faster than the executor can bind. Surface as the typed
      // `frame_stale` reason so the AI sees a specific failure mode
      // instead of an opaque `platform_blocked`. The PERCEPTION_
      // DOCTRINE clause teaches the AI to re-read the page state
      // rather than verbally interpret this as "platform is
      // blocking."
      throw new ServiceError(
        "frame_stale",
        "Page navigated underneath the action; the one-shot retry also caught a stale frame. Re-read the current page state before retrying.",
      );
    }
  }
}

async function dispatchAction(
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
    case "click_element":
      return doClickElement(session, action);
    case "focus_element":
      return doFocusElement(session, action);
    case "type_into":
      return doTypeInto(session, action);
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
  // Typed-truth `navigation_triggered`: capture URL before + after so
  // coordinate clicks on submit buttons report whether the page
  // actually moved. Same shape `doClickElement` + `doKey` ship for
  // their respective paths — closes the parallel confabulation gap
  // where coordinate-based click on a submit element returned ok:true
  // but the form didn't submit (overlay intercept, bot detection
  // silently dropping). The AI reads false and surfaces the truth
  // instead of claiming "Done."
  const beforeUrl = session.page.url();
  await session.page.mouse.click(action.target.x, action.target.y, {
    button: parseButton(action.button),
  });
  session.lastCursorX = action.target.x;
  session.lastCursorY = action.target.y;
  const afterUrl = session.page.url();
  return { kind: "click", ok: true, navigation_triggered: beforeUrl !== afterUrl };
}

async function doDoubleClick(
  session: BrowserSession,
  action: DoubleClickAction,
): Promise<ActionResult> {
  // Sibling of doClick — same `navigation_triggered` capture so
  // double-clicks on submit / link elements report navigation truth.
  const beforeUrl = session.page.url();
  await session.page.mouse.dblclick(action.target.x, action.target.y, {
    button: parseButton(action.button),
  });
  session.lastCursorX = action.target.x;
  session.lastCursorY = action.target.y;
  const afterUrl = session.page.url();
  return { kind: "double_click", ok: true, navigation_triggered: beforeUrl !== afterUrl };
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

/**
 * Type-action truth feedback — closes the action-truth gap witnessed
 * 2026-05-08: AI called `type("motebit")` and reported "typed it" but
 * nothing appeared in the search box. Playwright's
 * `page.keyboard.type()` fires keystrokes to whatever element has
 * focus right now — body, address bar, anywhere — and returns
 * success because the keystroke API itself succeeded. The "typed
 * it" claim was technically true (keystrokes fired) but
 * semantically false (nothing landed in a target field).
 *
 * Same hallucination class as the other typed-truth slices:
 *   - bytes_omitted_reason for pixel gates (vision-1)
 *   - structured ToolResult.reason for `not_in_control` (Slice 2g)
 *   - [Now] block for runtime state (prompt-1)
 *   - browser URL for prior-page memory (chrome-1a-fix)
 *
 * Pattern: tool result carries semantic-intent truth, not just
 * API-call truth. The AI reads typed feedback and routes
 * accordingly. PERCEPTION_DOCTRINE extends to teach the AI:
 * "if `type` returns `text_appeared: false`, the keystrokes were
 * swallowed — click the target field first."
 *
 * The truth-snapshot runs in-page (Playwright `evaluate`) and
 * checks:
 *   - `focused`: is `document.activeElement` a typeable element
 *     (input / textarea / contenteditable)?
 *   - `active_element`: tag name (for AI context — body means
 *     focus is unset, input/textarea means a field caught it)
 *   - `value`: the current value of the focused field after the
 *     type call (the actual target-field state)
 *   - `text_appeared`: derived — did the typed text end up in the
 *     value? (focused AND value contains text)
 *
 * Backward compatibility — extends the `kind: "type"` result with
 * additive fields. Older callers that only read `ok` keep working;
 * AI-side perception doctrine reads the new fields.
 */
async function doType(session: BrowserSession, action: TypeAction): Promise<ActionResult> {
  await session.page.keyboard.type(action.text, { delay: action.per_char_delay_ms });
  // Truth-snapshot AFTER the type. The browser-sandbox runs this
  // in-page evaluator; the action result carries the structured
  // outcome back to the runtime, which threads it into the AI's
  // tool result.
  const snapshot = await session.page.evaluate((typedText: string) => {
    const el = document.activeElement;
    if (!el || el === document.body) {
      return { focused: false, active_element: "body", value: "", text_appeared: false };
    }
    const tag = el.tagName.toLowerCase();
    const isInput = tag === "input" || tag === "textarea";
    const isContentEditable = (el as HTMLElement).isContentEditable === true;
    if (!isInput && !isContentEditable) {
      // Focus is on a non-typeable element (e.g. button, link,
      // div). Keystrokes went to that element's keydown handler
      // but no value-bearing field was the target.
      return { focused: false, active_element: tag, value: "", text_appeared: false };
    }
    const rawValue = isInput
      ? ((el as HTMLInputElement | HTMLTextAreaElement).value ?? "")
      : ((el as HTMLElement).textContent ?? "");
    return {
      focused: true,
      active_element: tag,
      // Cap the value to a reasonable size — large textareas
      // shouldn't pollute tool results. The AI only needs to
      // verify the typed text landed.
      value: rawValue.length > 512 ? rawValue.slice(0, 512) : rawValue,
      text_appeared: rawValue.includes(typedText),
    };
  }, action.text);
  // Typed-truth recovery hint — when text_appeared is false, the
  // canonical recovery is read_page → type_into, NOT coordinate
  // click + retype (which is prone to the same focus race that
  // dropped the original keystrokes). Surface the hint so the AI's
  // natural next step is the durable element-addressed path.
  //
  // Witnessed bug 2026-05-12: AI typed via coordinate `type`, saw
  // `text_appeared: false`, narrated "Clicking it first, then typing.
  // Done." — the coordinate-based remediation hit the same focus
  // race and the search field stayed empty. The hint converts the
  // doctrine teaching "click + retype" into a typed-truth field the
  // AI reads instead of inferring from the failure shape.
  //
  // Doctrine: docs/doctrine/runtime-invariants-over-prompt-rules.md
  // § the typed-truth-perception triple — the wire field carries the
  // recovery path; the prompt teaches reading it.
  const recovery_hint = !snapshot.text_appeared ? "read_page_then_type_into" : undefined;
  return {
    kind: "type",
    ok: true,
    ...snapshot,
    ...(recovery_hint !== undefined ? { recovery_hint } : {}),
  };
}

async function doKey(session: BrowserSession, action: KeyAction): Promise<ActionResult> {
  // The wire format encodes modifiers inside the `key` string itself
  // (e.g. `"cmd+c"`, `"ctrl+shift+t"`, `"Escape"`). No separate
  // modifier list — the translator splits + renames + rejoins.
  //
  // Typed-truth `navigation_triggered`: capture URL before + after so
  // form-submission via key("Enter") reports whether the page
  // actually moved. Same shape `doClickElement` ships for the click
  // path. When false, the keystroke fired but no navigation happened
  // — the AI shouldn't claim "submitted" / "done" until it reads the
  // post-state. Witnessed bug 2026-05-12: AI pressed Enter on the
  // Google search input, got `ok: true`, said "Done" — but the form
  // didn't submit (Google's promo overlay intercepted) and the page
  // stayed on the homepage. The wire field carries the truth; the
  // prompt teaches reading it.
  const beforeUrl = session.page.url();
  await pressKeyCombo(session.page, action.key);
  const afterUrl = session.page.url();
  return { kind: "key", ok: true, navigation_triggered: beforeUrl !== afterUrl };
}

async function doScroll(session: BrowserSession, action: ScrollAction): Promise<ActionResult> {
  await session.page.mouse.move(action.target.x, action.target.y);
  await session.page.mouse.wheel(action.dx, action.dy);
  session.lastCursorX = action.target.x;
  session.lastCursorY = action.target.y;
  return { kind: "scroll", ok: true };
}

/**
 * Derive the `visual_content_detected` typed-truth field from the
 * navigate-result heuristic flags. Exported so the unit test can pin
 * the derivation and the typed-truth-perception drift gate's class
 * coverage stays coherent.
 *
 * Invariant: `visual_content_detected: false` ≡ `(blankish || denied
 * || botDetection)`. The three RHS flags each have their own
 * dishonesty-class typed-truth field (`blank_page_detected`,
 * `access_denied_detected`, `bot_detection_detected`) — all three
 * are intercepted by the runtime in `dishonest-closing.ts`.
 *
 * Why this invariant matters: `visual_content_detected` is registered
 * as positive-signal-class in `check-typed-truth-perception.ts` (the
 * model SHOULD claim "I see X" when true). Its dishonest negation
 * (model claims "I see X" when false) is NOT separately intercepted
 * because the derivation guarantees one of the three sibling fields
 * is true in that case, and those siblings ARE intercepted. A future
 * regression that breaks the derivation (e.g. someone changes the
 * heuristic to add a new failure mode without folding it into the
 * derivation) would silently re-open the dishonesty surface — the
 * test exists to catch exactly that.
 *
 * Doctrine: `runtime-invariants-over-prompt-rules.md` § typed-truth-
 * perception triple. Sibling-boundary rule: when one boundary is
 * fixed, the test pins all sibling boundaries in the same pass.
 */
export function deriveVisualContentDetected(heuristic: {
  readonly blankish: boolean;
  readonly denied: boolean;
  readonly botDetection: boolean;
}): boolean {
  return !heuristic.blankish && !heuristic.denied && !heuristic.botDetection;
}

async function doNavigate(session: BrowserSession, action: NavigateAction): Promise<ActionResult> {
  // Normalize relative-looking inputs (`example.com`, `tesla.com/about`)
  // into absolute URLs. Per spec: implementations SHOULD normalize but
  // MAY reject malformed inputs with `not_supported`. The test for
  // "looks absolute" is presence of a scheme — anything else is treated
  // as a hostname-leading path and prefixed with `https://`.
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(action.url) ? action.url : `https://${action.url}`;

  // Surface-determinism defense at the dispatch layer. The prompt
  // rule in PERCEPTION_DOCTRINE teaches the AI to read the [Now]
  // block's browser line and skip request_control + navigate when
  // the page is already at the requested URL. This is the
  // belt-and-suspenders guard if the AI ignores the rule (or
  // doesn't see [Now] freshly enough): we short-circuit the goto
  // here, return the same envelope shape with `already_there: true`,
  // and skip the screenshot capture. Same fail-closed structural
  // floor as `not_in_control` — the runtime is mechanical; the
  // prompt is the ergonomics. Re-navigating to the URL the page
  // is already on triggered a control-request prompt, a "waiting
  // for first frame" reset on the slab, and a redundant render —
  // all friction for zero outcome change. If the equivalence
  // semantics here change, update the prompt bullet that
  // `urlsAreEquivalent` cross-references.
  //
  // Cold sessions sit at `about:blank`; the protocol/host/scheme
  // mismatch returns false from `urlsAreEquivalent` so the first
  // navigate runs as a real goto. Explicit re-fetch is the user's
  // "reload" / "refresh" verb (a separate path the AI is taught
  // about in the same doctrine bullet).
  if (urlsAreEquivalent(url, session.page.url())) {
    return {
      kind: "navigate",
      ok: true,
      url: session.page.url(),
      visual_content_detected: true,
      blank_page_detected: false,
      access_denied_detected: false,
      visual_readiness_timeout: false,
      slow_load: false,
      already_there: true,
    };
  }

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
    // 2026-05-09: don't fail-fast when goto's readiness signal times
    // out. The 15s timeout is the DOMContentLoaded ceiling, not the
    // navigation's actual outcome — heavy SPAs (nba.com, news sites
    // with many preconnects, anything behind a slow CDN) commonly
    // commit the navigation, paint partial content, and would finish
    // a few seconds later. Throwing here told the AI "the page didn't
    // load" while the user's slab kept streaming frames showing it
    // had loaded fine.
    //
    // Repro Daniel surfaced: nba.com timed out → AI said "timed out,
    // too heavy" → seconds later the slab showed nba.com fully
    // rendered. Then google.com hit the same pattern — AI said
    // "didn't load" while the slab clearly showed Google's homepage.
    //
    // The honest fail-faster intent stays: still 15s ceiling on goto.
    // What changes is what we do at the ceiling — fall through to the
    // heuristic + capture path so the AI's description matches what
    // the slab is showing. Mark `slow_load: true` so the AI can hedge
    // ("loading took longer than expected" rather than asserting
    // success). Non-timeout errors (ERR_NAME_NOT_RESOLVED,
    // ERR_CONNECTION_REFUSED) still propagate as real failures.
    let slowLoad = false;
    try {
      await session.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
    } catch (gotoErr) {
      const message = gotoErr instanceof Error ? gotoErr.message : String(gotoErr);
      if (!/timeout|TimeoutError/i.test(message)) {
        throw gotoErr;
      }
      slowLoad = true;
    }
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
        // Bot-detection wall — the page rendered, no hard denial, but
        // the gatekeeper is challenging the session as bot-shaped
        // (reCAPTCHA, hCaptcha, Cloudflare Turnstile, Google's
        // "unusual traffic" page). Distinct from `denied`: the page
        // isn't blocked outright; the user (or motebit) is being
        // asked to PROVE humanness. Distinct recovery: for search
        // intent, fall back to web_search (the API tier); for
        // navigation/site-interaction intent, hand off to the user.
        //
        // URL check catches Google's anti-bot redirect (sorry/index)
        // and similar challenge-frame URLs that don't always carry
        // the challenge text in the body (it's iframe'd in). Body
        // check catches the visible challenge prompts on pages that
        // render the challenge inline.
        const url = location.href;
        const urlBot =
          /\/sorry\/index|\/sorry\/?\?|google\.com\/sorry|recaptcha|challenges\.cloudflare|\/cdn-cgi\/challenge-platform|hcaptcha\.com/i.test(
            url,
          );
        const bodyBot =
          /i['']?m not a robot|i am not a robot|recaptcha|unusual traffic|verify you are human|why did this happen\?|hcaptcha|cloudflare turnstile|complete the security check|prove you('re| are) human|please confirm you are not a robot/i.test(
            text,
          );
        const botDetection = urlBot || bodyBot;
        return {
          textLength: text.length,
          hasImages,
          hasCanvases,
          blankish: text.length < 32 && !hasImages && !hasCanvases,
          denied,
          botDetection,
        };
      })
      .catch(() => ({
        textLength: 0,
        hasImages: false,
        hasCanvases: false,
        blankish: true,
        denied: false,
        botDetection: false,
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
      visual_content_detected: deriveVisualContentDetected(heuristic),
      blank_page_detected: heuristic.blankish,
      access_denied_detected: heuristic.denied,
      // Typed-truth-perception sibling of access_denied_detected.
      // Sibling because the recovery differs: denied → can't see
      // page, try elsewhere; bot_detection → challenge presented,
      // recovery depends on intent (search → web_search fallback,
      // site-interaction → user handoff). The prompt's PERCEPTION_
      // DOCTRINE teaches the recovery path. Doctrine: motebit-
      // computer.md §"Typed truth on results" + the runtime-
      // invariants-over-prompt-rules doctrine — this is the typed
      // structural fix that replaces a prompt-only "fall back when
      // CAPTCHA" rule with a wire field the AI reads.
      bot_detection_detected: heuristic.botDetection,
      visual_readiness_timeout: visualReadinessTimeout,
      slow_load: slowLoad,
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

// ── Slice 2h: ax-tier `read_page` ─────────────────────────────────────
//
// Returns DOM-derived structured text — page title, body innerText
// (truncated to keep AI context tractable), heading hierarchy in
// document order, visible links with absolute hrefs. No pixels, no
// screenshot bytes. The first tool that fills the documented `ax`
// tier of the hybrid-engine cost hierarchy.
//
// All extraction happens in-page via `page.evaluate` so no DOM
// shape leaks across the Node/Chromium boundary as raw nodes —
// only the serialized result. Bounded sizes defend the AI context
// against pathological pages (huge nav dropdowns, tag clouds).

/**
 * In-page DOM extractor for `executeReadPage`. Top-level + exported so
 * it can be unit-tested under jsdom (which provides `document`,
 * `location`, `Blob`) without a real Chromium roundtrip. When passed
 * to `page.evaluate`, Playwright serializes the function by name and
 * runs the SAME code inside the Chromium context — one
 * implementation, two runtimes.
 *
 * Self-contained by construction: no closure references, no module
 * imports, only browser globals (`document`, `location`, `Blob`).
 * That's what makes Playwright's serialization work and what makes
 * jsdom mocking work.
 */
export function extractStructuredPageContent(opts: {
  readonly textMaxBytes: number;
  readonly headingsMax: number;
  readonly linksMax: number;
  readonly inputsMax: number;
  readonly buttonsMax: number;
  readonly inputValueMaxChars: number;
  readonly elementIdAttr: string;
}): {
  url: string;
  title: string;
  text: string;
  text_truncated: boolean;
  headings: Array<{ level: number; text: string }>;
  links: Array<{ text: string; href: string }>;
  inputs: Array<{
    element_id: string;
    tag: "input" | "textarea";
    input_type: string;
    name?: string;
    placeholder?: string;
    aria_label?: string;
    value?: string;
  }>;
  buttons: Array<{
    element_id: string;
    tag: "button" | "input" | "a";
    text: string;
    input_type?: string;
  }>;
  submit_button_id?: string;
} {
  const {
    textMaxBytes,
    headingsMax,
    linksMax,
    inputsMax,
    buttonsMax,
    inputValueMaxChars,
    elementIdAttr,
  } = opts;
  const titleRaw = document.title || "";
  const bodyRaw = (document.body?.innerText ?? "").trim();

  // Truncate body text by byte length (UTF-8 approximate via
  // Blob since TextEncoder may not be uniformly available in
  // every Chromium evaluator context). Falls back to char-count
  // truncation when Blob is unavailable.
  const bytesOf = (s: string): number => {
    try {
      return new Blob([s]).size;
    } catch {
      return s.length;
    }
  };
  let textTruncated = false;
  let body = bodyRaw;
  if (bytesOf(body) > textMaxBytes) {
    // Bisect to find the largest prefix under the cap.
    let lo = 0;
    let hi = body.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi + 1) / 2);
      if (bytesOf(body.slice(0, mid)) <= textMaxBytes) lo = mid;
      else hi = mid - 1;
    }
    body = body.slice(0, lo);
    textTruncated = true;
  }

  // Heading hierarchy in document order.
  const headingNodes = Array.from(document.querySelectorAll("h1, h2, h3, h4, h5, h6"));
  const headings: Array<{ level: number; text: string }> = [];
  for (const node of headingNodes.slice(0, headingsMax)) {
    const level = Number(node.tagName.slice(1));
    const text = (node as HTMLElement).innerText.trim();
    if (text.length > 0) headings.push({ level, text });
  }

  // Visible links with absolute hrefs. Skip empty text, fragment-
  // only hrefs, and javascript: URLs (which the AI can't navigate
  // to anyway). The fragment check reads the RAW `href` attribute —
  // `anchor.href` returns the resolved absolute URL, so a
  // `<a href="#section">` resolves to
  // `https://current.page/path#section` and would defeat a
  // `startsWith("#")` probe on the resolved form.
  const linkNodes = Array.from(document.querySelectorAll("a[href]"));
  const links: Array<{ text: string; href: string }> = [];
  for (const node of linkNodes) {
    if (links.length >= linksMax) break;
    const anchor = node as HTMLAnchorElement;
    const text = anchor.innerText.trim();
    const rawHref = anchor.getAttribute("href") ?? "";
    const href = anchor.href;
    if (text.length === 0) continue;
    if (!href || href.startsWith("javascript:")) continue;
    if (rawHref.startsWith("#")) continue;
    links.push({ text, href });
  }

  // element-1 — extract typeable inputs and button-shaped clickable
  // elements with stamped `data-motebit-id` attributes for
  // structural addressing.
  //
  // Stamp policy: clear ALL existing stamps first (a previous
  // read_page may have stamped elements that have since changed
  // state), then walk the DOM in document order and stamp fresh
  // ids. Per-extraction counter keeps the namespace stable within
  // a single response.
  //
  // Element selection — be inclusive on inputs (any text-shaped
  // input the user might type into) and conservative on buttons
  // (only things the user would visually identify as a button:
  // <button>, <input type="submit/button/reset">). <a> tags with
  // role="button" or button-shaped aria patterns can be addressed
  // via `links` (their href flow). Avoiding double-counting <a>
  // here keeps the AI's mental model clean.
  const stamped = document.querySelectorAll(`[${elementIdAttr}]`);
  for (const el of Array.from(stamped)) {
    el.removeAttribute(elementIdAttr);
  }
  let elementCounter = 0;
  const stamp = (el: Element): string => {
    const id = `motebit-${elementCounter++}`;
    el.setAttribute(elementIdAttr, id);
    return id;
  };

  // Typeable inputs — text/search/email/url/tel/number/password
  // <input> types plus <textarea>. Skip hidden, disabled, or
  // readonly fields (the AI can't usefully type into them).
  const TYPEABLE_INPUT_TYPES = new Set([
    "text",
    "search",
    "email",
    "url",
    "tel",
    "number",
    "password",
    "", // <input> with no type defaults to "text"
  ]);
  const inputNodes = Array.from(document.querySelectorAll("input, textarea"));
  const inputs: Array<{
    element_id: string;
    tag: "input" | "textarea";
    input_type: string;
    name?: string;
    placeholder?: string;
    aria_label?: string;
    value?: string;
  }> = [];
  for (const node of inputNodes) {
    if (inputs.length >= inputsMax) break;
    const tag = node.tagName.toLowerCase() as "input" | "textarea";
    const inputEl = node as HTMLInputElement | HTMLTextAreaElement;
    if (inputEl.disabled || inputEl.readOnly) continue;
    if ((inputEl as HTMLElement).hidden === true) continue;
    let inputType: string;
    if (tag === "textarea") {
      inputType = "textarea";
    } else {
      const t = ((inputEl as HTMLInputElement).type ?? "").toLowerCase();
      if (!TYPEABLE_INPUT_TYPES.has(t)) continue;
      inputType = t === "" ? "text" : t;
    }
    // Skip elements with zero render size — likely hidden via CSS.
    // getBoundingClientRect() in jsdom returns 0 dimensions for
    // every element; defense-in-depth so production behavior
    // matches but tests still see all stamped elements.
    const rect = node.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0;
    // Allow zero-size only if jsdom (test env) — production
    // Chromium's render geometry is real.
    const inJsdom = typeof window !== "undefined" && navigator.userAgent.includes("jsdom");
    if (!visible && !inJsdom) continue;
    const id = stamp(node);
    const name = (inputEl.name ?? "").trim();
    const placeholder = (inputEl.placeholder ?? "").trim();
    const ariaLabel = (node.getAttribute("aria-label") ?? "").trim();
    const rawValue = inputEl.value ?? "";
    const value =
      rawValue.length > inputValueMaxChars ? rawValue.slice(0, inputValueMaxChars) : rawValue;
    inputs.push({
      element_id: id,
      tag,
      input_type: inputType,
      ...(name.length > 0 ? { name } : {}),
      ...(placeholder.length > 0 ? { placeholder } : {}),
      ...(ariaLabel.length > 0 ? { aria_label: ariaLabel } : {}),
      ...(value.length > 0 ? { value } : {}),
    });
  }

  // Button-shaped clickables. Includes <button>, <input
  // type="submit/button/reset">. Anchors styled as buttons stay
  // in `links`.
  const BUTTON_INPUT_TYPES = new Set(["submit", "button", "reset"]);
  const buttonNodes = Array.from(
    document.querySelectorAll(
      "button, input[type='submit'], input[type='button'], input[type='reset']",
    ),
  );
  const buttons: Array<{
    element_id: string;
    tag: "button" | "input" | "a";
    text: string;
    input_type?: string;
  }> = [];
  for (const node of buttonNodes) {
    if (buttons.length >= buttonsMax) break;
    const tag = node.tagName.toLowerCase() as "button" | "input";
    const el = node as HTMLButtonElement | HTMLInputElement;
    if (el.disabled) continue;
    if ((el as HTMLElement).hidden === true) continue;
    const rect = node.getBoundingClientRect();
    const visible = rect.width > 0 && rect.height > 0;
    const inJsdom = typeof window !== "undefined" && navigator.userAgent.includes("jsdom");
    if (!visible && !inJsdom) continue;
    let text = "";
    let inputType: string | undefined;
    if (tag === "button") {
      text = (el as HTMLButtonElement).innerText.trim();
    } else {
      const t = ((el as HTMLInputElement).type ?? "").toLowerCase();
      if (!BUTTON_INPUT_TYPES.has(t)) continue;
      inputType = t;
      text = ((el as HTMLInputElement).value ?? "").trim();
    }
    if (text.length === 0) {
      // Fall back to aria-label when the button has no visible
      // text (icon-only buttons commonly do this).
      text = (node.getAttribute("aria-label") ?? "").trim();
    }
    if (text.length === 0) continue;
    const id = stamp(node);
    buttons.push({
      element_id: id,
      tag,
      text,
      ...(inputType ? { input_type: inputType } : {}),
    });
  }

  // Typed-truth submit-button detection. Two-tier signal: HTML semantic
  // first (input_type === "submit" is the browser's own statement that
  // the element submits a form), label heuristic as fallback. Lowercase
  // whole-label-or-prefix match against a curated submit-class word set
  // — kept conservative on purpose so a false-confident hint on a
  // non-submit "Send" button (e.g. a contact-icon UI) costs at most one
  // no-op click. Doctrine:
  // `docs/doctrine/runtime-invariants-over-prompt-rules.md` — the
  // wire-field replacement for the prompt's prior click_element-over-
  // key("Enter") teaching, now gated by typed-truth-perception.
  const SUBMIT_LABEL_WORDS = [
    "search",
    "submit",
    "send",
    "sign in",
    "log in",
    "login",
    "continue",
    "go",
    "subscribe",
    "next",
    "save",
    "post",
  ];
  let submitButtonId: string | undefined;
  // Pass 1: HTML semantic — first `input_type === "submit"` wins.
  for (const b of buttons) {
    if (b.input_type === "submit") {
      submitButtonId = b.element_id;
      break;
    }
  }
  // Pass 2: label heuristic — first label that matches a submit-class
  // word (whole-label-or-prefix match) wins. Skipped when Pass 1 fired.
  if (!submitButtonId) {
    for (const b of buttons) {
      const label = b.text.trim().toLowerCase();
      if (label.length === 0) continue;
      // Whole-label match (label === word) OR prefix match where the
      // remainder is a space-delimited suffix ("Search Google" matches
      // "search"). Word-boundary discipline keeps "Reset" from matching
      // "Subscribe" or other coincidental prefixes.
      if (SUBMIT_LABEL_WORDS.some((w) => label === w || label.startsWith(`${w} `))) {
        submitButtonId = b.element_id;
        break;
      }
    }
  }

  return {
    url: location.href,
    title: titleRaw,
    text: body,
    text_truncated: textTruncated,
    headings,
    links,
    inputs,
    buttons,
    ...(submitButtonId ? { submit_button_id: submitButtonId } : {}),
  };
}

export async function executeReadPage(session: BrowserSession): Promise<ReadPageResult> {
  // Playwright serializes the named function and runs it inside the
  // Chromium context. The same function runs under jsdom in unit
  // tests, so the in-page logic is honestly covered without a real-
  // browser harness. Returns plain JSON-serializable data; no node
  // references cross the bridge.
  const extracted = await session.page.evaluate(extractStructuredPageContent, {
    textMaxBytes: READ_PAGE_TEXT_MAX_BYTES,
    headingsMax: READ_PAGE_HEADINGS_MAX,
    linksMax: READ_PAGE_LINKS_MAX,
    inputsMax: READ_PAGE_INPUTS_MAX,
    buttonsMax: READ_PAGE_BUTTONS_MAX,
    inputValueMaxChars: READ_PAGE_INPUT_VALUE_MAX_CHARS,
    elementIdAttr: ELEMENT_ID_ATTR,
  });

  return {
    kind: "read_page",
    session_id: session.sessionId,
    url: extracted.url,
    title: extracted.title,
    text: extracted.text,
    text_truncated: extracted.text_truncated,
    headings: extracted.headings,
    links: extracted.links,
    inputs: extracted.inputs as ReadonlyArray<ReadPageInput>,
    buttons: extracted.buttons as ReadonlyArray<ReadPageButton>,
    ...(extracted.submit_button_id ? { submit_button_id: extracted.submit_button_id } : {}),
    extracted_at: Date.now(),
  };
}

// ── element-1: structurally-addressed actions ────────────────────────
//
// `click_element`, `focus_element`, `type_into` resolve a server-
// stamped `data-motebit-id` attribute (issued by the most recent
// `read_page` extraction) and act on the resolved element. Durable
// against viewport / zoom / layout shifts in a way that coordinate-
// based click/type isn't.
//
// All three return the standard `{kind, ok}` envelope with truth-
// feedback fields (`focused_typeable` / `text_appeared` / `value`)
// that close the action-truth gap. On staleness — page navigated
// since read_page, page reloaded, element removed by JS — the
// element is not found and the action returns `ok: false, reason:
// "element_not_found"` so the AI re-reads to refresh the id space.
//
// Why server-resolution rather than the AI passing CSS selectors:
//   - Opaque ids prevent the AI from synthesizing brittle/exotic
//     selectors and from being prompted to produce them.
//   - The AI never sees the page's structural details (class names,
//     unstable framework-generated ids); only the server-issued
//     namespace.
//   - Selector matching becomes a server concern — exact attribute
//     match. Trivial, fast, no false positives.

function elementSelector(elementId: string): string {
  // Defensive escape — only ascii alphanumeric + hyphen are
  // legal in our stamps (`motebit-N`); reject anything else
  // before constructing the selector.
  if (!/^[a-zA-Z0-9_-]+$/.test(elementId)) {
    throw new ServiceError("not_supported", `invalid element_id: ${elementId}`);
  }
  return `[${ELEMENT_ID_ATTR}="${elementId}"]`;
}

/**
 * In-page snapshot for `click_element` truth feedback. Top-level +
 * exported so it can be unit-tested under jsdom directly. Same
 * one-implementation-two-runtimes pattern as
 * `extractStructuredPageContent`.
 */
export function clickElementTruth(opts: { selector: string }): {
  clicked_tag: string | null;
  focused_typeable: boolean;
} {
  const el = document.querySelector(opts.selector);
  const active = document.activeElement;
  return {
    clicked_tag: el?.tagName.toLowerCase() ?? null,
    focused_typeable: !!(
      active &&
      (active.tagName === "INPUT" ||
        active.tagName === "TEXTAREA" ||
        (active as HTMLElement).isContentEditable)
    ),
  };
}

/** In-page snapshot for `focus_element` truth feedback. */
export function focusElementTruth(opts: { selector: string }): {
  tag: string | null;
  focused: boolean;
} {
  const el = document.querySelector(opts.selector);
  return {
    tag: el?.tagName.toLowerCase() ?? null,
    focused: document.activeElement === el,
  };
}

/**
 * In-page snapshot for `type_into` truth feedback. Same shape as
 * `doType`'s in-line snapshot but addressed by selector — used by
 * `type_into` to verify the typed text landed in the addressed
 * element specifically (rather than wherever focus happened to be).
 */
export function typeIntoTruth(opts: { selector: string; typedText: string }): {
  focused: boolean;
  active_element: string;
  value: string;
  text_appeared: boolean;
} {
  const el = document.querySelector(opts.selector);
  if (!el) {
    return { focused: false, active_element: "none", value: "", text_appeared: false };
  }
  const tag = el.tagName.toLowerCase();
  const isInput = tag === "input" || tag === "textarea";
  const isContentEditable = (el as HTMLElement).isContentEditable === true;
  if (!isInput && !isContentEditable) {
    return { focused: false, active_element: tag, value: "", text_appeared: false };
  }
  const rawValue = isInput
    ? ((el as HTMLInputElement | HTMLTextAreaElement).value ?? "")
    : ((el as HTMLElement).textContent ?? "");
  const focused = document.activeElement === el;
  return {
    focused,
    active_element: tag,
    value: rawValue.length > 512 ? rawValue.slice(0, 512) : rawValue,
    text_appeared: rawValue.includes(opts.typedText),
  };
}

async function doClickElement(
  session: BrowserSession,
  action: ClickElementAction,
): Promise<ActionResult> {
  const selector = elementSelector(action.element_id);
  const locator = session.page.locator(selector);
  const count = await locator.count();
  if (count === 0) {
    return {
      kind: "click_element",
      ok: false,
      reason: "element_not_found",
      message: `element_id "${action.element_id}" not found — page may have navigated. Re-read with read_page.`,
    };
  }
  await locator.first().scrollIntoViewIfNeeded({ timeout: 5_000 });
  const beforeUrl = session.page.url();
  await locator.first().click({ timeout: 10_000 });
  const truth = await session.page.evaluate(clickElementTruth, { selector });
  const afterUrl = session.page.url();
  return {
    kind: "click_element",
    ok: true,
    clicked_tag: truth.clicked_tag,
    focused_typeable: truth.focused_typeable,
    navigation_triggered: beforeUrl !== afterUrl,
  };
}

async function doFocusElement(
  session: BrowserSession,
  action: FocusElementAction,
): Promise<ActionResult> {
  const selector = elementSelector(action.element_id);
  const locator = session.page.locator(selector);
  const count = await locator.count();
  if (count === 0) {
    return {
      kind: "focus_element",
      ok: false,
      reason: "element_not_found",
      message: `element_id "${action.element_id}" not found — page may have navigated. Re-read with read_page.`,
    };
  }
  await locator.first().scrollIntoViewIfNeeded({ timeout: 5_000 });
  await locator.first().focus({ timeout: 5_000 });
  const truth = await session.page.evaluate(focusElementTruth, { selector });
  return {
    kind: "focus_element",
    ok: true,
    tag: truth.tag,
    focused: truth.focused,
  };
}

async function doTypeInto(session: BrowserSession, action: TypeIntoAction): Promise<ActionResult> {
  const selector = elementSelector(action.element_id);
  const locator = session.page.locator(selector);
  const count = await locator.count();
  if (count === 0) {
    return {
      kind: "type_into",
      ok: false,
      reason: "element_not_found",
      message: `element_id "${action.element_id}" not found — page may have navigated. Re-read with read_page.`,
    };
  }
  await locator.first().scrollIntoViewIfNeeded({ timeout: 5_000 });
  await locator.first().focus({ timeout: 5_000 });
  const clearFirst = action.clear_first !== false;
  if (clearFirst) {
    // Select-all + delete is more reliable than .fill("") which
    // some frameworks intercept. ControlOrMeta maps to the platform-
    // correct modifier (Cmd on macOS, Ctrl elsewhere).
    await session.page.keyboard.press("ControlOrMeta+a");
    await session.page.keyboard.press("Delete");
  }
  await session.page.keyboard.type(action.text, { delay: action.per_char_delay_ms });
  const snapshot = await session.page.evaluate(typeIntoTruth, {
    selector,
    typedText: action.text,
  });
  return { kind: "type_into", ok: true, ...snapshot };
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
