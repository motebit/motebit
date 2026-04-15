/**
 * PR URL paste chip — when the user pastes a GitHub pull-request URL into
 * the chat input, a glass chip emerges above the input offering a one-tap
 * "Review this PR →". Typing dismisses it; tapping commits the review.
 *
 * Explicit tap, not AI-routing heuristics: when the chip fires, it sends a
 * message that tells the local runtime what to do and why, so delegation
 * to `review_pr` is reliable rather than probabilistic.
 */

const PR_URL_RE = /https?:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+\/?/i;

export interface PrUrlChipDeps {
  /** The chat input element. */
  input: HTMLInputElement;
  /** The chat input row (position:relative parent the chip anchors to). */
  row: HTMLElement;
  /** Commit the review — typically a bound handleSend(textOverride) call. */
  onCommit: (textOverride: string) => void;
}

/**
 * Install the paste-detection chip. Call once during chat init.
 * Returns a teardown function (used by tests; production never uses it).
 */
export function installPrUrlChip(deps: PrUrlChipDeps): () => void {
  const { input, row, onCommit } = deps;
  let chipEl: HTMLElement | null = null;
  let currentUrl: string | null = null;

  function extractUrl(value: string): string | null {
    const m = value.match(PR_URL_RE);
    return m ? m[0].replace(/\/$/, "") : null;
  }

  function dismissChip(): void {
    if (!chipEl) return;
    const el = chipEl;
    chipEl = null;
    currentUrl = null;
    // Recede with a short fade — matches the "calm software" aesthetic; no
    // toast, no confirmation, the chip simply leaves.
    el.classList.add("is-leaving");
    window.setTimeout(() => el.remove(), 200);
  }

  function emergeChip(url: string): void {
    if (chipEl) dismissChip();
    currentUrl = url;

    const el = document.createElement("button");
    el.type = "button";
    el.className = "pr-url-chip";
    el.setAttribute("aria-label", "Review this pull request");

    const label = document.createElement("span");
    label.className = "pr-url-chip-label";
    label.textContent = "Review this PR";
    el.appendChild(label);

    const arrow = document.createElement("span");
    arrow.className = "pr-url-chip-arrow";
    arrow.textContent = "→";
    el.appendChild(arrow);

    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      const u = currentUrl;
      if (!u) return;
      dismissChip();
      input.value = "";
      // Explicit, reliable: tell the runtime both the intent and the URL.
      // The AI routes to `delegate_to_agent` with capability=review_pr.
      onCommit(`Review this PR: ${u}`);
    });

    row.appendChild(el);
    // Force a reflow so the transition from .is-entering → default runs.
    el.classList.add("is-entering");
    void el.offsetWidth;
    el.classList.remove("is-entering");
    chipEl = el;
  }

  function sync(): void {
    const url = extractUrl(input.value);
    if (url && url !== currentUrl) {
      emergeChip(url);
    } else if (!url && chipEl) {
      dismissChip();
    }
  }

  // Paste and input both trigger a re-check. `paste` fires before the
  // input reflects the pasted text, so we defer to the next tick.
  const onPaste = () => window.setTimeout(sync, 0);
  const onInput = () => sync();
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape" && chipEl) {
      ev.preventDefault();
      dismissChip();
    }
  };

  input.addEventListener("paste", onPaste);
  input.addEventListener("input", onInput);
  input.addEventListener("keydown", onKey);

  return () => {
    input.removeEventListener("paste", onPaste);
    input.removeEventListener("input", onInput);
    input.removeEventListener("keydown", onKey);
    if (chipEl) dismissChip();
  };
}
