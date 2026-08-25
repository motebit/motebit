/**
 * Goal-result artifact view — the slab body's presentation of a durable
 * goal fire (#594 Inc 4).
 *
 * WHY THIS EXISTS: the runtime's resting `stream`/`mind` slab item for a
 * goal fire is never rendered (mind-mode items are hidden by design —
 * they'd duplicate the chat log) and dies on reload. The durable record
 * is the goal's `last_response_full` + its signed ContentArtifactManifest.
 * This view presents that record inside the slab body slot, mounted by
 * `WebApp.presentGoalArtifact` under the `artifact` body register.
 *
 * Follows the slab-home idiom: inline styles (the slab body has no
 * stylesheet), soul tint shared with the creature, calm register.
 * Content renders as plain text (`white-space: pre-wrap`) — artifact
 * fidelity over formatting; markdown render would pull the chat module's
 * DOM-bound globals into this pure builder.
 */

/** Typed event name — the Goals panel dispatches, main.ts summons. */
export const GOAL_VIEW_RESULT_EVENT = "motebit:goal-view-result";

export interface GoalArtifactViewInputs {
  /** The goal's declared outcome — rendered as the "from goal" chrome. */
  readonly prompt: string;
  /** Full artifact content (`last_response_full`) — never truncated here. */
  readonly content: string;
  /** True when a signed ContentArtifactManifest was minted for this fire. */
  readonly signed: boolean;
}

export interface GoalArtifactViewOptions {
  /** Soul tint shared with the creature/slab (hex, e.g. "#a9b8d0"). */
  readonly soulTint?: string;
}

export function buildGoalArtifactView(
  inputs: GoalArtifactViewInputs,
  opts?: GoalArtifactViewOptions,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "slab-goal-artifact";
  root.style.display = "flex";
  root.style.flexDirection = "column";
  root.style.gap = "10px";
  root.style.width = "100%";
  root.style.height = "100%";
  root.style.padding = "18px 22px";
  root.style.boxSizing = "border-box";
  root.style.overflow = "hidden";

  // ── "from goal" chrome — same vocabulary as the (unreached) slab-item
  // goal chrome: quiet provenance line, never a heading. ──
  const chrome = document.createElement("div");
  chrome.className = "slab-goal-artifact-chrome";
  chrome.style.display = "flex";
  chrome.style.alignItems = "baseline";
  chrome.style.gap = "8px";
  chrome.style.flexShrink = "0";

  const fromLabel = document.createElement("span");
  fromLabel.className = "slab-goal-artifact-from";
  fromLabel.textContent = "from goal";
  fromLabel.style.fontSize = "10px";
  fromLabel.style.letterSpacing = "0.06em";
  fromLabel.style.textTransform = "uppercase";
  fromLabel.style.opacity = "0.5";
  if (opts?.soulTint) fromLabel.style.color = opts.soulTint;
  chrome.appendChild(fromLabel);

  const promptEl = document.createElement("span");
  promptEl.className = "slab-goal-artifact-prompt";
  promptEl.textContent = inputs.prompt;
  promptEl.title = inputs.prompt;
  promptEl.style.fontSize = "12px";
  promptEl.style.opacity = "0.75";
  promptEl.style.overflow = "hidden";
  promptEl.style.textOverflow = "ellipsis";
  promptEl.style.whiteSpace = "nowrap";
  chrome.appendChild(promptEl);

  if (inputs.signed) {
    // Claim-shaped indicator (persisted boolean); the Sovereign Ledger
    // renders the verified-shaped version. Same vocabulary as the goal
    // card's "signed" chip.
    const signedEl = document.createElement("span");
    signedEl.className = "slab-goal-artifact-signed";
    signedEl.textContent = "signed";
    signedEl.title =
      "Result wrapped as a signed ContentArtifactManifest — independently verifiable via motebit-verify";
    signedEl.style.fontSize = "10px";
    signedEl.style.letterSpacing = "0.04em";
    signedEl.style.opacity = "0.55";
    signedEl.style.flexShrink = "0";
    chrome.appendChild(signedEl);
  }

  root.appendChild(chrome);

  // ── The artifact itself — full content, scrollable, never truncated. ──
  const contentEl = document.createElement("div");
  contentEl.className = "slab-goal-artifact-content";
  contentEl.textContent = inputs.content;
  contentEl.style.whiteSpace = "pre-wrap";
  contentEl.style.overflowY = "auto";
  contentEl.style.flex = "1 1 auto";
  contentEl.style.minHeight = "0";
  contentEl.style.fontSize = "13px";
  contentEl.style.lineHeight = "1.55";
  root.appendChild(contentEl);

  return root;
}
