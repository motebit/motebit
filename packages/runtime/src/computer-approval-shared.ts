/**
 * Surface-shared computer-use approval flow.
 *
 * Why this lives in `@motebit/runtime`. The `ComputerApprovalFlow`
 * callback the session manager needs is identical between the desktop
 * Tauri webview and the web/spatial DOM contexts — it renders an
 * approval card into a caller-supplied DOM host, awaits Allow / Deny,
 * and returns the verdict. Inlining the same factory in every surface
 * was the failure mode `feedback_protocol_primitive_blindness` exists
 * to prevent: each surface re-deriving the classifier-reason
 * surfacing, the card's audit-trail rendering, and the fail-closed
 * behavior on missing host.
 *
 * What's shared (here): the factory + its DOM-shape interfaces +
 * KIND_SUMMARIES + the reason composer.
 *
 * What stays per-surface (a thin wrapper): obtaining the actual
 * `renderHost` (e.g. `document.getElementById("chat-log")` on web
 * vs. desktop's chat-log mount). The wrapper is one line:
 * `createComputerApprovalFlow({ renderHost: chatLog })`.
 *
 * Browser-safety: this module references DOM types via duck-typed
 * interfaces (no `node:*` imports) so it bundles cleanly into both
 * `apps/web` (Vite) and `apps/desktop` (Tauri webview) without the
 * `@motebit/skills` regression that motivated `check-package-browser-
 * entry`. The `document` global lookup is guarded with
 * `typeof document !== "undefined"` so it tree-shakes in non-browser
 * targets and Node tests work via the injected `doc` stub.
 */

import { classifyComputerAction } from "@motebit/policy-invariants";
import type { ComputerAction } from "@motebit/sdk";

import type { ComputerApprovalFlow } from "./computer-use.js";

/**
 * Minimum interface the approval flow needs from the DOM host.
 * Accepts any real `HTMLElement` at runtime; the narrow shape keeps
 * the factory decoupled from browser globals so Node-side unit tests
 * can pass a fake with `appendChild` + `scrollTop` settable.
 */
export interface ApprovalRenderHost {
  appendChild(child: unknown): unknown;
  scrollTop: number;
  scrollHeight: number;
}

export interface CreateComputerApprovalFlowOptions {
  /**
   * Where the approval card is injected. Typically the chat log
   * element — so the approval prompt lives in the same visual space
   * the user is already watching. When omitted, the flow fails
   * closed (every `require_approval` → deny) so a misconfigured
   * caller can't accidentally silently-approve.
   */
  renderHost?: ApprovalRenderHost;
  /**
   * Optional `document` stand-in for tests. Defaults to the global
   * `document` in a browser / Tauri webview. Only `createElement` is
   * used.
   */
  doc?: {
    createElement(tag: string): {
      className: string;
      textContent: string;
      appendChild(child: unknown): unknown;
      addEventListener(type: string, handler: () => void): void;
      disabled?: boolean;
    };
  };
}

/**
 * Action-kind → human summary used when we haven't got specific text
 * to show. The sensitivity path always has a better summary; this is
 * the fallback when a non-`type` action is (for whatever reason)
 * routed through the approval flow.
 */
const KIND_SUMMARIES: Record<string, string> = {
  screenshot: "capture a screenshot of your screen",
  cursor_position: "read the cursor position",
  click: "click at a target",
  double_click: "double-click at a target",
  mouse_move: "move the cursor",
  drag: "drag from one point to another",
  type: "type text",
  key: "press a key combination",
  scroll: "scroll at a target",
};

export function createComputerApprovalFlow(
  opts: CreateComputerApprovalFlowOptions = {},
): ComputerApprovalFlow {
  const doc =
    opts.doc ??
    (typeof document !== "undefined"
      ? (document as unknown as NonNullable<typeof opts.doc>)
      : undefined);

  return async (action: ComputerAction): Promise<boolean> => {
    if (!opts.renderHost || !doc) {
      // Fail-closed — no render target means we cannot solicit consent.
      return false;
    }

    const classification = classifyComputerAction(action);
    const reason = renderReason(action, classification.reason, classification.rule);

    const card = doc.createElement("div");
    card.className = "approval-card";

    const tool = doc.createElement("div");
    tool.className = "approval-tool";
    tool.textContent = `computer: ${action.kind}`;
    card.appendChild(tool);

    const why = doc.createElement("div");
    why.className = "approval-args";
    why.textContent = reason;
    card.appendChild(why);

    const btns = doc.createElement("div");
    btns.className = "approval-buttons";

    const allow = doc.createElement("button");
    allow.className = "btn-allow";
    allow.textContent = "Allow";

    const deny = doc.createElement("button");
    deny.className = "btn-deny";
    deny.textContent = "Deny";

    btns.appendChild(allow);
    btns.appendChild(deny);
    card.appendChild(btns);

    opts.renderHost.appendChild(card);
    opts.renderHost.scrollTop = opts.renderHost.scrollHeight;

    return new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (approved: boolean): void => {
        if (settled) return;
        settled = true;
        allow.disabled = true;
        deny.disabled = true;
        // Replace buttons with a verdict line so the chat log shows
        // history instead of dead buttons.
        const verdict = doc.createElement("div");
        verdict.className = "approval-verdict";
        verdict.textContent = approved ? "Allowed" : "Denied";
        card.appendChild(verdict);
        resolve(approved);
      };
      allow.addEventListener("click", () => {
        settle(true);
      });
      deny.addEventListener("click", () => {
        settle(false);
      });
    });
  };
}

/**
 * Compose the reason sentence shown to the user. For a `type` action
 * with sensitive text, the classifier's reason is already specific
 * ("Action would type secret data (1 match); requires user approval.").
 * For a `click` matching irreversibility heuristics, similar.
 * For other cases, fall back to the action-kind summary.
 */
function renderReason(
  action: ComputerAction,
  classifierReason: string | undefined,
  classifierRule: string | undefined,
): string {
  if (classifierReason) {
    if (classifierRule) {
      return `${classifierReason} (${classifierRule})`;
    }
    return classifierReason;
  }
  const summary = KIND_SUMMARIES[action.kind] ?? `execute computer action: ${action.kind}`;
  return `motebit wants to ${summary}.`;
}
