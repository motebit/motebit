/**
 * Settings → Identity → Machines — the desktop's DOM layout of the shared
 * machine-roster section (`docs/proposals/machine-roster-surfaces-v1.md` S5).
 * Every rule lives in `../machines-render-model.ts` (unit-tested); this file
 * only lays the model out. Calm: no toast, results and errors inline.
 *
 * Built with DOM nodes and `textContent` only: device ids and keys come
 * from the relay and are never parsed as markup.
 */
import type { MachineRosterSection, MachineRosterSectionState } from "@motebit/surface-kit";
import { machinesModel, type MachinesNote } from "../machines-render-model";

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

function note(n: MachinesNote): HTMLDivElement {
  const d = el("div", "identity-note machines-note", n.text);
  d.style.fontSize = "12px";
  d.style.color =
    n.tone === "error" ? "var(--status-warning, #f0a030)" : "var(--text-secondary, inherit)";
  return d;
}

function button(label: string, onClick: () => void, disabled: boolean): HTMLButtonElement {
  const b = el("button", "copy-btn machines-action", label);
  b.type = "button";
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

export function renderMachines(
  state: MachineRosterSectionState,
  section: Pick<MachineRosterSection, "retire" | "enroll" | "cancelForce">,
): HTMLDivElement {
  const m = machinesModel(state);
  const root = el("div", "machines-body");
  for (const n of m.head) root.append(note(n));
  if (m.claim != null) root.append(el("div", "machines-claim", m.claim));
  else if (m.noCount != null) root.append(note({ text: m.noCount, tone: "plain" }));
  for (const line of m.lines) {
    const row = el("div", "identity-field machines-line");
    row.dataset.kind = line.kind;
    row.dataset.deviceId = line.deviceId;
    row.append(el("span", "identity-value machines-text", line.text));
    if (line.retire) {
      row.append(button("Retire", () => void section.retire(line.deviceId), m.busy));
    }
    if (line.enroll) {
      row.append(button("Enroll", () => void section.enroll(line.deviceId), m.busy));
    }
    root.append(row);
  }
  for (const n of m.tail) root.append(note(n));
  if (m.confirmForce != null) {
    const force = m.confirmForce;
    const box = el("div", "machines-confirm");
    box.append(note({ text: force.text, tone: "plain" }));
    box.append(
      button("Enroll anyway", () => void section.enroll(force.deviceId, { force: true }), m.busy),
      button("Cancel", () => section.cancelForce(), m.busy),
    );
    root.append(box);
  }
  if (m.notice != null) root.append(note(m.notice));
  return root;
}

/** Mount the section into `card` and keep it rendered. Returns the unsubscribe. */
export function mountMachines(card: HTMLElement, section: MachineRosterSection): () => void {
  const draw = (state: MachineRosterSectionState): void => {
    card.querySelector(".machines-body")?.remove();
    card.append(renderMachines(state, section));
  };
  draw(section.getState());
  return section.subscribe(draw);
}
