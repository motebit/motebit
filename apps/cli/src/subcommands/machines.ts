/**
 * `motebit machines` — the machines this motebit runs unattended work on
 * (`docs/proposals/machine-roster-clients-v1.md` C4, C6).
 *
 *   motebit machines [--json]                     reduce the roster and read it
 *   motebit machines retire <device_id>           sign one retirement per standing entry
 *   motebit machines enroll <device_id> [--force] rejoin a retired line, or enrol an id
 *
 * The algorithm is surface-kit's `MachineRoster`; this file unlocks the key,
 * prints the kit's view, and words its remedies as commands.
 */
import { secureErase } from "@motebit/encryption";
import {
  MachineRoster,
  buildRosterView,
  suppressionText,
  type EnrollOutcome,
  type MachineRosterView,
  type PresentReport,
  type RetireOutcome,
} from "@motebit/surface-kit";
import type { CliConfig } from "../args.js";
import { loadFullConfig } from "../config.js";
import { loadActiveSigningKey } from "../identity.js";
import { cliRosterPorts, remedyText } from "../machine-roster.js";
import { requireMotebitId, resolveRelayUrl } from "./_helpers.js";

const USAGE =
  "Usage: motebit machines [--json] | motebit machines retire <device_id> | motebit machines enroll <device_id> [--force]";

/** The terminal form of the kit's view: one string per line. */
export function formatRosterView(view: MachineRosterView, motebitId: string): string[] {
  if (view.kind === "no-key") return [`No roster: ${view.text}.`];
  if (view.kind === "no-roster") {
    return [
      `No roster for ${motebitId} — ${view.text.replace(/^no roster: /, "")}.`,
      `  Held key: ${view.held.slice(0, 16)}…`,
      `  Next: ${remedyText(view.remedy)}.`,
    ];
  }
  const out: string[] = [];
  out.push(`Machines of ${motebitId} — chain head ${view.head.fingerprint}…`);
  out.push(
    view.claim != null
      ? `  ${view.claim.text}`
      : `  No count: ${view.suppressed.map(suppressionText).join("; ")}.`,
  );
  out.push("");
  if (view.empty != null) out.push(`  (${view.empty.text})`);
  for (const line of view.lines) out.push(`  ${line.text}`);
  const notes = view.notes.map((n) =>
    n.kind === "prior-line"
      ? `${n.text} — \`motebit machines retire ${n.device_id}\``
      : n.kind === "ambiguous"
        ? `${n.text} — \`motebit doctor\` on each machine shows its device_id`
        : n.text,
  );
  if (notes.length > 0) {
    out.push("");
    for (const n of notes) out.push(`  · ${n}`);
  }
  if (view.relay != null) {
    out.push(
      `  · liveness is what the relay observed (${view.relay.observed_by.slice(0, 12)}…), not proof of life — there is no heartbeat yet`,
    );
  }
  return out;
}

/**
 * What the relay did with a presentation, said plainly. The act is signed
 * and kept on this device either way; what differs is whether this relay
 * holds it — and a `roster_full` refusal is permanent, never retried.
 */
export function presentationLines(
  presented: PresentReport,
  ownIds: string[],
  noun: "retirement" | "enrolment",
): string[] {
  const own = new Set(ownIds);
  const ownFull = presented.rosterFull.filter((id) => own.has(id)).length;
  // A 401/403 is not "later": this device's credential was refused — most
  // often its key was rotated away meanwhile — so it will not be presented
  // again from here until that is resolved.
  const refusedAuth = (r: string): boolean => /\bstatus 40[13]\b/.test(r);
  const ownAuth = presented.notTaken.filter((n) => own.has(n.id) && refusedAuth(n.reason)).length;
  const ownNot = presented.notTaken.filter((n) => own.has(n.id) && !refusedAuth(n.reason)).length;
  const otherFull = presented.rosterFull.length - ownFull;
  const otherNot = presented.notTaken.length - ownNot - ownAuth;
  const out: string[] = [];
  if (ownFull > 0) {
    out.push(
      `  The relay REFUSED this ${noun} for good (its roster is full): it is kept on this device, but surfaces that read this relay will not see it.`,
    );
  }
  if (ownAuth > 0) {
    out.push(
      `  The relay refused this ${noun} (not authorized): this device's key may have been rotated away — run \`motebit machines\` to see. It is kept on this device.`,
    );
  }
  if (ownNot > 0) {
    out.push(
      `  The relay did not take this ${noun} yet; it is kept on this device and presented again.`,
    );
  }
  if (otherFull > 0) {
    out.push(
      `  The relay refused ${otherFull} other held ${otherFull === 1 ? "entry" : "entries"} for good (its roster is full).`,
    );
  }
  if (otherNot > 0) {
    out.push(
      `  The relay did not take ${otherNot} other held ${otherNot === 1 ? "entry" : "entries"}; they are presented again.`,
    );
  }
  return out;
}

export function describeRetire(out: RetireOutcome): { lines: string[]; ok: boolean } {
  switch (out.kind) {
    case "no-key":
      return { lines: ["No identity key is available on this machine."], ok: false };
    case "refused":
      return { lines: [`No roster — ${remedyText(out.remedy)}.`], ok: false };
    case "unreadable":
      return { lines: [`Nothing was signed: ${out.detail}.`], ok: false };
    case "retired":
      return {
        lines: [
          `Retired ${out.deviceId} (${out.retirementIds.length} ${out.retirementIds.length === 1 ? "entry" : "entries"}).`,
          ...(out.advisory
            ? [
                "  Its line was on a superseded key, so this is advisory: a holder of that older key can undo it. Rotation is the durable remedy.",
              ]
            : []),
          ...presentationLines(out.presented, out.retirementIds, "retirement"),
          `  Undo: \`motebit machines enroll ${out.deviceId}\`.`,
        ],
        ok: true,
      };
    case "already-retired":
      return { lines: [`${out.deviceId} is already retired.`], ok: true };
    case "not-enrolled":
      return {
        lines: [
          `${out.deviceId} is connected, but this device can see no enrolment for it; there is nothing it can retire.`,
        ],
        ok: false,
      };
    case "unplaced-lines":
      return {
        lines: [
          `${out.deviceId} has ${out.count} ${out.count === 1 ? "enrolment" : "enrolments"} under keys this device cannot place in its chain (older or newer) — nothing is retirable from here.`,
          "  Refresh the chain first: run `motebit machines` again once the relay's key chain can be read, or restore this device's copy of the identity file (a guardian recovery needs the guardian pinned locally).",
        ],
        ok: false,
      };
    case "unknown-device":
      return {
        lines: [`No machine ${out.deviceId} is on the roster this device can see.`],
        ok: false,
      };
  }
}

export function describeEnroll(out: EnrollOutcome): { lines: string[]; ok: boolean } {
  switch (out.kind) {
    case "no-key":
      return { lines: ["No identity key is available on this machine."], ok: false };
    case "refused":
      return { lines: [`No roster — ${remedyText(out.remedy)}.`], ok: false };
    case "unreadable":
      return { lines: [`Nothing was signed: ${out.detail}.`], ok: false };
    case "already-active":
      return { lines: [`${out.deviceId} is already active on the current key.`], ok: true };
    case "needs-force": {
      const why =
        out.why === "no-such-line"
          ? `this device can see no line for ${out.deviceId}, and it is not this machine's own id; a typo would become an active line that never answers`
          : out.why === "unplaced-lines"
            ? `${out.deviceId} has ${out.count ?? 1} ${(out.count ?? 1) === 1 ? "enrolment" : "enrolments"} under keys this device cannot place in its chain — refresh the chain first, so it is not enrolled twice`
            : out.why === "all-superseded"
              ? `every line of ${out.deviceId} is on a superseded key, so that machine cannot hold the current key and would never answer`
              : `${out.deviceId} is connected under a linked device's key — a device without the identity key`;
      return {
        lines: [`Not enrolled: ${why}.`, "  Re-run with --force if this is intended."],
        ok: false,
      };
    }
    case "enrolled":
      return {
        lines: [
          `Enrolled ${out.deviceId} under the current key (${out.enrollmentId.slice(0, 12)}…).`,
          ...presentationLines(out.presented, [out.enrollmentId], "enrolment"),
        ],
        ok: true,
      };
  }
}

export async function handleMachines(config: CliConfig): Promise<void> {
  const sub = config.positionals[1];
  if (sub != null && sub !== "list" && sub !== "retire" && sub !== "enroll") {
    console.error(USAGE);
    process.exit(1);
  }
  const target = config.positionals[2];
  if ((sub === "retire" || sub === "enroll") && (target == null || target === "")) {
    console.error(USAGE);
    process.exit(1);
  }
  const full = loadFullConfig();
  const motebitId = requireMotebitId(full);
  if (full.device_id == null || full.device_id === "") {
    console.error("Error: this machine has no device_id; run `motebit` once to create one.");
    process.exit(1);
  }
  let key: Uint8Array;
  try {
    key = (await loadActiveSigningKey(full, { promptLabel: "Passphrase: " })).privateKey;
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  const roster = new MachineRoster(
    cliRosterPorts({
      motebitId,
      deviceId: full.device_id,
      syncUrl: resolveRelayUrl(config, full),
      privateKey: () => key,
      ...(config.identity ? { identityPaths: [config.identity] } : {}),
    }),
  );

  let lines: string[];
  let ok: boolean;
  let json: unknown;
  try {
    if (sub === "retire") {
      const out = await roster.retire(target!);
      json = out;
      ({ lines, ok } = describeRetire(out));
    } else if (sub === "enroll") {
      const out = await roster.enroll(target!, { force: config.force });
      json = out;
      ({ lines, ok } = describeEnroll(out));
    } else {
      const view = buildRosterView(await roster.acquire(), Date.now());
      json = view;
      lines = formatRosterView(view, motebitId);
      ok = view.kind === "roster";
    }
  } finally {
    secureErase(key);
  }
  if (config.json) console.log(JSON.stringify(json, null, 2));
  else for (const l of lines) (ok ? console.log : console.error)(l);
  if (!ok) process.exit(1);
}
