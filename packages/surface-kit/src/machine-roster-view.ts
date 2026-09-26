/**
 * The machine roster, as something to read — C6 of
 * `docs/proposals/machine-roster-clients-v1.md`, with §2A's N12, R18 and
 * R25 wording. Pure: an acquisition in, a structured view out. Each line
 * carries a `kind` (what a surface lays out) and a surface-neutral `text`
 * (what it says); commands and formatting belong to the surface.
 *
 * Precedence (C6, review R5), in the order rows are classified:
 *   1. active machines, joined on `(device_id, bound_under == enrolment key)`;
 *   2. a row bound under a key IN the chain but not the head — the rotating
 *      machine's own daemon before it restarted, or any holder of that key
 *      (#767). Before the theft rule, deliberately;
 *   3. a row bound under a device key from this surface's own devices list —
 *      a linked device without the identity key, never theft;
 *   4. a row for a machine's `device_id` under a key this device cannot
 *      place in its chain — the possible theft signal, worded "cannot
 *      place", never "not this motebit's" (R18);
 *   5. connected, not in the roster;
 *   6. superseded lines — advisory, "not covered";
 *   7. "not observed in the last N days", never "never seen";
 *   8. the ambiguity hint on TWO successive reads, worded "may";
 *   9. the head cited by key fingerprint (§2A), with ancestry and what the
 *      relay is missing;
 *  10. no count or quantifier unless the verdict is `ok` and nothing
 *      suppressed universal claims.
 */
import type { RosterChainAncestry } from "@motebit/encryption";
import type {
  RosterAcquired,
  RosterAcquisition,
  RosterRefusalReason,
  RosterRemedy,
  SuppressionReason,
} from "./machine-roster.js";

const DAY_MS = 86_400_000;

/** A key as people read it: its first 16 hex characters. */
export function keyFingerprint(key: string): string {
  return key.slice(0, 16);
}

export type LineLiveness =
  | { state: "open"; sockets: number }
  | { state: "last-seen"; at: number }
  | { state: "not-observed"; since: number; windowDays: number; windowFull: boolean }
  | { state: "unknown" };

export type RosterLine =
  | {
      kind: "active";
      device_id: string;
      this_device: boolean;
      entries: number;
      liveness: LineLiveness;
      text: string;
    }
  | {
      kind: "retired";
      device_id: string;
      this_device: boolean;
      /** Retired at the head: "retired under the current key" (N4). */
      authenticated: boolean;
      /** A socket bound under the current key is open: "retired, but connected". */
      connected: boolean;
      text: string;
    }
  | {
      kind: "superseded";
      device_id: string;
      this_device: boolean;
      key: string;
      text: string;
    }
  | {
      kind: "superseded-key-socket";
      device_id: string;
      bound_under: string;
      sockets_open: number;
      last_seen_at: number | null;
      text: string;
    }
  | {
      kind: "linked-device";
      device_id: string;
      bound_under: string;
      sockets_open: number;
      text: string;
    }
  | {
      kind: "unplaced-key-socket";
      device_id: string;
      bound_under: string;
      sockets_open: number;
      text: string;
    }
  | {
      kind: "not-in-roster";
      device_id: string;
      bound_under: string;
      sockets_open: number;
      text: string;
    }
  | {
      kind: "unplaced-enrollment";
      device_id: string;
      key: string;
      /** Its key is one of this surface's own device keys: relabelled, still not covered (R25). */
      linked_device: boolean;
      text: string;
    };

export type RosterNote =
  | { kind: "ancestry"; text: string }
  | { kind: "branch"; at: string; to: string; guardian_verified: boolean; text: string }
  | { kind: "missing-links"; count: number; text: string }
  | { kind: "omitted"; count: number; text: string }
  | { kind: "relay-newer-key"; key: string; text: string }
  | { kind: "relay-unread"; reason: string; text: string }
  | { kind: "cache-corrupt"; text: string }
  | { kind: "ambiguous"; device_id: string; key: string; text: string }
  | { kind: "prior-line"; device_id: string; text: string };

export interface RosterClaim {
  active: number;
  superseded: number;
  unplaced: number;
  text: string;
}

export type MachineRosterView =
  | { kind: "no-key"; text: string }
  | {
      kind: "no-roster";
      reason: RosterRefusalReason;
      remedy: RosterRemedy;
      held: string;
      detail: string;
      text: string;
    }
  | {
      kind: "roster";
      head: { public_key: string; fingerprint: string };
      this_device: string;
      /** `null` whenever C6.10 forbids a quantifier. */
      claim: RosterClaim | null;
      /**
       * What to say when there are no lines — owned here so no surface can
       * say "no machine has enrolled" over a verdict that cannot know it.
       * `none-enrolled` only over an ok, unsuppressed verdict (`claim` set);
       * otherwise `nothing-held`: this device holds nothing, and the roster
       * could not be confirmed. `null` when there are lines.
       */
      empty: { kind: "none-enrolled" | "nothing-held"; text: string } | null;
      suppressed: SuppressionReason[];
      lines: RosterLine[];
      notes: RosterNote[];
      relay: { observed_by: string; retention_days: number; observing_since: number } | null;
    };

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

const REFUSAL_TEXT: Record<RosterRefusalReason, string> = {
  held_key_superseded:
    "no roster: this device's key has a verified successor — it was rotated away",
  duplicate_key:
    "no roster: the key this device holds is its own ancestor (a rotation back to it), so the chain has no order",
  fork_at_held: "no roster: two verified histories lead to the key this device holds",
  malformed_input: "no roster: the question was malformed",
};

const SUPPRESSION_TEXT: Record<SuppressionReason, string> = {
  guardian_branch: "the chain has a branch this device is not on",
  relay_newer_key: "the relay reports a newer key; this device has not seen that rotation",
  relay_omission: "the relay is omitting entries this device holds",
  relay_unread: "the relay's roster could not be read, so this is this device's copy alone",
};

function ancestryText(a: RosterChainAncestry): string {
  const k = keyFingerprint(a.key);
  switch (a.kind) {
    case "rooted":
      return `the chain is rooted: ${k}… is this motebit's genesis key`;
    case "unrooted":
      return `ancestry proven back to ${k}… (older links, if any, are not held here)`;
    case "forked_below":
      return `the holder of ${k}… signed two predecessors of it; ancestry below it is not walked`;
    case "recovery_limited":
      return `a recovery link into ${k}… cannot be checked here (no pinned guardian); ancestry stops there`;
    case "cycle_below":
      return `the history below ${k}… repeats a key; ancestry stops there`;
  }
}

/** C6 — the view of one acquisition. `now` only words liveness windows. */
export function buildRosterView(acq: RosterAcquisition, now: number): MachineRosterView {
  if (acq.kind === "no-key") {
    return { kind: "no-key", text: "no identity key is available on this device" };
  }
  if (acq.kind === "refused") {
    return {
      kind: "no-roster",
      reason: acq.reason,
      remedy: acq.remedy,
      held: acq.held,
      detail: acq.detail,
      text: REFUSAL_TEXT[acq.reason],
    };
  }
  return viewOf(acq, now);
}

function viewOf(acq: RosterAcquired, now: number): MachineRosterView {
  const v = acq.verdict;
  const head = v.chain_head.public_key;
  const chain = new Set(acq.chain.chain);
  const known = new Set(acq.knownDeviceKeys);
  const served = acq.served;
  const rows = served
    ? [
        ...served.liveness.rows,
        ...served.liveness.live_unenrolled.map((r) => ({ ...r, last_seen_at: null })),
      ]
    : [];
  const consumed = new Set<number>();
  const take = (deviceId: string, key: string): (typeof rows)[number] | null => {
    const i = rows.findIndex(
      (r, n) => !consumed.has(n) && r.device_id === deviceId && r.bound_under === key,
    );
    if (i < 0) return null;
    consumed.add(i);
    return rows[i]!;
  };
  const lines: RosterLine[] = [];
  const me = acq.deviceId;
  const suffix = (d: string): string => (d === me ? " (this device)" : "");

  // 1. Active, joined on (device_id, head).
  for (const m of v.active) {
    const row = take(m.device_id, head);
    let liveness: LineLiveness;
    let live: string;
    if (served == null) {
      liveness = { state: "unknown" };
      live = "liveness unknown (the relay was not read)";
    } else if (row && row.sockets_open > 0) {
      liveness = { state: "open", sockets: row.sockets_open };
      live = "the relay believes a socket is open (no heartbeat yet)";
    } else if (row && row.last_seen_at != null) {
      liveness = { state: "last-seen", at: row.last_seen_at };
      live = `last seen ${iso(row.last_seen_at)}`;
    } else {
      const windowDays = served.liveness.retention_days;
      const since = served.liveness.observing_since;
      const windowFull = since <= now - windowDays * DAY_MS + DAY_MS;
      liveness = { state: "not-observed", since, windowDays, windowFull };
      live = windowFull
        ? `not observed in the last ${windowDays} days`
        : `not observed since ${iso(since)}, when this relay began observing`;
    }
    lines.push({
      kind: "active",
      device_id: m.device_id,
      this_device: m.device_id === me,
      entries: m.entries.length,
      liveness,
      text: `${m.device_id}${suffix(m.device_id)} — active; ${live}`,
    });
  }

  // Retired lines consume a current-key row: "retired, but connected".
  const retiredLines: RosterLine[] = [];
  for (const m of v.retired) {
    const row = take(m.device_id, head);
    const connected = row != null && row.sockets_open > 0;
    // Retired under the CURRENT key, but its enrolment is on an older one:
    // the retirement is the sovereign's, the status is still advisory
    // (spec §6 Step 4) — never "retired at an older key".
    const ids = new Set(m.entries.map((e) => e.enrollment_id));
    const byHead = acq.inputs.retirements.some(
      (r) =>
        typeof r === "object" &&
        r !== null &&
        (r as { public_key?: unknown }).public_key === head &&
        ids.has((r as { enrollment_id?: unknown }).enrollment_id as string),
    );
    const how = m.authenticated
      ? "retired under the current key"
      : byHead
        ? "retired (advisory: its enrolment is on an older key)"
        : "retired at an older key (advisory)";
    retiredLines.push({
      kind: "retired",
      device_id: m.device_id,
      this_device: m.device_id === me,
      authenticated: m.authenticated,
      connected,
      text: `${m.device_id}${suffix(m.device_id)} — ${connected ? "retired, but connected" : how}${connected ? ` (${how})` : ""}`,
    });
  }

  // 2–5. What is left, by precedence.
  const hasLine = new Set([...v.active, ...v.retired, ...v.superseded].map((m) => m.device_id));
  rows.forEach((r, i) => {
    if (consumed.has(i)) return;
    const base = {
      device_id: r.device_id,
      bound_under: r.bound_under,
      sockets_open: r.sockets_open,
    };
    const kf = keyFingerprint(r.bound_under);
    if (chain.has(r.bound_under) && r.bound_under !== head) {
      lines.push({
        kind: "superseded-key-socket",
        ...base,
        last_seen_at: r.last_seen_at,
        text:
          r.sockets_open > 0
            ? `${r.device_id} — socket open under a superseded key (${kf}…): this machine's daemon before it restarted, or any holder of that key`
            : `${r.device_id} — last seen under a superseded key (${kf}…)${r.last_seen_at != null ? ` at ${iso(r.last_seen_at)}` : ""}`,
      });
    } else if (known.has(r.bound_under)) {
      lines.push({
        kind: "linked-device",
        ...base,
        text: `${r.device_id} — a linked device without the identity key (${kf}…)`,
      });
    } else if (hasLine.has(r.device_id) && !chain.has(r.bound_under)) {
      lines.push({
        kind: "unplaced-key-socket",
        ...base,
        text: `${r.device_id} — connected under a key this device cannot place in this motebit's chain (${kf}…)`,
      });
    } else {
      lines.push({
        kind: "not-in-roster",
        ...base,
        text: `${r.device_id} — connected, not in the roster${r.bound_under === head && hasLine.has(r.device_id) ? " under the current key" : ""}`,
      });
    }
  });

  // 6. Superseded lines: advisory, not covered.
  for (const m of v.superseded) {
    const key = acq.chain.chain[m.epoch] ?? "";
    lines.push({
      kind: "superseded",
      device_id: m.device_id,
      this_device: m.device_id === me,
      key,
      text: `${m.device_id}${suffix(m.device_id)} — superseded (enrolled under ${keyFingerprint(key)}…); advisory, not covered`,
    });
  }
  lines.push(...retiredLines);

  // R25 — enrolments under keys this device cannot place: counted in "not covered".
  const deviceOfId = new Map<string, { device_id: string; key: string }>();
  for (const e of acq.enrollmentIndex) {
    deviceOfId.set(e.id, { device_id: e.device_id, key: e.public_key });
  }
  const unplaced = new Map<string, { key: string; linked: boolean }>();
  for (const r of v.rejected) {
    if (r.kind !== "enrollment" || r.reason !== "untrusted_key" || r.id == null) continue;
    const hit = deviceOfId.get(r.id);
    if (hit == null || hasLine.has(hit.device_id) || unplaced.has(hit.device_id)) continue;
    unplaced.set(hit.device_id, { key: hit.key, linked: known.has(hit.key) });
  }
  for (const [device_id, u] of [...unplaced].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push({
      kind: "unplaced-enrollment",
      device_id,
      key: u.key,
      linked_device: u.linked,
      text: u.linked
        ? `${device_id} — enrolled under a linked device's key (${keyFingerprint(u.key)}…), not the identity key; not covered`
        : `${device_id} — enrolled under a key this device cannot place in its chain (older or newer) (${keyFingerprint(u.key)}…); not covered`,
    });
  }

  // Notes: ancestry, branches, what the relay is missing, hints.
  const notes: RosterNote[] = [{ kind: "ancestry", text: ancestryText(acq.chain.ancestry) }];
  for (const b of acq.chain.branches) {
    notes.push({
      kind: "branch",
      at: b.at,
      to: b.to,
      guardian_verified: b.guardian_verified,
      text: b.guardian_verified
        ? `the chain has a branch this device is not on: a guardian recovery from ${keyFingerprint(b.at)}… to ${keyFingerprint(b.to)}…`
        : `the holder of ${keyFingerprint(b.at)}… signed two successors (one to ${keyFingerprint(b.to)}…, a branch this device is not on)`,
    });
  }
  if (acq.succession.missingLinks > 0) {
    const n = acq.succession.missingLinks;
    notes.push({
      kind: "missing-links",
      count: n,
      text: `the relay is missing ${n} ${plural(n, "link", "links")} of the key chain this device holds`,
    });
  }
  if (acq.omitted.length > 0) {
    const n = acq.omitted.length;
    notes.push({
      kind: "omitted",
      count: n,
      text: `the relay is missing ${n} ${plural(n, "entry", "entries")} this device holds (re-presented; still missing)`,
    });
  }
  if (acq.suppressed.includes("relay_newer_key") && acq.succession.hint != null) {
    notes.push({
      kind: "relay-newer-key",
      key: acq.succession.hint,
      text: `the relay reports a newer key (${keyFingerprint(acq.succession.hint)}…); this device has not seen that rotation`,
    });
  }
  if (served == null) {
    notes.push({
      kind: "relay-unread",
      reason: acq.fetchError ?? "",
      text: `the relay's roster could not be read (${acq.fetchError ?? "no answer"}); shown from this device's copy`,
    });
  }
  if (acq.cache === "corrupt") {
    notes.push({
      kind: "cache-corrupt",
      text: "this device's roster copy could not be read and was kept aside; nothing was minted",
    });
  }
  // 8. Two successive reads, and still only "may".
  // Only over a read that happened: with no GET the replica's pairs are the
  // previous read's, and "two successive reads" would be one read twice.
  const before = new Set(served != null ? acq.previousAmbiguous : []);
  for (const p of acq.replica.ambiguous.pairs) {
    if (!before.has(p)) continue;
    const [device_id, key] = JSON.parse(p) as [string, string];
    notes.push({
      kind: "ambiguous",
      device_id,
      key,
      text: `two machines may share the id ${device_id} (a copied configuration); more than one socket is open for it`,
    });
  }
  // N12 — after a restore gave this device a fresh id, offer to retire the prior line.
  if (!hasLine.has(me)) {
    for (const prior of acq.replica.own_device_ids) {
      if (prior === me) continue;
      if (
        v.active.some((m) => m.device_id === prior) ||
        v.superseded.some((m) => m.device_id === prior)
      ) {
        notes.push({
          kind: "prior-line",
          device_id: prior,
          text: `this device enrolled earlier as ${prior}; if that was this machine before a restore, its line can be retired`,
        });
      }
    }
  }

  // 10. A quantifier only over an ok verdict with nothing suppressed.
  const notCovered = v.superseded.length + unplaced.size;
  const claim: RosterClaim | null =
    acq.suppressed.length > 0
      ? null
      : {
          active: v.active.length,
          superseded: v.superseded.length,
          unplaced: unplaced.size,
          text:
            `${v.active.length} ${plural(v.active.length, "machine", "machines")} on the current key ${keyFingerprint(head)}…` +
            (notCovered > 0
              ? `; not covered: ${[
                  v.superseded.length > 0
                    ? `${v.superseded.length} ${plural(v.superseded.length, "line", "lines")} on superseded keys`
                    : null,
                  unplaced.size > 0
                    ? `${unplaced.size} under keys this device cannot place in its chain (older or newer)`
                    : null,
                ]
                  .filter((s) => s != null)
                  .join(", ")}`
              : ""),
        };

  return {
    kind: "roster",
    head: { public_key: head, fingerprint: keyFingerprint(head) },
    this_device: me,
    claim,
    empty:
      lines.length > 0
        ? null
        : claim != null
          ? { kind: "none-enrolled", text: "no machine has enrolled yet" }
          : {
              kind: "nothing-held",
              text: "nothing is held on this device, and the roster could not be confirmed",
            },
    suppressed: acq.suppressed,
    lines,
    notes,
    relay: served
      ? {
          observed_by: served.liveness.observed_by,
          retention_days: served.liveness.retention_days,
          observing_since: served.liveness.observing_since,
        }
      : null,
  };
}

/** The words for a suppression reason (why no count is shown). */
export function suppressionText(reason: SuppressionReason): string {
  return SUPPRESSION_TEXT[reason];
}
