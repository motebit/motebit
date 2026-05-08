/**
 * Co-browse Slice 2d — user-side address bar for the cloud Chromium.
 *
 * When `controlState.kind === "user"`, the user can type a URL into
 * this input and press Enter to navigate the slab's cloud-hosted
 * Chromium. Mirrors the motebit-side `ComputerAction.navigate`
 * primitive but routes through `forwardUserInput` (gated on user
 * state) instead of the AI-loop's `executeAction` (gated on motebit
 * state).
 *
 * Doctrine binding:
 *
 *   - **Surface determinism** (`docs/doctrine/surface-determinism.md`).
 *     Enter dispatches a typed `UserInputEvent` via the same
 *     `forwardEvent` callback as click/key/paste/wheel. Never an
 *     AI-loop prompt. The `check-affordance-routing` gate enforces
 *     statically.
 *
 *   - **Calm software** (`CLAUDE.md` §UI). The address bar is
 *     mounted only when state.kind === "user" — when motebit drives
 *     the bar is absent (motebit has its own `navigate` tool). No
 *     toast on navigation; the screencast surfaces the new page
 *     directly.
 *
 *   - **URL normalization** mirrors the server-side regex
 *     (`^[a-z][a-z0-9+.-]*:\/\/`). Bare hostnames (`example.com`,
 *     `tesla.com/about`) prepend `https://`. The server is the
 *     source of truth and re-normalizes defensively, but
 *     normalizing here gives the audit a faithful "what URL the
 *     user submitted" record without a round-trip.
 *
 * Slice 2d scope: URL navigation only. Genuine search (typing
 * "best laptops 2026") deferred — would need a search-engine
 * fallback contract. The input UX is "address bar" not
 * "omnibox" in v1.
 */

import type { UserInputEvent } from "@motebit/sdk";
import type { UserInputForwardResult } from "@motebit/runtime";

export interface RenderCoBrowseAddressBarOpts {
  /**
   * Same callback shape as the input-capture module. Direct typed-
   * capability dispatch into runtime → dispatcher → Chromium.
   * Surface-determinism gate compliance by construction.
   */
  readonly forwardEvent: (event: UserInputEvent) => Promise<UserInputForwardResult>;
}

/**
 * Build the address bar element. The element is self-contained
 * (its own input, its own Enter handler); the caller mounts it via
 * `LiveBrowserElementHandle.addressBarSlot.replaceChildren(el)` and
 * clears the slot when state leaves user.
 */
export function renderCoBrowseAddressBar(opts: RenderCoBrowseAddressBarOpts): HTMLElement {
  const { forwardEvent } = opts;

  // Wrapper carries the calm-chrome aesthetic + isolates the input
  // from the slot's pointer-events: none default.
  const wrap = document.createElement("div");
  wrap.className = "cobrowse-address-bar";
  wrap.style.display = "flex";
  wrap.style.alignItems = "center";
  wrap.style.gap = "8px";
  wrap.style.padding = "8px 12px";
  wrap.style.margin = "8px";
  wrap.style.borderRadius = "10px";
  wrap.style.background = "rgba(255, 255, 255, 0.72)";
  wrap.style.backdropFilter = "blur(12px)";
  (wrap.style as unknown as Record<string, string>)["webkitBackdropFilter"] = "blur(12px)";
  wrap.style.border = "1px solid rgba(120, 140, 180, 0.32)";
  wrap.style.boxShadow = "0 2px 8px rgba(40, 55, 90, 0.08)";
  wrap.style.font = "13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
  wrap.style.color = "rgba(40, 55, 90, 0.92)";
  wrap.style.pointerEvents = "auto";

  const input = document.createElement("input");
  input.className = "cobrowse-address-bar-input";
  input.type = "url";
  input.spellcheck = false;
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.placeholder = "Enter a URL or hostname";
  input.style.flex = "1 1 auto";
  input.style.minWidth = "0";
  input.style.background = "transparent";
  input.style.border = "none";
  input.style.outline = "none";
  input.style.font = "inherit";
  input.style.color = "inherit";
  input.style.pointerEvents = "auto";

  // Enter dispatches navigate. The wire carries the normalized URL
  // (server re-normalizes defensively, but we normalize here so the
  // audit captures the URL the user effectively submitted).
  input.addEventListener("keydown", (e) => {
    // Stop propagation so the input-capture module's document-
    // level keydown handler doesn't ALSO see this keystroke and
    // forward it as a key event into Chromium. The address bar's
    // typing belongs to the address bar, not to the page.
    e.stopPropagation();
    if (e.key !== "Enter") return;
    e.preventDefault();
    const raw = input.value.trim();
    if (raw.length === 0) return; // empty submit is a no-op
    const url = normalizeUrl(raw);
    void forwardEvent({ kind: "navigate", url }).catch((err: unknown) => {
      // eslint-disable-next-line no-console -- surface-aware logger wiring follows the same shape as cobrowse-input-capture
      console.warn("co-browse navigate forward threw", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // Clear the input on submit — calm chrome, the user sees the
    // navigation happen via the screencast and can type the next
    // URL into a fresh input.
    input.value = "";
  });

  // Suppress the document-level keydown / paste capture from the
  // input-capture module on every other key too (typing into the
  // address bar should NOT fire keystrokes into Chromium).
  input.addEventListener("keypress", (e) => e.stopPropagation());
  input.addEventListener("keyup", (e) => e.stopPropagation());
  input.addEventListener("paste", (e) => e.stopPropagation());

  wrap.appendChild(input);
  return wrap;
}

/**
 * Normalize an address-bar input into a wire-format URL. Mirror of
 * the server-side regex in `services/browser-sandbox/src/action-
 * executor.ts`: a leading scheme (`https://`, `http://`, `ftp://`,
 * etc.) passes through; anything else gets `https://` prepended.
 *
 * Exported for unit testing; surface code calls
 * `renderCoBrowseAddressBar`.
 */
export function normalizeUrl(input: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input;
  return `https://${input}`;
}
