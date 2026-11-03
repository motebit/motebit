/**
 * `motebit-verify repo-change --landed` (offline on a landed change,
 * spec/repo-change-v1.md §7, §9) over real fixture repositories: one
 * positive control, then one failing case per rule — the landing time
 * (committer and pinned OpenPGP signature), each offline shape check, the
 * inputs read at the squash commit's parent, spent on the parent's history,
 * and an object store that lies (bytes that do not hash to their id, a forged
 * commit-graph, a duplicate-name tree). Each asserts its rule's code, shape
 * text or refusal, so removing the rule turns its test red (the repo-root
 * tamper file `verify-repo-change-landed.ts`). Ephemeral keys only.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isFullyVerified } from "@motebit/verifier";

import {
  acceptLandingTime,
  gitObjectId,
  openIsolatedGit,
  openRawObjects,
  parsePinnedSigningKeys,
  verifyRepoChangeLanded,
} from "../git/index.js";
import type { LandedRepoChangeReport, OperatorSigningKey } from "../git/index.js";
import { subpacket, testSigningKey } from "./helpers/github-signer.js";
import {
  LANDED_SECONDS,
  gitIn,
  landedFixture,
  pinFile,
  pinned,
  stranger,
  writeCommit,
} from "./helpers/landed-fixture.js";
import type { LandedFixture, LandedOptions } from "./helpers/landed-fixture.js";
import {
  DOC,
  POLICY,
  REPO,
  git,
  gitEnv,
  identityFile,
  parties,
} from "./helpers/repo-change-fixture.js";
import { runMain } from "./helpers/run-main.js";

let tmp = "";
beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "verify-landed-")));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function check(
  fx: LandedFixture,
  over: Partial<{ repo: string; landed: string; trustedTip: string; keys: string }> = {},
): Promise<LandedRepoChangeReport> {
  return verifyRepoChangeLanded({
    repo: over.repo ?? fx.repo,
    landed: over.landed ?? fx.squash,
    trustedTip: over.trustedTip ?? fx.tip,
    repository: REPO,
    signingKeys: over.keys ?? fx.keys,
  });
}

async function judge(
  o: LandedOptions = {},
): Promise<{ fx: LandedFixture; r: LandedRepoChangeReport }> {
  const fx = await landedFixture(tmp, o);
  return { fx, r: await check(fx) };
}

function expectRule(r: LandedRepoChangeReport, code: string, site?: string): void {
  const v = r.verification;
  const hit = v.diagnostics.failures.some(
    (f) => f.code === code && (site === undefined || f.detail.includes(site)),
  );
  expect(
    hit,
    `${code}${site ? ` (${site})` : ""} in ${JSON.stringify(v.diagnostics.failures)}`,
  ).toBe(true);
  expect(isFullyVerified(v.verdict)).toBe(false);
  expect(r.accepted).toBe(false);
}

function expectShape(r: LandedRepoChangeReport, text: string): void {
  expectRule(r, "integrity.repo_change.shape_check_failed", text);
}

/** The time was not accepted: `authority` is `unknown`, for the stated reason. */
function expectNoTime(r: LandedRepoChangeReport, reason: RegExp): void {
  expect(r.computed.time.landedAt).toBeNull();
  expect(r.computed.time.problem ?? "").toMatch(reason);
  expect(r.verification.verdict.authority).toBe("unknown");
  expectRule(r, "authority.repo_change.time_unavailable");
}

// -- Positive control ------------------------------------------------------

describe("motebit-verify repo-change --landed: a landed governed change", () => {
  it("is fully verified, pinned, fresh, with outcome completed, at the operator-recorded time", async () => {
    const { fx, r } = await judge();
    expect(r.verification.diagnostics.failures).toEqual([]);
    expect(r.computed.shapeFailures).toEqual([]);
    expect(r.computed.state.problems).toEqual([]);
    expect(isFullyVerified(r.verification.verdict)).toBe(true);
    expect(r.verification.verdict.identityBinding).toBe("pinned");
    expect(r.verification.verdict.revocation.status).toBe("fresh");
    expect(r.verification.verdict.temporalBasis).toBe("operator_recorded");
    expect(r.verification.outcome).toBe("completed");
    expect(r.accepted).toBe(true);
    expect(r.computed.parent).toBe(fx.base);
    expect(r.computed.bundlePath).toBe(fx.bundleFile);
    expect(r.computed.time).toEqual({
      landedAt: LANDED_SECONDS * 1000,
      committer: `GitHub <noreply@github.com> ${LANDED_SECONDS} +0000`,
      signer: pinned().fingerprint,
      problem: null,
    });
    expect(r.computed.input.spent).toBe(false);
    expect(Buffer.from(r.computed.input.bundle).equals(Buffer.from(fx.bundleBytes))).toBe(true);
    expect(r.computed.input.revocations?.readAt).toBe(fx.base);
    expect(r.computed.input.revocations?.freshness).toEqual({
      basis: "asserted",
      asOf: { timestamp_ms: LANDED_SECONDS * 1000 },
    });
    expect(r.verification.diagnostics.revocationsReadAt).toBe(fx.base);
  });

  it("reads a bare clone the same way, and the squash commit itself as the trusted tip", async () => {
    const fx = await landedFixture(tmp);
    const bare = path.join(tmp, "bare.git");
    git(tmp, "clone", "-q", "--bare", fx.repo, bare);
    const r = await check(fx, { repo: bare });
    expect(r.verification.diagnostics.failures).toEqual([]);
    expect(r.accepted).toBe(true);
    const r2 = await check(fx, { trustedTip: fx.squash });
    expect(r2.computed.shapeFailures).toEqual([]);
    expect(r2.accepted).toBe(true);
  });
});

// -- The landing time ---------------------------------------------------------

describe("motebit-verify repo-change --landed: the landing time is GitHub's, under a pinned key", () => {
  it("the committer is not GitHub", async () => {
    const a = await judge({ committer: "Mallory <noreply@github.com>" });
    expectNoTime(a.r, /the committer is not GitHub <noreply@github.com>/);
    const b = await judge({ committer: "GitHub <noreply@example.com>" });
    expectNoTime(b.r, /the committer is not GitHub/);
  });

  it("a malformed committer header", async () => {
    const { r } = await judge({
      raw: (b) =>
        Buffer.from(
          b.toString("latin1").replace(/^committer (.*) \+0000$/m, "committer $1"),
          "latin1",
        ),
    });
    expectNoTime(r, /the committer header is malformed/);
  });

  it("a flipped byte in the commit body", async () => {
    const { r } = await judge({
      raw: (b) =>
        Buffer.from(b.toString("latin1").replace("Fix the typo", "Fix the typO"), "latin1"),
    });
    expectNoTime(r, /left 16 bits|does not verify/);
  });

  it("a flipped byte in the signature", async () => {
    const { r } = await judge({
      sign: {
        body: (b) => {
          const c = Buffer.from(b);
          c[c.length - 1] ^= 0x01;
          return c;
        },
      },
    });
    expectNoTime(r, /the RSA signature does not verify under the pinned key/);
  });

  it("the left 16 bits do not match", async () => {
    const { r } = await judge({
      sign: {
        body: (b) => {
          // [hashed portion][2 unhashed len][unhashed][left16][mpi]: the 13-byte unhashed key id.
          const c = Buffer.from(b);
          const hashedEnd = 6 + c.readUInt16BE(4);
          const left = hashedEnd + 2 + c.readUInt16BE(hashedEnd);
          c[left] ^= 0xff;
          return c;
        },
      },
    });
    expectNoTime(r, /left 16 bits do not match/);
  });

  it("the key is not pinned", async () => {
    const { r } = await judge({ signer: stranger() });
    expectNoTime(r, /is not a pinned key/);
  });

  it("the issuer named by key id only, of a key not pinned", async () => {
    const { r } = await judge({ signer: stranger(), sign: { noFingerprint: true } });
    expectNoTime(r, new RegExp(`the signer ${stranger().keyId} is not a pinned key`));
  });

  it("a wrong public-key algorithm, hash algorithm or signature type", async () => {
    expectNoTime((await judge({ sign: { pkAlgo: 17 } })).r, /public-key algorithm 17, not RSA/);
    expectNoTime((await judge({ sign: { hashAlgo: 10 } })).r, /hash algorithm 10, not SHA-256/);
    expectNoTime((await judge({ sign: { sigType: 0x01 } })).r, /signature type 0x1, not binary/);
  });

  it("a v3 or v5 signature packet", async () => {
    expectNoTime((await judge({ sign: { version: 3 } })).r, /a version 3 signature, not 4/);
    expectNoTime((await judge({ sign: { version: 5 } })).r, /a version 5 signature, not 4/);
  });

  it("GitHub's own form is accepted at the committer time: signed seconds later, a full-width MPI, a blank last header line", async () => {
    // The fixture's default is that form (SIGN_DELAY; the helpers' defaults).
    const { fx, r } = await judge();
    const raw = execGit(fx.repo, ["cat-file", "commit", fx.squash]).toString("latin1");
    expect(raw).toContain("-----END PGP SIGNATURE-----\n \n\n");
    expect(r.computed.time.landedAt).toBe(LANDED_SECONDS * 1000);
    expect(r.accepted).toBe(true);
    // Signed in the same second, minimal MPI, no blank line: accepted too.
    const same = await judge({ sign: { created: LANDED_SECONDS, minimalMpi: true } });
    expect(same.r.computed.time.landedAt).toBe(LANDED_SECONDS * 1000);
  });

  it("the signature was made more than five minutes after the committer time", async () => {
    const late = await judge({ sign: { created: LANDED_SECONDS + 301 } });
    expectNoTime(late.r, /made 301 s after the committer time, more than 300 s/);
    const edge = await judge({ sign: { created: LANDED_SECONDS + 300 } });
    expect(edge.r.computed.time.landedAt).toBe(LANDED_SECONDS * 1000);
  });

  it("the committer time is before the pinned key was created", async () => {
    const young = testSigningKey(2048, LANDED_SECONDS + 1);
    const fx = await landedFixture(tmp, { signer: young });
    const r = await check(fx, { keys: pinFile([{ key: young }]) });
    expectNoTime(r, /committer time .* is before the pinned key was created/);
  });

  it("the committer time is at or after the pinned key's trusted_until", async () => {
    const fx = await landedFixture(tmp);
    const at = await check(fx, {
      keys: pinFile([{ key: pinned(), trustedUntil: LANDED_SECONDS }]),
    });
    expectNoTime(at, /committer time .* is at or after the pinned key's trusted_until/);
    const before = await check(fx, {
      keys: pinFile([{ key: pinned(), trustedUntil: LANDED_SECONDS - 1 }]),
    });
    expectNoTime(before, /at or after the pinned key's trusted_until/);
  });

  it("a retired key still vouches for a landing made before its trusted_until", async () => {
    const fx = await landedFixture(tmp);
    const r = await check(fx, {
      keys: pinFile([{ key: stranger() }, { key: pinned(), trustedUntil: LANDED_SECONDS + 1 }]),
    });
    expect(r.computed.time.landedAt).toBe(LANDED_SECONDS * 1000);
    expect(r.computed.time.signer).toBe(pinned().fingerprint);
    expect(r.accepted).toBe(true);
  });

  it("the window is the verifying key's, never another pinned key's", async () => {
    const fx = await landedFixture(tmp);
    const closed = { key: pinned(), trustedUntil: LANDED_SECONDS };
    for (const keys of [
      pinFile([closed, { key: stranger() }]),
      pinFile([{ key: stranger() }, closed]),
    ]) {
      const r = await check(fx, { keys });
      expectNoTime(r, /at or after the pinned key's trusted_until/);
    }
  });

  it("a pinned key with no window field is refused, never open", async () => {
    const fx = await landedFixture(tmp);
    const raw = execFileSync("git", ["-C", fx.repo, "cat-file", "commit", fx.squash]);
    const committer = /^committer (.*)$/m.exec(raw.toString("latin1"))![1]!;
    const bare = parsePinnedSigningKeys(pinned().armored) as unknown as OperatorSigningKey[];
    const t = acceptLandingTime(raw, committer, "sha1", bare);
    expect(t.landedAt).toBeNull();
    expect(t.problem ?? "").toMatch(/trusted_until \(undefined\)/);
  });

  it("a pinned key with no usable creation time is refused, never open", async () => {
    const fx = await landedFixture(tmp);
    const raw = execFileSync("git", ["-C", fx.repo, "cat-file", "commit", fx.squash]);
    const committer = /^committer (.*)$/m.exec(raw.toString("latin1"))![1]!;
    const [key] = parsePinnedSigningKeys(pinned().armored);
    for (const createdAt of [undefined, Number.NaN]) {
      const k = { ...key!, createdAt, trustedUntil: null } as unknown as OperatorSigningKey;
      const t = acceptLandingTime(raw, committer, "sha1", [k]);
      expect(t.landedAt).toBeNull();
      expect(t.problem ?? "").toMatch(/before the pinned key was created/);
    }
  });

  it("the signature was created before the committer time", async () => {
    const { r } = await judge({ sign: { created: LANDED_SECONDS - 1 } });
    expectNoTime(r, /creation time .* is before the committer time/);
    expect(r.computed.time.signer).toBe(pinned().fingerprint);
  });

  it("the gpgsig is missing", async () => {
    const { r } = await judge({ sign: false });
    expectNoTime(r, /the commit has no gpgsig signature/);
  });

  it("two signatures", async () => {
    const { r } = await judge({
      raw: (b) => {
        const t = b.toString("latin1");
        const sig = /\ngpgsig [\s\S]*?-----END PGP SIGNATURE-----/.exec(t)![0];
        return Buffer.from(t.replace(sig, `${sig}${sig}`), "latin1");
      },
    });
    expectNoTime(r, /more than one gpgsig signature/);
  });

  it("a malformed armor or CRC", async () => {
    const crc = await judge({
      sign: {
        armored: (a) =>
          a.replace(/\n=(.{4})\n/, (_m, c: string) => `\n=${c === "AAAA" ? "AAAB" : "AAAA"}\n`),
      },
    });
    expectNoTime(crc.r, /CRC-24 does not match/);
    const noCrc = await judge({ sign: { armored: (a) => a.replace(/\n=.{4}\n/, "\n") } });
    expectNoTime(noCrc.r, /no CRC-24 line/);
    const body = await judge({ sign: { armored: (a) => a.replace(/\n\n(.)/, "\n\n!$1") } });
    expectNoTime(body.r, /body is not base64 lines/);
  });

  it("trailing data after the signature packet", async () => {
    const { r } = await judge({ sign: { trailing: Buffer.from([0xcd, 0x01, 0x41]) } });
    expectNoTime(r, /holds 2 packets, not one/);
  });

  it("a commit with another signature or encoding header", async () => {
    const sha256 = await judge({
      raw: (b) =>
        Buffer.from(
          b.toString("latin1").replace("\ngpgsig ", "\ngpgsig-sha256 x\ngpgsig "),
          "latin1",
        ),
    });
    expectNoTime(sha256.r, /carries a gpgsig-sha256 header/);
    const enc = await judge({
      raw: (b) =>
        Buffer.from(
          b.toString("latin1").replace("\ngpgsig ", "\nencoding ISO-8859-1\ngpgsig "),
          "latin1",
        ),
    });
    expectNoTime(enc.r, /carries a encoding header/);
  });

  it("subpackets: none of the creation time, issuer or critical rules may be bent", async () => {
    const time = Buffer.alloc(4);
    time.writeUInt32BE(LANDED_SECONDS);
    const cases: [LandedOptions["sign"], RegExp][] = [
      [{ created: null }, /no signature creation time/],
      [
        { created: null, unhashed: [subpacket(2, time)] },
        /a creation time outside the hashed area/,
      ],
      [{ extraHashed: [subpacket(2, time)] }, /more than one creation time/],
      [
        { created: null, extraHashed: [subpacket(2, Buffer.alloc(3))] },
        /a malformed creation time/,
      ],
      [{ extraHashed: [subpacket(3, Buffer.alloc(4))] }, /a signature-expiration subpacket/],
      [{ extraHashed: [subpacket(0x80 | 20, Buffer.alloc(4))] }, /a critical subpacket of type 20/],
      [{ unhashed: [subpacket(16, Buffer.alloc(7))] }, /a malformed issuer key id/],
      [
        { unhashed: [subpacket(16, Buffer.alloc(8))] },
        /the issuer key id is not the issuer fingerprint's/,
      ],
      [
        { unhashed: [subpacket(16, Buffer.alloc(8)), subpacket(16, Buffer.alloc(8, 1))] },
        /two different issuer key ids/,
      ],
      [{ extraHashed: [subpacket(33, Buffer.alloc(21))] }, /a malformed issuer fingerprint/],
      [
        { extraHashed: [subpacket(33, Buffer.concat([Buffer.from([4]), Buffer.alloc(20)]))] },
        /two different issuer fingerprints/,
      ],
      [{ noFingerprint: true, unhashed: [] }, /no issuer/],
      [{ unhashed: [Buffer.from([0])] }, /a subpacket runs past its area/],
      [{ unhashed: [Buffer.from([200])] }, /a subpacket length is cut short/],
      [{ unhashed: [Buffer.from([255, 0, 0])] }, /a subpacket length is cut short/],
    ];
    for (const [sign, reason] of cases) expectNoTime((await judge({ sign })).r, reason);
    // A non-critical unknown subpacket, a two- and a five-octet length: accepted.
    const ok = await judge({
      sign: {
        unhashed: [
          subpacket(16, Buffer.from(pinned().keyId, "hex")),
          Buffer.concat([Buffer.from([192, 9, 20]), Buffer.alloc(200)]),
          Buffer.concat([Buffer.from([255, 0, 0, 0, 3, 20]), Buffer.alloc(2)]),
        ],
      },
    });
    expect(ok.r.computed.time.problem).toBeNull();
    expect(ok.r.accepted).toBe(true);
  });

  it("packets: definite lengths only, and exact MPIs", async () => {
    const cases: [LandedOptions["sign"], RegExp][] = [
      [{ body: (b) => Buffer.concat([b, Buffer.from([0])]) }, /trailing bytes/],
      [{ body: (b) => b.subarray(0, 5) }, /cut short/],
      [
        { body: (b) => Buffer.concat([b.subarray(0, 4), Buffer.from([0xff, 0xff])]) },
        /hashed area runs past/,
      ],
      [
        {
          body: (b) => {
            const hashedEnd = 6 + b.readUInt16BE(4);
            const c = Buffer.from(b);
            c.writeUInt16BE(0xffff, hashedEnd);
            return c;
          },
        },
        /unhashed area runs past/,
      ],
      [
        {
          body: (b) => {
            // The MPI's bit count off by one.
            const hashedEnd = 6 + b.readUInt16BE(4);
            const at = hashedEnd + 2 + b.readUInt16BE(hashedEnd) + 2;
            const c = Buffer.from(b);
            c.writeUInt16BE(c.readUInt16BE(at) + 1, at);
            return c;
          },
        },
        /bit count is not exact|malformed/,
      ],
      [
        {
          body: (b) => {
            // The MPI declares fewer bytes than it carries.
            const hashedEnd = 6 + b.readUInt16BE(4);
            const at = hashedEnd + 2 + b.readUInt16BE(hashedEnd) + 2;
            const c = Buffer.from(b);
            c.writeUInt16BE(c.readUInt16BE(at) - 8, at);
            return c;
          },
        },
        /trailing bytes/,
      ],
    ];
    for (const [sign, reason] of cases) expectNoTime((await judge({ sign })).r, reason);
  });
});

// -- Shape checks -------------------------------------------------------------

describe("motebit-verify repo-change --landed: every offline shape check folds into integrity", () => {
  it("two parents", async () => {
    const { r } = await judge({ extraParent: true });
    expectShape(r, "does not have exactly one parent (it has 2)");
  });

  it("an extra entry", async () => {
    const { r } = await judge({ squashExtra: { "notes/extra.md": "x\n" } });
    expectShape(r, "entries besides its bundle are not the record's entries");
  });

  it("entries that are not the recorded entries", async () => {
    const { r } = await judge({ squashExtra: { [DOC]: "the typo, differently\n" } });
    expectShape(r, "entries besides its bundle are not the record's entries");
    expectRule(r, "authority.repo_change.entries_mismatch");
  });

  it("a squash commit that adds no bundle", async () => {
    const { r } = await judge({
      squashTree: (repo) => git(repo, "rev-parse", `pr~1^{tree}`),
    });
    expectShape(r, "does not add exactly one regular file under .motebit/bundles/ (it adds 0)");
    expect(r.computed.bundlePath).toBeNull();
  });

  it("a bundle added as an executable file", async () => {
    const { r } = await judge({
      squashTree: (repo, head) => {
        const line = git(repo, "ls-tree", "-r", head, "--", ".motebit/bundles/");
        const [, blob, file] = /^100644 blob ([0-9a-f]+)\t(.+)$/.exec(line)!;
        const idx = { GIT_INDEX_FILE: path.join(repo, ".git", `idx-${crypto.randomUUID()}`) };
        gitIn(repo, ["read-tree", head], undefined, idx);
        gitIn(repo, ["update-index", "--cacheinfo", `100755,${blob},${file}`], undefined, idx);
        return gitIn(repo, ["write-tree"], undefined, idx);
      },
    });
    expectShape(r, "does not add exactly one regular file under .motebit/bundles/ (it adds 1)");
    expect(r.computed.bundlePath).toBeNull();
  });

  it("a bundle at a path that is not its grant's", async () => {
    const { r } = await judge({
      squashTree: (repo, head) => {
        const fxBundle = git(repo, "ls-tree", "--name-only", "-r", head, ".motebit/bundles/");
        const blob = git(repo, "rev-parse", `${head}:${fxBundle}`);
        const idx = { GIT_INDEX_FILE: path.join(repo, ".git", "idx-move") };
        gitIn(repo, ["read-tree", head], undefined, idx);
        gitIn(repo, ["update-index", "--force-remove", fxBundle], undefined, idx);
        gitIn(
          repo,
          [
            "update-index",
            "--add",
            "--cacheinfo",
            `100644,${blob},.motebit/bundles/elsewhere.json`,
          ],
          undefined,
          idx,
        );
        return gitIn(repo, ["write-tree"], undefined, idx);
      },
    });
    expectShape(r, "the squash commit's bundle is not at .motebit/bundles/");
  });

  it("an edit under .motebit/bundles/ besides the bundle", async () => {
    const { r } = await judge({
      otherBundle: true,
      squashExtra: { ".motebit/bundles/landed.json": '{"x":1}' },
    });
    expectShape(r, 'touches ".motebit/bundles/landed.json" besides its bundle');
  });

  it("parent_commit is not a first-parent ancestor of the squash commit's parent", async () => {
    const { r } = await judge({ orphanParent: true });
    expectShape(r, "parent_commit is not a first-parent ancestor of the squash commit's parent");
  });

  it("parent_commit an older first-parent ancestor (main moved on before the landing)", async () => {
    // The fixture's record names the original base; the squash lands on the
    // moved tip, so its tree carries main's newer file too.
    const { fx, r } = await judge({
      mainMovesOn: true,
      squashExtra: { "src/other.ts": "export const y = 2;\n" },
    });
    expect(r.computed.parent).toBe(fx.base);
    expect(r.computed.shapeFailures).toEqual([]);
    expect(r.accepted).toBe(true);
  });

  it("the squash commit is not on the trusted tip's first-parent chain (only on a side branch)", async () => {
    const { r } = await judge({ sideBranch: true });
    expectShape(r, "the squash commit is not on the trusted tip's first-parent chain");
  });

  it("the squash commit is after the trusted tip", async () => {
    const fx = await landedFixture(tmp);
    const r = await check(fx, { trustedTip: fx.base });
    expectShape(r, "the squash commit is not on the trusted tip's first-parent chain");
  });

  it("a failing shape check still reports every axis", async () => {
    const { r } = await judge({ extraParent: true });
    const v = r.verification.verdict;
    expect(v.integrity).toBe("invalid");
    expect(v.identityBinding).toBe("pinned");
    expect(v.authority).toBe("valid");
    expect(v.revocation.status).toBe("fresh");
    expect(r.verification.outcome).toBe("completed");
  });
});

// -- Inputs at the parent -----------------------------------------------------

describe("motebit-verify repo-change --landed: inputs are read at the squash commit's parent", () => {
  it("a policy the squash commit widens is ignored", async () => {
    const narrow = JSON.stringify({
      spec: "motebit/repo-path-policy@1.0",
      include: ["src/*.ts"],
      exclude: [".motebit"],
    });
    const { r } = await judge({
      basePolicy: narrow,
      squashExtra: { ".motebit/repo-path-policy.json": POLICY },
    });
    expect(r.computed.input.isPathPermitted(DOC)).toBe(false);
    expectRule(r, "authority.repo_change.scope_path_not_permitted", DOC);
  });

  it("a principal pin the squash commit adds is ignored", async () => {
    const { f } = await parties();
    const { r } = await judge({
      principalPin: false,
      squashExtra: { ".motebit/principals/principal.md": await identityFile(f) },
    });
    expectRule(r, "identity.repo_change.delegator_not_principal");
    expect(r.computed.state.principal).toBeNull();
  });

  it("a revocation file at the parent that fails strict parsing is unchecked, never fresh", async () => {
    const { r } = await judge({ baseExtra: { ".motebit/revocations/junk.json": "not json" } });
    expectRule(r, "revocation.repo_change.set_malformed", "junk.json");
    expect(r.verification.verdict.revocation.status).toBe("unchecked");
  });

  it("spent is never judged at a non-canonical grant id's path", async () => {
    const { r } = await judge({
      baseExtra: { ".motebit/bundles/NOT-A-UUID.json": "{}" },
      bundle: (b) => (b.grant = { ...(b.grant as object), grant_id: "NOT-A-UUID" }),
    });
    expect(r.computed.input.spent).toBe(false);
    expect(r.accepted).toBe(false);
  });

  it("the tracked paths are the parent's, never the squash commit's", async () => {
    const { fx, r } = await judge();
    const atParent = git(fx.repo, "ls-tree", "-r", "--name-only", fx.base).split("\n");
    const tracked = r.computed.input.trackedPaths.map((p) => Buffer.from(p).toString("utf8"));
    expect(tracked.sort()).toEqual(atParent.sort());
    expect(tracked).not.toContain(fx.bundleFile);
  });

  it("a revocation at the parent", async () => {
    const { r } = await judge({ revoked: true });
    expect(r.verification.verdict.revocation.status).toBe("revoked");
    expectRule(r, "revocation.repo_change.revoked");
  });

  it("spent: the bundle path once existed on the parent's first-parent history", async () => {
    const { r } = await judge({ spent: true });
    expect(r.computed.input.spent).toBe(true);
    expectRule(r, "authority.repo_change.grant_spent");
  });

  it("the path policy at the parent does not parse: not judged", async () => {
    const fx = await landedFixture(tmp, { basePolicy: "not json" });
    await expect(check(fx)).rejects.toThrow(
      /the path policy at the squash commit's parent cannot be used/,
    );
  });
});

// -- The object store ---------------------------------------------------------

/** Loose object path of `oid` in the fixture repository. */
function loose(repo: string, oid: string): string {
  return path.join(repo, ".git", "objects", oid.slice(0, 2), oid.slice(2));
}

describe("motebit-verify repo-change --landed: the object store is not trusted", () => {
  it("an object whose bytes do not hash to its id fails closed", async () => {
    const fx = await landedFixture(tmp);
    // The parent's root tree now holds the squash commit's tree's bytes:
    // without re-hashing, the parent would read as already holding the change.
    const parentTree = git(fx.repo, "rev-parse", `${fx.parent}^{tree}`);
    const squashTree = git(fx.repo, "rev-parse", `${fx.squash}^{tree}`);
    const bytes = fs.readFileSync(loose(fx.repo, squashTree));
    fs.rmSync(loose(fx.repo, parentTree));
    fs.writeFileSync(loose(fx.repo, parentTree), bytes);
    expect(git(fx.repo, "cat-file", "-t", parentTree)).toBe("tree");
    await expect(check(fx)).rejects.toThrow(
      `the bytes the store holds for tree ${parentTree} do not hash to it`,
    );
  });

  it("a forged commit-graph cannot un-spend a grant", async () => {
    const fx = await landedFixture(tmp, { spent: true });
    // base = "deleted" ← "landed" (held the bundle) ← "init". Forge the graph so
    // base's parent is init: git's own walk then skips the landed commit.
    const landedCommit = git(fx.repo, "rev-parse", `${fx.base}~1`);
    const init = git(fx.repo, "rev-parse", `${fx.base}~2`);
    forgeFirstParent(fx.repo, fx.base, init);
    expect(git(fx.repo, "rev-list", "--first-parent", fx.base).split("\n")).not.toContain(
      landedCommit,
    );
    const r = await check(fx);
    expect(r.computed.input.spent).toBe(true);
    expectRule(r, "authority.repo_change.grant_spent");
  });

  it("a duplicate-name tree is rejected", async () => {
    const fx = await landedFixture(tmp, {
      squashTree: (repo, head) => {
        const notes = git(repo, "rev-parse", `${head}:notes`);
        const blob = git(repo, "rev-parse", `${head}:${DOC}`);
        const other = gitIn(repo, ["hash-object", "-w", "--stdin"], "the typo, smuggled\n");
        const dup = Buffer.concat([
          Buffer.from("100644 guide.md\0"),
          Buffer.from(blob, "hex"),
          Buffer.from("100644 guide.md\0"),
          Buffer.from(other, "hex"),
        ]);
        const dupTree = gitIn(
          repo,
          ["hash-object", "-w", "-t", "tree", "--literally", "--stdin"],
          dup,
        );
        return replaceEntry(repo, head, notes, dupTree);
      },
    });
    await expect(check(fx)).rejects.toThrow(/the name "guide.md" occurs twice/);
  });

  it("a tree out of canonical order, or with a malformed entry, is rejected", async () => {
    const mk = (repo: string, head: string, raw: Buffer): string => {
      const notes = git(repo, "rev-parse", `${head}:notes`);
      const t = gitIn(repo, ["hash-object", "-w", "-t", "tree", "--literally", "--stdin"], raw);
      return replaceEntry(repo, head, notes, t);
    };
    const blobOf = (repo: string, head: string) =>
      Buffer.from(git(repo, "rev-parse", `${head}:${DOC}`), "hex");
    const cases: [(repo: string, head: string) => Buffer, RegExp][] = [
      [
        (repo, head) =>
          Buffer.concat([
            Buffer.from("100644 b.md\0"),
            blobOf(repo, head),
            Buffer.from("100644 a.md\0"),
            blobOf(repo, head),
          ]),
        /not in git's canonical order/,
      ],
      [
        (repo, head) => Buffer.concat([Buffer.from("100664 a.md\0"), blobOf(repo, head)]),
        /mode "100664" is not canonical/,
      ],
      [
        (repo, head) => Buffer.concat([Buffer.from("100644 ..\0"), blobOf(repo, head)]),
        /entry name "\.\." is malformed/,
      ],
      [
        (repo, head) => Buffer.concat([Buffer.from("100644 .\0"), blobOf(repo, head)]),
        /entry name "\." is malformed/,
      ],
      [
        (repo, head) => Buffer.concat([Buffer.from("100644 \0"), blobOf(repo, head)]),
        /entry name "" is malformed/,
      ],
      [
        // A blob named `a/b` would sit at the same path as a real `a/` tree's `b`.
        (repo, head) => Buffer.concat([Buffer.from("100644 a/b\0"), blobOf(repo, head)]),
        /entry name "a\/b" is malformed/,
      ],
      [
        (repo, head) =>
          Buffer.concat([Buffer.from("100644 a.md\0"), blobOf(repo, head).subarray(0, 5)]),
        /cut short/,
      ],
      [() => Buffer.from("100644 a.md"), /not terminated/],
      [() => Buffer.from("100644"), /has no mode/],
    ];
    for (const [raw, reason] of cases) {
      const fx = await landedFixture(tmp, {
        squashTree: (repo, head) => mk(repo, head, raw(repo, head)),
      });
      await expect(check(fx)).rejects.toThrow(reason);
    }
  });

  it("a commit the store does not hold, or an object of the wrong type, fails closed", async () => {
    const fx = await landedFixture(tmp);
    await expect(check(fx, { trustedTip: "0".repeat(40) })).rejects.toThrow(
      /does not hold commit 0{40}/,
    );
    const tree = git(fx.repo, "rev-parse", `${fx.squash}^{tree}`);
    await expect(check(fx, { landed: tree })).rejects.toThrow(`${tree} is a tree, not a commit`);
  });

  it("a malformed commit fails closed", async () => {
    const fx = await landedFixture(tmp);
    const tree = git(fx.repo, "rev-parse", `${fx.squash}^{tree}`);
    const cases: [string, RegExp][] = [
      [`parent ${fx.base}\ntree ${tree}\n\nm\n`, /the first header is not its tree/],
      [
        `tree ${tree}\nparent ${fx.base}\ncommitter c <c> 1 +0000\n\nm\n`,
        /the author does not follow/,
      ],
      [
        `tree ${tree}\nparent ${fx.base}\nauthor a <a> 1 +0000\n\nm\n`,
        /the committer does not follow/,
      ],
      [
        `tree ${tree}\nparent ${fx.base}\nauthor a <a> 1 +0000\ncommitter c <c> 1 +0000\nparent ${fx.base}\n\nm\n`,
        /a parent header out of place/,
      ],
      [
        `tree ${tree}\nparent ${fx.base}\nauthor a <a> 1 +0000\ncommitter c <c> 1 +0000`,
        /not terminated/,
      ],
    ];
    for (const [text, reason] of cases) {
      const c = writeCommit(fx.repo, Buffer.from(text));
      await expect(check(fx, { landed: c, trustedTip: c })).rejects.toThrow(reason);
    }
    // A header with no message is a commit too.
    const bare = writeCommit(
      fx.repo,
      Buffer.from(
        `tree ${tree}\nparent ${fx.base}\nauthor a <a> 1 +0000\ncommitter c <c> 1 +0000\n`,
      ),
    );
    const r = await check(fx, { landed: bare, trustedTip: bare });
    expectNoTime(r, /the committer is not GitHub/);
  });

  it("a squash commit with no parent is not judged", async () => {
    const fx = await landedFixture(tmp);
    const root = gitIn(fx.repo, ["commit-tree", `${fx.squash}^{tree}`, "-m", "root"]);
    await expect(check(fx, { landed: root, trustedTip: root })).rejects.toThrow(/has no parent/);
  });

  it("a shallow clone is refused", async () => {
    const fx = await landedFixture(tmp);
    fs.writeFileSync(path.join(fx.repo, ".git", "shallow"), `${fx.base}\n`);
    await expect(check(fx)).rejects.toThrow(/the repository is shallow/);
  });

  it("no ref, index or object file is written in the clone", async () => {
    const fx = await landedFixture(tmp);
    const snap = () =>
      fs
        .readdirSync(path.join(fx.repo, ".git"), { recursive: true, withFileTypes: true })
        .filter((d) => d.isFile())
        .map((d) => {
          const p = path.join(d.parentPath, d.name);
          return `${p} ${fs.statSync(p).mtimeMs} ${fs.statSync(p).size}`;
        })
        .sort();
    const before = snap();
    expect((await check(fx)).accepted).toBe(true);
    expect(snap()).toEqual(before);
  });
});

describe("motebit-verify repo-change --landed: the raw object stream", () => {
  it("reads raw bytes, says missing, refuses a partial id, and keeps serving after a refusal", async () => {
    const fx = await landedFixture(tmp);
    const session = await openIsolatedGit({
      gitEntry: path.join(fx.repo, ".git"),
      objectFormat: "sha1",
    });
    try {
      const s = session.objectStream();
      const got = await s.read(fx.squash);
      expect(got?.type).toBe("commit");
      expect(gitObjectId("commit", got!.content, "sha1")).toBe(fx.squash);
      expect(await s.read("0".repeat(40))).toBeNull();
      await expect(s.read("abc")).rejects.toThrow(/is not a full object id/);
      expect((await s.read(fx.base))?.type).toBe("commit");
      s.close();
      s.close();
      await expect(s.read(fx.base)).rejects.toThrow(/the stream is closed/);
    } finally {
      session.close();
    }
  });

  it("a read past its deadline kills the stream and closes the session", async () => {
    const fx = await landedFixture(tmp);
    const session = await openIsolatedGit({
      gitEntry: path.join(fx.repo, ".git"),
      objectFormat: "sha1",
    });
    const s = session.objectStream({ timeoutMs: 0 });
    await expect(s.read(fx.squash)).rejects.toThrow(/timed out after 0 ms/);
    await expect(session.run(["--version"])).rejects.toThrow(/the session is closed/);
    expect(() => session.objectStream()).toThrow(/the session is closed/);
  });

  it("the reader refuses an id of the wrong format", async () => {
    const fx = await landedFixture(tmp);
    const session = await openIsolatedGit({
      gitEntry: path.join(fx.repo, ".git"),
      objectFormat: "sha1",
    });
    const raw = openRawObjects(session);
    try {
      await expect(raw.commit("a".repeat(64))).rejects.toThrow(/is not a full sha1 object id/);
      expect(
        await raw.lookup(git(fx.repo, "rev-parse", `${fx.squash}^{tree}`), `${DOC}/x`),
      ).toBeNull();
      expect(
        await raw.lookup(git(fx.repo, "rev-parse", `${fx.squash}^{tree}`), "nope/x"),
      ).toBeNull();
    } finally {
      raw.close();
      session.close();
    }
  });
});

/** A copy of root tree `head` with the entry whose oid is `from` pointing at `to`. */
function replaceEntry(repo: string, head: string, from: string, to: string): string {
  const raw = execGit(repo, ["cat-file", "tree", head]);
  const i = raw.indexOf(Buffer.from(from, "hex"));
  const out = Buffer.from(raw);
  Buffer.from(to, "hex").copy(out, i);
  return gitIn(repo, ["hash-object", "-w", "-t", "tree", "--literally", "--stdin"], out);
}

/** Binary-safe git output (test setup only). */
function execGit(repo: string, args: string[]): Buffer {
  return execFileSync("git", args, { cwd: repo, env: gitEnv(), stdio: ["ignore", "pipe", "pipe"] });
}

/** Rewrite the commit-graph so `commit`'s first parent is `parent` (a forged graph). */
function forgeFirstParent(repo: string, commit: string, parent: string): void {
  git(repo, "commit-graph", "write", "--reachable");
  const p = path.join(repo, ".git", "objects", "info", "commit-graph");
  const b = Buffer.from(fs.readFileSync(p));
  const chunks = new Map<string, number>();
  for (let k = 0; k <= b[6]!; k++) {
    const o = 8 + k * 12;
    chunks.set(b.subarray(o, o + 4).toString("latin1"), Number(b.readBigUInt64BE(o + 4)));
  }
  const oidl = chunks.get("OIDL")!;
  const cdat = chunks.get("CDAT")!;
  const n = (cdat - oidl) / 20;
  const oids: string[] = [];
  for (let k = 0; k < n; k++)
    oids.push(b.subarray(oidl + k * 20, oidl + k * 20 + 20).toString("hex"));
  b.writeUInt32BE(oids.indexOf(parent), cdat + oids.indexOf(commit) * 36 + 20);
  fs.rmSync(p);
  fs.writeFileSync(p, b);
}

// -- The command --------------------------------------------------------------

function cliArgs(fx: LandedFixture, extra: string[] = []): string[] {
  return [
    "repo-change",
    "--landed",
    fx.squash,
    "--trusted-tip",
    fx.tip,
    "--repository",
    REPO,
    "--github-keys",
    fx.keysFile,
    "--repo",
    fx.repo,
    ...extra,
  ];
}

describe("motebit-verify repo-change --landed: the command", () => {
  it("exits 0 on a verified landed change, printing every axis and the operator-recorded time", async () => {
    const fx = await landedFixture(tmp);
    const out = await runMain(cliArgs(fx));
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toMatch(/repo-change VERIFIED — a completed governed change, landed/);
    expect(out.stdout).toMatch(
      /integrity verified, identityBinding pinned, authority valid, revocation fresh; outcome completed/,
    );
    expect(out.stdout).toContain(
      `evaluated at   ${LANDED_SECONDS * 1000} (operator_recorded, signed by ${pinned().fingerprint})`,
    );
  });

  it("--json is the structured verdict, with the time, its basis and signer", async () => {
    const fx = await landedFixture(tmp);
    const out = await runMain(cliArgs(fx, ["--json"]));
    expect(out.code).toBe(0);
    const j = JSON.parse(out.stdout) as Record<string, unknown>;
    expect(j.accepted).toBe(true);
    expect(j.evaluatedAt).toBe(LANDED_SECONDS * 1000);
    expect(j.temporalBasis).toBe("operator_recorded");
    expect(j.timeProblem).toBeNull();
    expect(j.signer).toBe(pinned().fingerprint);
    expect(j.parent).toBe(fx.base);
    expect(j.bundlePath).toBe(fx.bundleFile);
    expect(j.shapeFailures).toEqual([]);
  });

  it("exits 1 when the time is not accepted, saying why", async () => {
    const fx = await landedFixture(tmp, { sign: false });
    const out = await runMain(cliArgs(fx));
    expect(out.code).toBe(1);
    expect(out.stdout).toMatch(/NOT VERIFIED/);
    expect(out.stdout).toMatch(
      /evaluated at {3}none \(operator_recorded time not accepted: the commit has no gpgsig signature\)/,
    );
    expect(out.stdout).toMatch(/authority\.repo_change\.time_unavailable/);
  });

  it("prints what the parent lacks and `none` for a missing bundle", async () => {
    const fx = await landedFixture(tmp, {
      principalPin: false,
      squashTree: (repo) => git(repo, "rev-parse", `pr~1^{tree}`),
    });
    const out = await runMain(cliArgs(fx));
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("bundle         none");
    expect(out.stdout).toMatch(/at the parent \(pins, policy\):\n {4}no principal pin/);
  });

  it("exits 2 when the pinned keys do not parse, or the file is missing", async () => {
    const fx = await landedFixture(tmp);
    fs.writeFileSync(fx.keysFile, "not a key\n");
    const bad = await runMain(cliArgs(fx));
    expect(bad.code).toBe(2);
    expect(bad.stderr).toMatch(/not judged: operator signing keys: not valid JSON/);
    // Bytes that are not UTF-8 are refused, never replaced.
    // An armor comment holding 0xFF 0xFE: a lenient decoder reads U+FFFD there,
    // which the armor header grammar would accept.
    const commented = pinFile([{ key: pinned() }]).replace(
      "-----BEGIN PGP PUBLIC KEY BLOCK-----\\n",
      "-----BEGIN PGP PUBLIC KEY BLOCK-----\\nComment: @@\\n",
    );
    const at = commented.indexOf("@@");
    expect(at).toBeGreaterThan(0);
    fs.writeFileSync(
      fx.keysFile,
      Buffer.concat([
        Buffer.from(commented.slice(0, at)),
        Buffer.from([0xff, 0xfe]),
        Buffer.from(commented.slice(at + 2)),
      ]),
    );
    const notUtf8First = await runMain(cliArgs(fx));
    // Control: the same comment in ASCII is read and the change verifies.
    fs.writeFileSync(fx.keysFile, commented.replace("@@", "ok"));
    expect((await runMain(cliArgs(fx))).code).toBe(0);
    fs.writeFileSync(
      fx.keysFile,
      Buffer.concat([
        Buffer.from(commented.slice(0, at)),
        Buffer.from([0xff, 0xfe]),
        Buffer.from(commented.slice(at + 2)),
      ]),
    );
    const notUtf8 = await runMain(cliArgs(fx));
    expect(notUtf8First.code).toBe(2);
    expect(notUtf8.code).toBe(2);
    expect(notUtf8.stderr).toMatch(/not judged: .*(encoded|decode|invalid)/i);
    // A bare armored key file (no windows) is not a pinned set.
    fs.writeFileSync(fx.keysFile, pinned().armored);
    const bare = await runMain(cliArgs(fx));
    expect(bare.code).toBe(2);
    expect(bare.stderr).toMatch(/not judged: operator signing keys: not valid JSON/);
    fs.rmSync(fx.keysFile);
    const missing = await runMain(cliArgs(fx));
    expect(missing.code).toBe(2);
    expect(missing.stderr).toMatch(/not judged/);
  });

  it.each([
    [["--landed", "a".repeat(40), "--base", "b".repeat(40)], /--base is not used with --landed/],
    [["--landed", "a".repeat(40), "--now", "1"], /--now is not used with --landed/],
    [["--trusted-tip", "a".repeat(40)], /--trusted-tip requires --landed/],
    [["--github-keys", "k"], /--github-keys requires --landed/],
    [["--landed", "a".repeat(40)], /missing --trusted-tip/],
    [
      [
        "--landed",
        "a".repeat(40),
        "--trusted-tip",
        "b".repeat(40),
        "--repository",
        "o/n",
        "--repo",
        "r",
      ],
      /missing --github-keys/,
    ],
    [
      [
        "--landed",
        "abc",
        "--trusted-tip",
        "b".repeat(40),
        "--repository",
        "o/n",
        "--github-keys",
        "k",
        "--repo",
        "r",
      ],
      /--landed must be a full lowercase commit id/,
    ],
    [
      [
        "--landed",
        "a".repeat(40),
        "--trusted-tip",
        "b".repeat(64),
        "--repository",
        "o/n",
        "--github-keys",
        "k",
        "--repo",
        "r",
      ],
      /--trusted-tip must be a full lowercase commit id of --landed's object format/,
    ],
  ])("exits 2 on a usage error %#", async (argv, message) => {
    const out = await runMain(["repo-change", ...argv]);
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(message);
  });

  it("--help prints the offline section", async () => {
    const out = await runMain(["repo-change", "--help"]);
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/REPO-CHANGE OFFLINE/);
  });
});
