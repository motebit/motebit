/**
 * Settings → Identity → Machines, as data — the desktop's render model of the
 * shared machine-roster section (`docs/proposals/machine-roster-surfaces-v1.md`
 * S5; the phone's model is the same, `apps/mobile/src/machines-render-model.ts`).
 * `ui/machines-section.ts` only lays this out, so every rule a reviewer cares
 * about is here and unit-tested in node:
 *
 *   - the count ONLY when the view carries one (never over a suppressed or
 *     unconfirmed verdict), otherwise why there is no count;
 *   - a device-only key shows only the reason, never the roster;
 *   - the lines, the empty state and the notes, as the CLI prints them;
 *   - Retire / Enroll only where the section offers them (identity key; F6
 *     for Enroll), a `needs-force` answer as an explicit second tap;
 *   - calm: no toast — results and errors are inline notes.
 */
import { suppressionText, type MachineRosterSectionState } from "@motebit/surface-kit";

export interface MachinesNote {
  text: string;
  tone: "plain" | "error" | "done";
}

export interface MachinesLine {
  deviceId: string;
  kind: string;
  text: string;
  retire: boolean;
  enroll: boolean;
}

export interface MachinesModel {
  /** Notes shown above the roster (held-key reason, read error, loading, no-roster). */
  head: MachinesNote[];
  /** The count, only when the view carries one. */
  claim: string | null;
  /** Why there is no count (a suppressed verdict), or null. */
  noCount: string | null;
  lines: MachinesLine[];
  /** Empty state and the view's notes. */
  tail: MachinesNote[];
  /** The second, explicit tap for a `needs-force` enroll. */
  confirmForce: { deviceId: string; text: string } | null;
  /** The last act's result, inline. */
  notice: MachinesNote | null;
  /** An act is running: every action is disabled. */
  busy: boolean;
}

const plain = (text: string): MachinesNote => ({ text, tone: "plain" });

export function machinesModel(state: MachineRosterSectionState): MachinesModel {
  const model: MachinesModel = {
    head: [],
    claim: null,
    noCount: null,
    lines: [],
    tail: [],
    confirmForce: null,
    notice: null,
    busy: state.busy != null,
  };
  if (state.heldKeyText != null) model.head.push(plain(state.heldKeyText));
  // A device-only key: its one-key chain would show every real entry as
  // unplaceable — true, useless and easy to misread. Only the reason.
  if (state.rosterHidden) return model;
  if (state.error != null) {
    model.head.push({ text: `The roster could not be read: ${state.error}`, tone: "error" });
  }
  const view = state.view;
  if (view == null) {
    if (state.phase === "loading") model.head.push(plain("Reading the roster…"));
    return model;
  }
  if (view.kind !== "roster") {
    // No roster (no key, or the chain was refused): the kit's words.
    model.head.push(plain(view.text));
    return model;
  }
  // C6.10 — the count only when the view carries one.
  if (view.claim != null) {
    model.claim = view.claim.text;
  } else if (view.suppressed.length > 0) {
    model.noCount = `No count: ${view.suppressed.map(suppressionText).join("; ")}.`;
  }
  if (state.writeBlocked != null) model.head.push(plain(state.writeBlocked));
  model.lines = view.lines.map((line, i) => {
    const actions = state.lineActions[i];
    return {
      deviceId: line.device_id,
      kind: line.kind,
      text: line.text,
      retire: actions?.retire === true,
      enroll: actions?.enroll === true,
    };
  });
  if (view.empty != null) model.tail.push(plain(view.empty.text));
  for (const n of view.notes) model.tail.push(plain(n.text));
  if (state.confirmForce != null) {
    model.confirmForce = { deviceId: state.confirmForce.deviceId, text: state.confirmForce.text };
  }
  if (state.notice != null) model.notice = { text: state.notice.text, tone: state.notice.tone };
  return model;
}
