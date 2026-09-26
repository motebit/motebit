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
      ? `${n.text} — if that was this machine before a restore: \`motebit machines retire ${n.device_id}\``
      : n.kind === "ambiguous"
        ? `${n.text} — \`motebit doctor\` on each machine prints its device_id`
        : n.text,
  );
  if (notes.length > 0) {
    out.push("");
    for (const n of notes) out.push(`  · ${n}`);
  }
  if (view.relay != null) {
    out.push(
      `  · liveness as observed by relay ${view.relay.observed_by.slice(0, 12)}…; no heartbeat`,
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
  // 401/403: this device's credential was refused (its key may have been
  // rotated away); not "presented again" until that is resolved.
  const refusedAuth = (r: string): boolean => /\bstatus 40[13]\b/.test(r);
  const ownAuth = presented.notTaken.filter((n) => own.has(n.id) && refusedAuth(n.reason)).length;
  const ownNot = presented.notTaken.filter((n) => own.has(n.id) && !refusedAuth(n.reason)).length;
  const otherFull = presented.rosterFull.length - ownFull;
  const otherNot = presented.notTaken.length - ownNot - ownAuth;
  const entries = (n: number): string => `${n} other held ${n === 1 ? "entry" : "entries"}`;
  const out: string[] = [];
  if (ownFull > 0) {
    out.push(
      `  The relay refused this ${noun} permanently (roster full); kept on this device only.`,
    );
  }
  if (ownAuth > 0) {
    out.push(
      `  The relay refused this ${noun} (not authorized); kept on this device — \`motebit machines\` to check this device's key.`,
    );
  }
  if (ownNot > 0) out.push(`  Not yet taken by the relay; kept on this device, presented again.`);
  if (otherFull > 0)
    out.push(`  The relay refused ${entries(otherFull)} permanently (roster full).`);
  if (otherNot > 0) out.push(`  ${entries(otherNot)} not yet taken; presented again.`);
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
          ...(out.advisory ? ["  Advisory: its line is on a superseded key."] : []),
          ...presentationLines(out.presented, out.retirementIds, "retirement"),
          `  To enrol it again under the current key: \`motebit machines enroll ${out.deviceId}\`.`,
        ],
        ok: true,
      };
    case "already-retired":
      return { lines: [`${out.deviceId} is already retired.`], ok: true };
    case "not-enrolled":
      return {
        lines: [`${out.deviceId} is connected; this device sees no enrolment for it to retire.`],
        ok: false,
      };
    case "unplaced-lines":
      return {
        lines: [
          `${out.deviceId} has ${out.count} ${out.count === 1 ? "enrolment" : "enrolments"} under keys this device cannot place in its chain; none retirable from here.`,
          "  Rerun once the relay's key chain can be read.",
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
      const force = `\`motebit machines enroll ${out.deviceId} --force\``;
      const n = out.count ?? 1;
      const [why, next] =
        out.why === "no-such-line"
          ? [
              `this device sees no line for ${out.deviceId}, and it is not this machine's id`,
              `If the id is right: ${force}.`,
            ]
          : out.why === "unplaced-lines"
            ? [
                `${out.deviceId} has ${n} ${n === 1 ? "enrolment" : "enrolments"} under keys this device cannot place in its chain`,
                `Rerun once the relay's key chain can be read, or ${force}.`,
              ]
            : out.why === "all-superseded"
              ? [
                  `every line of ${out.deviceId} this device can see is on a superseded key${out.key ? ` (${out.key.slice(0, 16)}…)` : ""}`,
                  `If ${out.deviceId} now holds the current key: ${force}.`,
                ]
              : [
                  `${out.deviceId} is connected under a linked device's key (not the identity key)`,
                  `If intended: ${force}.`,
                ];
      return { lines: [`Not enrolled: ${why}.`, `  ${next}`], ok: false };
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
