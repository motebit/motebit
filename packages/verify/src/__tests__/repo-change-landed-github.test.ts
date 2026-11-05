/**
 * The landed mode's time rule (spec/repo-change-v1.md §9.1) on REAL vectors:
 * GitHub's own web-flow keys as committed in `.motebit/operator-keys/github.json`
 * (read from that file, never a copy), and a real squash commit GitHub signed
 * on motebit's `main`, its raw object bytes committed as a fixture and
 * re-hashed to its id. The rest of the landed suite uses a stand-in signer;
 * this file is the check that the committed pins accept a genuine landing and
 * refuse an altered, unpinned or out-of-window one.
 *
 * Every verdict comes from the verifier's public entry points
 * (`parseOperatorSigningKeys`, `parseCommit`, `acceptLandingTime`), the path
 * `verifyRepoChangeLanded` takes. Keys other than GitHub's are ephemeral.
 */
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  acceptLandingTime,
  gitObjectId,
  parseCommit,
  parseOperatorSigningKeys,
  parsePinnedSigningKeys,
} from "../git/index.js";
import type { LandedTime } from "../git/index.js";
import { armor, testSigningKey } from "./helpers/github-signer.js";

const ROOT = new URL("../../../../", import.meta.url);
/** The committed pinned set. */
const PINS_PATH = fileURLToPath(new URL(".motebit/operator-keys/github.json", ROOT));
/** What GitHub publishes at https://github.com/web-flow.gpg, as fetched (README beside it). */
const PUBLISHED_PATH = fileURLToPath(new URL(".motebit/operator-keys/github-web-flow.gpg", ROOT));
const PINS = fs.readFileSync(PINS_PATH, "utf8");

/** Squash commit of #1226 on main, committed and signed by GitHub. */
const LANDING = "ef63bccc33ad3d28b70873f2d29a6a55e81a4e9c";
const RAW = fs.readFileSync(new URL("./fixtures/github-landing-ef63bccc3.commit", import.meta.url));
/** Its committer time, 2026-11-04T16:40:32Z. */
const T = 1_793_810_432;

/** GitHub's key from 2017-08-16, retired 2024-01-16T20:00:00Z. */
const RETIRED = "5de3e0509c47ea3cf04a42d34aee18f83afdeb23";
const RETIRED_UNTIL = 1_705_435_200;
/** GitHub's key from 2024-01-16: the one that signed the landing. */
const CURRENT = "968479a1aff927e37d1a566bb5690eeebb952194";

interface PinEntry {
  fingerprint: string;
  armored: string;
  trusted_until: number | null;
}

/** The committed pinned set's entries, to derive variants of through the file format. */
function entries(): PinEntry[] {
  return (JSON.parse(PINS) as { keys: PinEntry[] }).keys;
}

/** A pinned set file of `keys`, parsed by the verifier's own parser. */
function pins(keys: readonly PinEntry[]): ReturnType<typeof parseOperatorSigningKeys> {
  return parseOperatorSigningKeys(
    JSON.stringify({ spec: "motebit/operator-signing-keys@1.0", keys }),
  );
}

/** The committed set with one key's window replaced. */
function withWindow(fingerprint: string, until: number | null): PinEntry[] {
  return entries().map((e) => (e.fingerprint === fingerprint ? { ...e, trusted_until: until } : e));
}

function judge(raw: Buffer, keys = parseOperatorSigningKeys(PINS)): LandedTime {
  const c = parseCommit(LANDING, raw, 20);
  return acceptLandingTime(raw, c.committer, "sha1", keys);
}

function expectAccepted(t: LandedTime): void {
  expect(t).toEqual({
    landedAt: T * 1000,
    committer: `GitHub <noreply@github.com> ${T} +0000`,
    signer: CURRENT,
    problem: null,
  });
}

function expectRefused(t: LandedTime, reason: RegExp): void {
  expect(t.landedAt).toBeNull();
  expect(t.problem ?? "").toMatch(reason);
}

/** The base64 body of an armored block (between the blank line and the CRC line), decoded. */
function armorBody(armored: string, indent = ""): Buffer {
  const lines = armored.split("\n").map((l) => l.slice(indent.length));
  const start = lines.indexOf("") + 1;
  const end = lines.findIndex((l, i) => i >= start && l.startsWith("="));
  return Buffer.from(lines.slice(start, end).join(""), "base64");
}

const SIG_END = " -----END PGP SIGNATURE-----\n";

/**
 * The landing with its `gpgsig` packet bytes passed through `mutate`, then
 * re-armored with a correct CRC-24 in GitHub's layout. Identity gives back
 * the exact bytes (asserted below), so a change is only the mutation.
 */
function resigned(mutate: (packet: Buffer) => Buffer): Buffer {
  const text = RAW.toString("latin1");
  const start = text.indexOf("\ngpgsig ") + 1;
  const end = text.indexOf(SIG_END, start) + SIG_END.length;
  const block = text.slice(start, end).slice("gpgsig ".length);
  const packet = mutate(armorBody(` ${block}`, " "));
  const lines = armor("PGP SIGNATURE", packet).replace(/\n$/, "").split("\n");
  const header = [`gpgsig ${lines[0]!}`, ...lines.slice(1).map((l) => ` ${l}`)].join("\n");
  // What follows the END line (GitHub's empty continuation line, the message) is kept.
  return Buffer.from(`${text.slice(0, start)}${header}\n${text.slice(end)}`, "latin1");
}

describe("real GitHub landings on main, under the committed pinned set", () => {
  it("the fixture is the landing's exact object bytes, committed and signed by GitHub", () => {
    expect(gitObjectId("commit", RAW, "sha1")).toBe(LANDING);
    const c = parseCommit(LANDING, RAW, 20);
    expect(c.committer).toBe(`GitHub <noreply@github.com> ${T} +0000`);
    expect(c.parents).toEqual(["a689710643bd3d22ccaaaf61b71a9e3718c8228f"]);
    expect(RAW.toString("latin1")).toMatch(/\ngpgsig -----BEGIN PGP SIGNATURE-----\n/);
  });

  it("the committed set pins both web-flow keys, the 2017 key retired at 2024-01-16T20:00:00Z", () => {
    const keys = parseOperatorSigningKeys(PINS);
    expect(keys.map((k) => [k.fingerprint, k.createdAt, k.trustedUntil])).toEqual([
      [RETIRED, 1_502_898_241, RETIRED_UNTIL],
      [CURRENT, 1_705_428_342, null],
    ]);
    expect(new Date(RETIRED_UNTIL * 1000).toISOString()).toBe("2024-01-16T20:00:00.000Z");
  });

  it("each pinned entry is GitHub's published key packets, unaltered", () => {
    const published = fs.readFileSync(PUBLISHED_PATH, "utf8");
    expect(parsePinnedSigningKeys(published).map((k) => k.fingerprint)).toEqual([RETIRED, CURRENT]);
    const split = Buffer.concat(entries().map((e) => armorBody(e.armored)));
    expect(split.equals(armorBody(published))).toBe(true);
  });

  it("accepts the landing at its committer time, signed by the current key", () => {
    expectAccepted(judge(RAW));
  });

  it("re-armoring the signature unchanged gives back the landing's exact bytes", () => {
    expect(resigned((p) => p).equals(RAW)).toBe(true);
  });

  it("refuses the landing with one byte of the signed payload flipped", () => {
    const text = RAW.toString("latin1");
    const altered = Buffer.from(text.replace("(#1226)\n", "(#1227)\n"), "latin1");
    expect(altered.length).toBe(RAW.length);
    expect(altered.equals(RAW)).toBe(false);
    const t = judge(altered);
    expectRefused(t, /left 16 bits do not match the digest|RSA signature does not verify/);
    expect(t.signer).toBeNull();
  });

  it("refuses the landing with one byte of the RSA signature flipped (a valid armor and CRC)", () => {
    const altered = resigned((p) => {
      const q = Buffer.from(p);
      q[q.length - 1] = q[q.length - 1]! ^ 0x01;
      return q;
    });
    expect(altered.equals(RAW)).toBe(false);
    const t = judge(altered);
    expectRefused(t, /the RSA signature does not verify under the pinned key/);
    expect(t.signer).toBeNull();
  });

  it("refuses the landing with one character of the armored signature flipped", () => {
    const text = RAW.toString("latin1");
    const at = text.indexOf("\n wsFc") + 10;
    const ch = text[at] === "A" ? "B" : "A";
    const altered = Buffer.from(text.slice(0, at) + ch + text.slice(at + 1), "latin1");
    expectRefused(judge(altered), /the signature: .*CRC-24 does not match/);
  });

  it("refuses the landing when only the retired key is pinned", () => {
    const keys = pins(entries().filter((e) => e.fingerprint === RETIRED));
    expectRefused(judge(RAW, keys), /is not a pinned key/);
  });

  it("refuses the landing when only an ephemeral key is pinned", () => {
    const k = testSigningKey();
    const keys = pins([{ fingerprint: k.fingerprint, armored: k.armored, trusted_until: null }]);
    expectRefused(judge(RAW, keys), /is not a pinned key/);
  });

  it("refuses the landing when the current key's window closed at or before the committer time", () => {
    for (const until of [T, T - 1, RETIRED_UNTIL + 1]) {
      const t = judge(RAW, pins(withWindow(CURRENT, until)));
      expectRefused(t, new RegExp(`at or after the pinned key's trusted_until \\(${until}\\)`));
      expect(t.signer).toBe(CURRENT);
    }
  });

  it("accepts the landing when the current key's window closes just after the committer time", () => {
    expectAccepted(judge(RAW, pins(withWindow(CURRENT, T + 1))));
  });

  it("accepts the landing when only the retired key's window is closed, at any time", () => {
    expect(entries().find((e) => e.fingerprint === RETIRED)!.trusted_until).toBe(RETIRED_UNTIL);
    expect(entries().find((e) => e.fingerprint === CURRENT)!.trusted_until).toBeNull();
    for (const until of [0, RETIRED_UNTIL, T, T + 1]) {
      expectAccepted(judge(RAW, pins(withWindow(RETIRED, until))));
    }
  });
});
