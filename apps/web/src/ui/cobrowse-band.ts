/**
 * Co-browse Slice 2b — control band UI for the web surface.
 *
 * Reads `ControlState` from the runtime's `CoBrowseControlMachine` and
 * builds a state-appropriate band element that mounts on the slab's
 * chrome slot via `RenderAdapter.setSlabControlBand(...)`. The band IS
 * the consent contract surface: handoff doorbell, "motebit is driving"
 * reclaim, paused resume.
 *
 * Doctrine:
 *
 *   - **Surface determinism** (`docs/doctrine/surface-determinism.md`).
 *     Every button click invokes a typed capability on the machine
 *     directly — `machine.grantControl("user")`, etc. No prompts
 *     constructed; no AI-loop routing. The `check-affordance-routing`
 *     gate scans this directory and would fail any drift.
 *
 *   - **Calm software** (`CLAUDE.md` §UI). The `{kind: "user"}`
 *     register returns null — don't announce what the user already
 *     sees. The band only emerges when the state has something to say:
 *     a pending handoff (doorbell), motebit holding (reclaim), paused
 *     (resume).
 *
 *   - **Dissolution / replace semantics**. The slot's lifecycle is
 *     owned by `SlabManager.setControlBand`. This module only builds
 *     elements; web-app.ts subscribes to the machine and pushes new
 *     elements through the slot on each transition. A failed
 *     transition (the machine returned `{ok: false}`) leaves the band
 *     untouched — the state didn't change and the listener isn't
 *     called.
 *
 * Why the visible affordances are user-side only:
 *
 *   - `user` → null. The user is driving; nothing to surface.
 *   - `handoff_pending` (current=user, requesting=motebit) → Grant /
 *     Deny. Motebit asked; the user answers. The only legal-from-here
 *     transitions for the user-current side.
 *   - `motebit` → Take back. User can `reclaimControl` unilaterally.
 *   - `paused` → Resume. Either party (and "system") can resume; the
 *     band offers it from the user's side.
 *
 * Motebit-side transitions (`requestControl`, `releaseControl`) are
 * NOT on this band — they're driven by the AI loop's tool calls in
 * Slice 2c+. The state machine rejects user-issued requests with
 * `wrong_party` anyway, so exposing them here would be misleading.
 */

import type { ControlState } from "@motebit/sdk";
import type { CoBrowseControlMachine } from "@motebit/runtime";

/**
 * Build the band element for the given state, or null when the state
 * carries no user-side message (`{kind: "user"}`). The machine
 * reference is captured by the click handlers — buttons drive
 * transitions through the typed capabilities, never through a prompt.
 *
 * The slot owner (`SlabManager.setControlBand`) clears the slot when
 * given null; web-app.ts passes our return value straight through.
 */
export function renderCoBrowseBand(
  state: ControlState,
  machine: CoBrowseControlMachine,
): HTMLElement | null {
  if (state.kind === "user") {
    // Calm — the user is driving. Nothing to surface.
    return null;
  }

  if (state.kind === "handoff_pending") {
    // The doorbell. Motebit asked; the user answers. Only legal from
    // current=user (only motebit can request, so current is always
    // user in v1) — but we read state.current explicitly so when
    // peer-side requests join the protocol later, the band stays
    // honest.
    if (state.current !== "user") {
      // Defensive: a future state where motebit holds and requests
      // would yield user-grants-from-non-user — wrong_party at the
      // machine. Keep the band silent rather than offer a button
      // that would always fail.
      return null;
    }
    return buildHandoffPendingBand(state.requesting, machine);
  }

  if (state.kind === "motebit") {
    return buildMotebitDrivingBand(machine);
  }

  // paused
  return buildPausedBand(state.previousDriver, machine);
}

// ── State-specific builders ────────────────────────────────────────────

function buildHandoffPendingBand(
  requesting: "user" | "motebit",
  machine: CoBrowseControlMachine,
): HTMLElement {
  const band = baseBand("handoff_pending");
  const label =
    requesting === "motebit"
      ? "Motebit is requesting control"
      : `${requesting} is requesting control`;
  band.appendChild(buildLabel(label));

  const actions = buildActionRow();
  actions.appendChild(
    buildButton("Grant", "primary", () => {
      machine.grantControl("user");
      // Result handling lives at the subscription layer — a successful
      // transition fires the listener, web-app rebuilds the band, the
      // slot replaces this element wholesale. A failed transition
      // means the state already moved (race) and the new band reflects
      // the truth on the next emit. Either way, nothing to do here.
    }),
  );
  actions.appendChild(
    buildButton("Deny", "secondary", () => {
      machine.denyControl("user");
    }),
  );
  band.appendChild(actions);
  return band;
}

function buildMotebitDrivingBand(machine: CoBrowseControlMachine): HTMLElement {
  const band = baseBand("motebit");
  band.appendChild(buildLabel("Motebit is driving"));
  const actions = buildActionRow();
  actions.appendChild(
    buildButton("Take back", "secondary", () => {
      machine.reclaimControl();
    }),
  );
  band.appendChild(actions);
  return band;
}

function buildPausedBand(
  previousDriver: "user" | "motebit",
  machine: CoBrowseControlMachine,
): HTMLElement {
  const band = baseBand("paused");
  // Don't expose `previousDriver` in the visible label — it's an
  // implementation detail of resume semantics. The user sees "Paused"
  // and a Resume affordance; the machine handles which party holds
  // after resume.
  void previousDriver;
  band.appendChild(buildLabel("Paused"));
  const actions = buildActionRow();
  actions.appendChild(
    buildButton("Resume", "primary", () => {
      machine.resume("user");
    }),
  );
  band.appendChild(actions);
  return band;
}

// ── Shared chrome ──────────────────────────────────────────────────────

function baseBand(register: "handoff_pending" | "motebit" | "paused"): HTMLDivElement {
  const band = document.createElement("div");
  band.className = `cobrowse-band cobrowse-band-${register}`;
  // Calm chrome: frosted-glass strip at the top of the slab. Inline
  // styles only — same convention as slab-items.ts so the siblings
  // don't need a stylesheet coupling. The slot's own pointer-events:
  // none means our interactive controls (the buttons) opt back in
  // explicitly.
  band.style.display = "flex";
  band.style.alignItems = "center";
  band.style.justifyContent = "space-between";
  band.style.gap = "12px";
  band.style.padding = "10px 16px";
  band.style.margin = "8px";
  band.style.borderRadius = "10px";
  band.style.background = "rgba(255, 255, 255, 0.72)";
  band.style.backdropFilter = "blur(12px)";
  // Vendor-prefixed sibling for Safari < 18. CSSStyleDeclaration types
  // don't include the prefix; use bracket access to bypass TS without
  // losing the runtime effect.
  (band.style as unknown as Record<string, string>)["webkitBackdropFilter"] = "blur(12px)";
  band.style.border = "1px solid rgba(120, 140, 180, 0.32)";
  band.style.boxShadow = "0 2px 8px rgba(40, 55, 90, 0.08)";
  band.style.font = "13px/1.4 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
  band.style.color = "rgba(40, 55, 90, 0.92)";
  band.style.pointerEvents = "auto";
  // Doorbell register — the handoff_pending case is the one that
  // actually needs to attract attention. A subtle accent on the left
  // edge keeps the band calm but readable as "this needs you."
  if (register === "handoff_pending") {
    band.style.borderLeft = "3px solid rgba(80, 130, 200, 0.85)";
  }
  return band;
}

function buildLabel(text: string): HTMLDivElement {
  const label = document.createElement("div");
  label.className = "cobrowse-band-label";
  label.textContent = text;
  label.style.flex = "1 1 auto";
  label.style.minWidth = "0";
  label.style.overflow = "hidden";
  label.style.textOverflow = "ellipsis";
  label.style.whiteSpace = "nowrap";
  return label;
}

function buildActionRow(): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "cobrowse-band-actions";
  row.style.display = "flex";
  row.style.gap = "8px";
  row.style.flex = "0 0 auto";
  return row;
}

function buildButton(
  label: string,
  register: "primary" | "secondary",
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `cobrowse-band-btn cobrowse-band-btn-${register}`;
  btn.textContent = label;
  btn.style.font = "inherit";
  btn.style.padding = "5px 12px";
  btn.style.borderRadius = "6px";
  btn.style.cursor = "pointer";
  btn.style.userSelect = "none";
  btn.style.pointerEvents = "auto";
  btn.style.transition = "background 120ms ease-out, border-color 120ms ease-out";
  if (register === "primary") {
    btn.style.background = "rgba(80, 130, 200, 0.92)";
    btn.style.color = "rgba(255, 255, 255, 0.96)";
    btn.style.border = "1px solid rgba(60, 110, 180, 0.85)";
  } else {
    btn.style.background = "rgba(255, 255, 255, 0.62)";
    btn.style.color = "rgba(40, 55, 90, 0.86)";
    btn.style.border = "1px solid rgba(120, 140, 180, 0.45)";
  }
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    // Direct machine invocation — no prompt construction, no AI loop.
    // Surface-determinism gate compliance by construction.
    onClick();
  });
  return btn;
}
