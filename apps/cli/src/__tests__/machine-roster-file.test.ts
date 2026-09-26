/**
 * `~/.motebit/machine-roster.json` — the CLI's replica file
 * (`docs/proposals/machine-roster-clients-v1.md` C5; key-file-durability
 * R1–R3): three-way read, a corrupt file moved aside (bytes kept, never
 * overwritten), owner-only atomic writes, merges that never drop an
 * entry — and the terminal wording of the roster's outcomes.
 */
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { bytesToHex, generateKeypair, signHostEnrollment } from "@motebit/encryption";
import { emptyReplica, type MachineRosterView } from "@motebit/surface-kit";

import { describeEnsureOutcome, remedyText } from "../machine-roster.js";
import {
  MACHINE_ROSTER_PATH,
  loadReplica,
  machineRosterPath,
  saveReplica,
} from "../machine-roster-file.js";
import { describeEnroll, describeRetire, formatRosterView } from "../subcommands/machines.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "motebit-roster-file-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const MID = "0190f1a2-0000-7000-8000-000000000001";
const MID2 = "0190f1a2-0000-7000-8000-000000000002";

async function enrollment(deviceId: string) {
  const kp = await generateKeypair();
  return signHostEnrollment(
    { motebit_id: MID, device_id: deviceId, public_key: bytesToHex(kp.publicKey), enrolled_at: 1 },
    kp.privateKey,
  );
}

describe("the replica file", () => {
  it("lives at ~/.motebit/machine-roster.json", () => {
    expect(
      MACHINE_ROSTER_PATH.endsWith(join(".motebit", "machine-roster.json")) ||
        MACHINE_ROSTER_PATH.endsWith("machine-roster.json"),
    ).toBe(true);
    expect(machineRosterPath(dir)).toBe(join(dir, "machine-roster.json"));
  });

  it("absent is absent; a save is owner-only and reads back", async () => {
    expect(loadReplica(MID, dir)).toEqual({ kind: "absent" });
    const r = { ...emptyReplica(MID), enrollments: [await enrollment("vps")] };
    saveReplica(r, dir);
    expect(statSync(machineRosterPath(dir)).mode & 0o777).toBe(0o600);
    expect(loadReplica(MID, dir)).toEqual({ kind: "value", replica: r });
    // Another motebit's replica is absent, not someone else's.
    expect(loadReplica(MID2, dir)).toEqual({ kind: "absent" });
  });

  it("saves merge — nothing already stored is ever dropped, across identities too", async () => {
    const x = await enrollment("x");
    const y = await enrollment("y");
    saveReplica({ ...emptyReplica(MID), enrollments: [x] }, dir);
    saveReplica({ ...emptyReplica(MID2) }, dir);
    saveReplica({ ...emptyReplica(MID), enrollments: [y] }, dir);
    const read = loadReplica(MID, dir);
    expect(read.kind === "value" && read.replica.enrollments).toEqual([x, y]);
    expect(loadReplica(MID2, dir).kind).toBe("value");
  });

  it.each([
    ["not JSON", "{{{"],
    ["the wrong shape", JSON.stringify({ version: 2, replicas: {} })],
    [
      "one unreadable replica",
      JSON.stringify({ version: 1, replicas: { [MID]: { version: 1, motebit_id: MID } } }),
    ],
  ])(
    "%s → corrupt: moved aside with its bytes, never overwritten; the name is free",
    (_, bytes) => {
      writeFileSync(machineRosterPath(dir), bytes);
      expect(loadReplica(MID, dir)).toEqual({ kind: "corrupt" });
      const aside = readdirSync(dir).filter((f) => f.startsWith("machine-roster.json.corrupt-"));
      expect(aside).toHaveLength(1);
      expect(readFileSync(join(dir, aside[0]!), "utf-8")).toBe(bytes);
      expect(loadReplica(MID, dir)).toEqual({ kind: "absent" });
      saveReplica(emptyReplica(MID), dir);
      expect(readFileSync(join(dir, aside[0]!), "utf-8")).toBe(bytes);
      expect(loadReplica(MID, dir).kind).toBe("value");
    },
  );

  it("a save over a corrupt file keeps the corrupt bytes aside first", () => {
    writeFileSync(machineRosterPath(dir), "not json");
    saveReplica(emptyReplica(MID), dir);
    const aside = readdirSync(dir).filter((f) => f.startsWith("machine-roster.json.corrupt-"));
    expect(aside.map((f) => readFileSync(join(dir, f), "utf-8"))).toEqual(["not json"]);
  });
});

describe("terminal wording", () => {
  it("remedies name the command", () => {
    expect(remedyText("finish-rotation")).toMatch(/`motebit rotate` resumes it/);
    expect(remedyText("restart")).toMatch(/restart it/);
    expect(remedyText("restore")).toMatch(/restore with the current key's seed or motebit.md/);
    expect(remedyText("rotate")).toMatch(/motebit rotate/);
    expect(remedyText("report")).toMatch(/report/);
  });

  it("a start says at most one line, and nothing when the line is simply active", () => {
    const p = { taken: 1, notTaken: [], rosterFull: [] };
    const line = (o: Parameters<typeof describeEnsureOutcome>[0]) =>
      describeEnsureOutcome(o, "vps-7f3a");
    expect(line({ kind: "active", presented: p })).toBeNull();
    expect(line({ kind: "no-key" })).toBeNull();
    expect(
      line({
        kind: "active",
        presented: { ...p, notTaken: [{ id: "x", reason: "413" }] },
      }),
    ).toMatch(/1 not taken/);
    expect(
      line({
        kind: "minted",
        enrollmentId: "a".repeat(64),
        firstLine: true,
        presented: { ...p, rosterFull: ["x"] },
      }),
    ).toMatch(/enrolled this machine .*roster is full/);
    expect(line({ kind: "retired", presented: p })).toMatch(
      /retired from the roster but running .*`motebit machines enroll vps-7f3a`.*or rotate the key/,
    );
    // P6 — the real id, never a placeholder.
    for (const o of [
      { kind: "retired" as const, presented: p },
      { kind: "superseded" as const, frozen: null, presented: p },
      { kind: "unplaced" as const, count: 1, presented: p },
    ]) {
      expect(line(o)).toMatch(/machines enroll vps-7f3a/);
      expect(line(o)).not.toMatch(/<this device_id>/);
    }
    expect(line({ kind: "superseded", frozen: null, presented: p })).toMatch(
      /superseded key and not covered/,
    );
    expect(
      line({
        kind: "unknown",
        why: "fetch-failed",
        status: "none",
        detail: "down",
      }),
    ).toMatch(/not updated this start — down; the daemon runs regardless/);
    expect(
      line({
        kind: "refused",
        reason: "held_key_superseded",
        detail: "",
        remedy: "restart",
      }),
    ).toMatch(/no roster — this process holds a key/);
  });

  it("a refused roster prints no roster and its remedy — never an empty roster", () => {
    const view: MachineRosterView = {
      kind: "no-roster",
      reason: "held_key_superseded",
      remedy: "restore",
      held: "ab".repeat(32),
      detail: "",
      text: "no roster: this device's key has a verified successor — it was rotated away",
    };
    const out = formatRosterView(view, MID).join("\n");
    expect(out).toMatch(/^No roster for/);
    expect(out).not.toMatch(/machines? on the current key/);
    expect(out).toMatch(/Next: this machine's key was rotated away/);
  });

  it("no count when suppressed, and the reason is said", () => {
    const view: MachineRosterView = {
      kind: "roster",
      head: { public_key: "ab".repeat(32), fingerprint: "abababababababab" },
      this_device: "d",
      claim: null,
      suppressed: ["relay_newer_key"],
      lines: [],
      notes: [
        { kind: "prior-line", device_id: "old", text: "this device enrolled earlier as old" },
      ],
      relay: null,
      empty: {
        kind: "nothing-held",
        text: "nothing is held on this device, and the roster could not be confirmed",
      },
    };
    const out = formatRosterView(view, MID).join("\n");
    expect(out).toMatch(/No count: the relay reports a newer key/);
    expect(out).toMatch(/motebit machines retire old/);
    // W1 — a suppressed, empty view never claims that no machine enrolled.
    expect(out).toMatch(/nothing is held on this device/);
    expect(out).not.toMatch(/no machine has enrolled/);
  });

  it("an empty roster over an ok verdict says no machine has enrolled", () => {
    const view: MachineRosterView = {
      kind: "roster",
      head: { public_key: "ab".repeat(32), fingerprint: "abababababababab" },
      this_device: "d",
      claim: {
        active: 0,
        superseded: 0,
        unplaced: 0,
        text: "0 machines on the current key abababababababab…",
      },
      suppressed: [],
      lines: [],
      notes: [],
      relay: null,
      empty: { kind: "none-enrolled", text: "no machine has enrolled yet" },
    };
    expect(formatRosterView(view, MID).join("\n")).toMatch(/\(no machine has enrolled yet\)/);
  });

  it("P3 — retire and enroll say what the relay did with the act", () => {
    const own = "a".repeat(64);
    const full = describeRetire({
      kind: "retired",
      deviceId: "v",
      retirementIds: [own],
      advisory: false,
      presented: { taken: 0, notTaken: [], rosterFull: [own] },
    });
    expect(full.lines.join("\n")).toMatch(
      /REFUSED this retirement for good \(its roster is full\)/,
    );
    const later = describeEnroll({
      kind: "enrolled",
      deviceId: "v",
      enrollmentId: own,
      presented: { taken: 0, notTaken: [{ id: own, reason: "status 500" }], rosterFull: [] },
    });
    expect(later.lines.join("\n")).toMatch(/did not take this enrolment yet/);
    const enrolFull = describeEnroll({
      kind: "enrolled",
      deviceId: "v",
      enrollmentId: own,
      presented: { taken: 1, notTaken: [], rosterFull: [own, "b".repeat(64)] },
    });
    expect(enrolFull.lines.join("\n")).toMatch(/REFUSED this enrolment for good/);
    expect(enrolFull.lines.join("\n")).toMatch(/refused 1 other held entry for good/);
    const clean = describeEnroll({
      kind: "enrolled",
      deviceId: "v",
      enrollmentId: own,
      presented: { taken: 1, notTaken: [], rosterFull: [] },
    });
    expect(clean.lines).toHaveLength(1);
  });

  it("retire and enroll outcomes", () => {
    const p = { taken: 1, notTaken: [], rosterFull: [] };
    expect(
      describeRetire({
        kind: "retired",
        deviceId: "v",
        retirementIds: ["x"],
        advisory: true,
        presented: p,
      }),
    ).toMatchObject({
      ok: true,
      lines: expect.arrayContaining([expect.stringMatching(/advisory/)]),
    });
    expect(describeRetire({ kind: "not-enrolled", deviceId: "v" }).ok).toBe(false);
    expect(describeRetire({ kind: "unknown-device", deviceId: "v" }).ok).toBe(false);
    expect(describeRetire({ kind: "already-retired", deviceId: "v" }).ok).toBe(true);
    expect(describeRetire({ kind: "unreadable", detail: "down" }).lines[0]).toMatch(
      /Nothing was signed/,
    );
    expect(
      describeEnroll({ kind: "needs-force", deviceId: "v", why: "no-such-line" }).lines.join(" "),
    ).toMatch(/typo .*--force/);
    expect(
      describeEnroll({ kind: "needs-force", deviceId: "v", why: "all-superseded" }).lines[0],
    ).toMatch(/superseded key/);
    expect(
      describeEnroll({ kind: "needs-force", deviceId: "v", why: "linked-device" }).lines[0],
    ).toMatch(/linked device/);
    expect(
      describeEnroll({
        kind: "enrolled",
        deviceId: "v",
        enrollmentId: "a".repeat(64),
        presented: p,
      }).ok,
    ).toBe(true);
  });
});

describe("N8 — whatever announces unattended_runtime passes through the mint step", () => {
  it("every CLI source that announces the capability to a relay calls enrollOnAnnounce as often", () => {
    const src = join(__dirname, "..");
    const files = [
      ...readdirSync(src).map((f) => join(src, f)),
      ...readdirSync(join(src, "subcommands")).map((f) => join(src, "subcommands", f)),
    ].filter((f) => f.endsWith(".ts"));
    let announcers = 0;
    for (const f of files) {
      // `setLocalCapabilities` is the runtime's own list, not an announcement
      // to a relay; every other mention is a socket's announced set.
      const text = readFileSync(f, "utf-8").replace(/setLocalCapabilities\(\[[\s\S]*?\]\)/g, "");
      const announces = (text.match(/DeviceCapability\.UnattendedRuntime/g) ?? []).length;
      if (announces === 0) continue;
      announcers++;
      const enrols = (text.match(/\benrollOnAnnounce\(/g) ?? []).length;
      expect(
        enrols,
        `${f} announces unattended_runtime ${announces}× but enrols ${enrols}×`,
      ).toBeGreaterThanOrEqual(announces);
    }
    expect(announcers).toBeGreaterThan(0);
  });
});

describe("R21 option (a) — `motebit rotate` captures BEFORE it sends the rotation", () => {
  it("rotate.ts calls rosterCaptureBeforeRotate before performRotation, and the hook after", () => {
    const src = readFileSync(join(__dirname, "..", "subcommands", "rotate.ts"), "utf-8");
    const capture = src.indexOf("await rosterCaptureBeforeRotate(");
    const rotate = src.indexOf("await performRotation(");
    const hook = src.indexOf("await rosterHookAfterRotate(");
    expect(capture).toBeGreaterThan(0);
    expect(rotate).toBeGreaterThan(capture);
    expect(hook).toBeGreaterThan(rotate);
  });
});

describe("F (#786) — the CLI's words for lines this device cannot place", () => {
  it("retire: unplaceable lines are named, never 'never enrolled' or 'not on this roster'", () => {
    const out = describeRetire({ kind: "unplaced-lines", deviceId: "vps", count: 2 });
    const text = out.lines.join("\n");
    expect(out.ok).toBe(false);
    expect(text).toMatch(/vps has 2 enrolments under keys this device cannot place in its chain/);
    expect(text).toMatch(/nothing is retirable from here/);
    expect(text).not.toMatch(/never enrolled|not on this roster|nothing to retire\./);
  });

  it("retire: the no-enrolment wordings are conditioned on what this device can see", () => {
    expect(describeRetire({ kind: "not-enrolled", deviceId: "t" }).lines[0]).toMatch(
      /this device can see no enrolment for it/,
    );
    expect(describeRetire({ kind: "unknown-device", deviceId: "t" }).lines[0]).toMatch(
      /on the roster this device can see/,
    );
  });

  it("enroll: unplaceable lines are not 'no line'", () => {
    const out = describeEnroll({
      kind: "needs-force",
      deviceId: "vps",
      why: "unplaced-lines",
      count: 1,
    });
    expect(out.lines[0]).toMatch(/vps has 1 enrolment under keys this device cannot place/);
    expect(out.lines[0]).not.toMatch(/no line/);
    expect(
      describeEnroll({ kind: "needs-force", deviceId: "x", why: "no-such-line" }).lines[0],
    ).toMatch(/this device can see no line for x/);
  });

  it("after `motebit rotate`: no daemon wording", () => {
    const p = { taken: 1, notTaken: [], rosterFull: [] };
    const retired = describeEnsureOutcome({ kind: "retired", presented: p }, "vps", "rotate");
    expect(retired).toMatch(/not enrolled under the new key/);
    expect(retired).not.toMatch(/running|daemon/);
    const unknown = describeEnsureOutcome(
      { kind: "unknown", why: "fetch-failed", status: "none", detail: "down" },
      "vps",
      "rotate",
    );
    expect(unknown).toMatch(
      /not updated after the rotation — down; the rotation itself is complete/,
    );
    expect(unknown).not.toMatch(/daemon|this start/);
  });
});

describe("#790 round 1 — CLI wording", () => {
  const p = { taken: 1, notTaken: [], rosterFull: [] };

  it("P1: the unplaced start/rotate line says what is known, never 'not enrolled'", () => {
    for (const ctx of ["start", "rotate"] as const) {
      const line = describeEnsureOutcome({ kind: "unplaced", count: 1, presented: p }, "vps", ctx);
      expect(line).toMatch(
        /under keys this device cannot place in its key chain, or could not be verified/,
      );
      expect(line).toMatch(
        ctx === "rotate" ? /not updated after the rotation/ : /not updated this start/,
      );
      expect(line).not.toMatch(/not enrolled/);
    }
  });

  it("a retirement the relay refused as unauthorized is not 'presented again'", () => {
    const own = "a".repeat(64);
    const out = describeRetire({
      kind: "retired",
      deviceId: "vps",
      retirementIds: [own],
      advisory: false,
      presented: { taken: 0, notTaken: [{ id: own, reason: "status 401" }], rosterFull: [] },
    });
    const text = out.lines.join("\n");
    expect(text).toMatch(
      /refused this retirement \(not authorized\): this device's key may have been rotated away/,
    );
    expect(text).not.toMatch(/presented again/);
  });
});
