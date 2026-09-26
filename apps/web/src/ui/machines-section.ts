/**
 * Settings → Identity → Machines — the browser's render of the shared
 * machine-roster section (`docs/proposals/machine-roster-surfaces-v1.md`
 * S5). Everything it says comes from the kit's view model; this file only
 * lays it out:
 *
 *   - the count ONLY when the view carries one (never over a suppressed or
 *     unconfirmed verdict), otherwise why there is no count;
 *   - the lines, the empty state and the notes, as the CLI prints them;
 *   - Retire / Enroll only where the section offers them (identity key, a
 *     browser that can lock across tabs; F6 for Enroll), a `needs-force`
 *     answer as an explicit second tap;
 *   - calm: no toast, results and errors inline.
 *
 * Built with DOM nodes and `textContent` only: device ids and keys come
 * from the relay and are never parsed as markup.
 */
import type { MachineRosterSection, MachineRosterSectionState } from "@motebit/surface-kit";
import { suppressionText } from "@motebit/surface-kit";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls: string | null,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function note(text: string, tone?: "error" | "done"): HTMLDivElement {
  const n = el("div", "identity-note machines-note", text);
  if (tone) n.dataset.tone = tone;
  if (tone === "error") n.style.color = "var(--status-warning, #f0a030)";
  return n;
}

function button(label: string, onClick: () => void, disabled: boolean): HTMLButtonElement {
  const b = el("button", "copy-btn machines-action", label);
  b.type = "button";
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

/** Render one state of the section into a fresh node tree. */
export function renderMachines(
  state: MachineRosterSectionState,
  section: Pick<MachineRosterSection, "retire" | "enroll" | "cancelForce">,
): HTMLDivElement {
  const root = el("div", "machines-body");
  if (state.heldKeyText != null) root.append(note(state.heldKeyText));
  // A device-only key: its one-key chain would show every real entry as
  // unplaceable — true, useless and easy to misread. Only the reason.
  if (state.rosterHidden) return root;
  if (state.error != null)
    root.append(note(`The roster could not be read: ${state.error}`, "error"));
  const view = state.view;
  if (view == null) {
    if (state.phase === "loading") root.append(note("Reading the roster…"));
    return root;
  }
  if (view.kind !== "roster") {
    // No roster (no key, or the chain was refused): the kit's words.
    root.append(note(view.text));
    return root;
  }
  // C6.10 — the count only when the view carries one.
  if (view.claim != null) {
    root.append(el("div", "machines-claim", view.claim.text));
  } else if (view.suppressed.length > 0) {
    root.append(note(`No count: ${view.suppressed.map(suppressionText).join("; ")}.`));
  }
  if (state.writeBlocked != null) root.append(note(state.writeBlocked));
  const busy = state.busy != null;
  const list = el("div", "machines-lines");
  view.lines.forEach((line, i) => {
    const row = el("div", "identity-field machines-line");
    row.dataset.kind = line.kind;
    row.dataset.deviceId = line.device_id;
    row.append(el("span", "identity-value machines-text", line.text));
    const actions = state.lineActions[i];
    if (actions?.retire) {
      row.append(button("Retire", () => void section.retire(line.device_id), busy));
    }
    if (actions?.enroll) {
      row.append(button("Enroll", () => void section.enroll(line.device_id), busy));
    }
    list.append(row);
  });
  root.append(list);
  if (view.empty != null) root.append(note(view.empty.text));
  for (const n of view.notes) root.append(note(n.text));
  if (state.confirmForce != null) {
    const force = state.confirmForce;
    const box = el("div", "machines-confirm");
    box.append(note(force.text));
    box.append(
      button("Enroll anyway", () => void section.enroll(force.deviceId, { force: true }), busy),
      button("Cancel", () => section.cancelForce(), busy),
    );
    root.append(box);
  }
  if (state.notice != null) root.append(note(state.notice.text, state.notice.tone));
  return root;
}

/**
 * Mount the section into `card` (the Machines settings card) and keep it
 * rendered. Returns the unsubscribe.
 */
export function mountMachines(card: HTMLElement, section: MachineRosterSection): () => void {
  const draw = (state: MachineRosterSectionState): void => {
    card.querySelector(".machines-body")?.remove();
    card.append(renderMachines(state, section));
  };
  draw(section.getState());
  return section.subscribe(draw);
}
