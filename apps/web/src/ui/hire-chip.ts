/**
 * Hire-compose register — the slab hand-organ for hiring a specific agent.
 *
 * The Agents panel browses the roster; when the user taps a priced capability,
 * the hire is handed HERE, to the slab, where it is composed and performed. A
 * chip emerges above the chat input pinned to {worker, capability, price}; the
 * chat input becomes the compose field; the act-button (Run · $price) carries
 * the price on the right — payment-as-act, one deliberate commit AFTER the task
 * is composed.
 *
 * The pin (`workerId`) flows through `onRun` into
 * `WebApp.invokeCapability(capability, prompt, { targetWorkerId })`, which fails
 * closed — never substitutes a different worker — per surface-determinism. No
 * modal (structurally forbidden on panels); no AI in the routing path.
 *
 * Sibling of `pr-url-chip.ts`. Standalone + installable so the DOM behavior is
 * testable in isolation; `chat.ts` owns the single Enter handler and defers to
 * `isActive()` / `fire()` so the two affordances don't fight over the key.
 *
 * See `docs/doctrine/agents-as-first-person-trust-graph.md` §5 (the hire is a
 * slab act, the panel stays browse) and `docs/doctrine/motebit-computer.md`
 * (the hand organ).
 */

/**
 * A hire handed off from the Agents panel to the slab. The panel pins WHO
 * (`workerId`, the tapped agent) and WHAT (`capability` + its `priceLabel`);
 * `label` is the agent's display handle (petname when known, else short id),
 * already shortened by the panel so no raw id rendering happens here.
 */
export interface HireComposeRequest {
  workerId: string;
  capability: string;
  label: string;
  /** Pre-formatted price for the Run button, e.g. "$0.50". */
  priceLabel: string;
}

export interface HireChipDeps {
  /** The chat input element — doubles as the hire's compose field. */
  input: HTMLInputElement;
  /** The chat input row (position:relative parent the chip anchors to). */
  row: HTMLElement;
  /**
   * Fire the deterministic, pinned hire. Bound by `chat.ts` to a wrapper that
   * calls `ctx.app.invokeCapability(capability, prompt, { targetWorkerId })`
   * and renders the resulting stream into chat. No prompt construction beyond
   * the user's composed task; no AI-loop mediation.
   */
  onRun: (capability: string, prompt: string, workerId: string) => void;
  /** Display label for a capability (reuse chat's `capabilityLabel`). */
  labelCapability?: (capability: string) => string;
}

export interface HireChipController {
  /** Emerge the register pinned to a specific agent + capability. */
  emerge(req: HireComposeRequest): void;
  /** Tear the register down (no fire). Restores the default input placeholder. */
  dismiss(): void;
  /** Whether a hire is currently composing. */
  isActive(): boolean;
  /**
   * Fire the pending hire IF the input holds a composed task. Returns true when
   * it fired (so the caller's Enter handler can stop). A no-op (returns false)
   * when inactive or the task is empty — Run is inert until composed.
   */
  fire(): boolean;
}

/**
 * Install the hire-compose register. Call once during chat init. Returns a
 * controller; `chat.ts` calls `emerge` from the Agents-panel hire hook, and
 * checks `isActive`/`fire` from its Enter handler.
 */
export function installHireChip(deps: HireChipDeps): HireChipController {
  const { input, row, onRun } = deps;
  const labelCapability = deps.labelCapability ?? ((c: string) => c);
  const defaultPlaceholder = input.placeholder;

  let active: { workerId: string; capability: string } | null = null;
  let chipEl: HTMLElement | null = null;
  let runBtn: HTMLButtonElement | null = null;

  function syncRunEnabled(): void {
    if (runBtn) runBtn.disabled = input.value.trim().length === 0;
  }

  function dismiss(): void {
    if (!chipEl) return;
    input.removeEventListener("input", syncRunEnabled);
    const el = chipEl;
    chipEl = null;
    runBtn = null;
    active = null;
    input.placeholder = defaultPlaceholder;
    el.classList.add("is-leaving");
    window.setTimeout(() => el.remove(), 200);
  }

  function fire(): boolean {
    if (!active) return false;
    const task = input.value.trim();
    if (!task) return false; // Run is inert until the task is composed.
    const { workerId, capability } = active;
    dismiss();
    input.value = "";
    onRun(capability, task, workerId);
    return true;
  }

  function emerge(req: HireComposeRequest): void {
    dismiss();
    active = { workerId: req.workerId, capability: req.capability };

    const el = document.createElement("div");
    el.className = "hire-compose-chip";

    const ident = document.createElement("div");
    ident.className = "hire-compose-ident";
    const mark = document.createElement("span");
    mark.className = "hire-compose-mark";
    mark.setAttribute("aria-hidden", "true");
    ident.appendChild(mark);
    const who = document.createElement("span");
    who.className = "hire-compose-who";
    who.textContent = req.label;
    ident.appendChild(who);
    const sep = document.createElement("span");
    sep.className = "hire-compose-sep";
    sep.textContent = "·";
    ident.appendChild(sep);
    const cap = document.createElement("span");
    cap.className = "hire-compose-cap";
    cap.textContent = labelCapability(req.capability);
    ident.appendChild(cap);
    el.appendChild(ident);

    const run = document.createElement("button");
    run.type = "button";
    run.className = "hire-compose-run";
    run.textContent = `Run · ${req.priceLabel}`;
    run.addEventListener("click", (ev) => {
      ev.preventDefault();
      fire();
    });
    el.appendChild(run);
    runBtn = run;
    syncRunEnabled();

    // The chat input is the compose field — keep Run's enabled state in sync as
    // the task is typed. Listener torn down in dismiss.
    input.addEventListener("input", syncRunEnabled);

    row.appendChild(el);
    // Force a reflow so the .visible transition runs from the initial state.
    void el.offsetWidth;
    el.classList.add("visible");
    chipEl = el;

    input.placeholder = `Describe the task for ${req.label}…`;
    input.focus();
  }

  return {
    emerge,
    dismiss,
    isActive: () => active != null,
    fire,
  };
}
