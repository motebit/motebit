/**
 * `motebit repo-task delegate` / `revoke` — the principal's side of a governed
 * repo change (docs/proposals/governed-repo-change-v1.md, build step 3).
 *
 * Every key is generated in-test; nothing reads ~/.motebit. The acceptance
 * judge is the run's own authority law (`checkRepoTaskAuthority`, which calls
 * the verifier's shared repo-change rules and is held to `verifyRepoChange` by
 * the runtime's agreement test), plus the §5 revocation binding
 * (`findGrantRevocation`).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  bytesToHex,
  canonicalJson,
  canonicalSha256,
  deriveSovereignMotebitId,
  findGrantRevocation,
  generateKeypair,
  verifyTokenAgainstGrant,
} from "@motebit/encryption";
import type { DelegationRevocation, KeyPair } from "@motebit/encryption";
import { generate } from "@motebit/identity-file";
import { checkRepoTaskAuthority } from "@motebit/runtime";
import type { RepoTaskPin } from "@motebit/runtime";

import {
  RepoTaskDelegationRefusedError,
  delegateToDirectory,
  mintRepoTaskDelegation,
  readDelegationDirectory,
  revokeToDirectory,
  writeCanonicalFiles,
} from "../delegation.js";
import type { RepoTaskDelegation, RepoTaskDelegationRequest } from "../delegation.js";
import { readAgentPin, resolveDelegationDirectory } from "../../subcommands/repo-task.js";

const HOUR = 3_600_000;
const NOW = 1_900_000_000_000;
const REPO = "motebit/motebit";

interface Party {
  keys: KeyPair;
  pin: RepoTaskPin;
}

async function party(): Promise<Party> {
  const keys = await generateKeypair();
  const public_key = bytesToHex(keys.publicKey);
  return { keys, pin: { motebit_id: await deriveSovereignMotebitId(public_key), public_key } };
}

let f: Party; // the principal
let a: Party; // the agent
let x: Party; // a stranger
let tmp: string;

beforeEach(async () => {
  f = await party();
  a = await party();
  x = await party();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repo-task-delegate-"));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function principal(p: Party = f) {
  return {
    motebitId: p.pin.motebit_id,
    publicKeyHex: p.pin.public_key,
    privateKey: p.keys.privateKey,
  };
}

function request(over: Partial<RepoTaskDelegationRequest> = {}): RepoTaskDelegationRequest {
  return {
    principal: principal(),
    delegate: a.pin,
    repo: REPO,
    baseRef: "main",
    objectFormat: "sha1",
    allowedPaths: ["notes/typo.md"],
    maxChangedFiles: 1,
    task: "Fix the typo in notes/typo.md.",
    tools: "repo_write_path,repo_read_blob",
    lifetimeMs: 24 * HOUR,
    now: NOW,
    ...over,
  };
}

/** The run's authority law at `now`, over the repository's pins: F the principal, A an agent. */
async function judge(
  d: RepoTaskDelegation,
  now: number,
  revocations: readonly DelegationRevocation[] = [],
) {
  return checkRepoTaskAuthority(
    {
      ...d,
      revocations: { set: revocations, failures: [], readAt: "tip" },
      principal: f.pin,
      agents: [a.pin],
      expectedRepo: REPO,
      isPathPermitted: () => true,
      spent: false,
    },
    a.pin,
    now,
  );
}

async function refusalCodes(req: RepoTaskDelegationRequest, dir: string): Promise<string[]> {
  const err = await delegateToDirectory(req, dir).then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(RepoTaskDelegationRefusedError);
  return (err as RepoTaskDelegationRefusedError).failures.map((x) => x.code);
}

describe("repo-task delegate: the principal signs a scope, a grant and one tick", () => {
  it("writes canonical files that the run's authority law accepts", async () => {
    const dir = path.join(tmp, "out");
    const { delegation, files } = await delegateToDirectory(request(), dir);
    expect(files.map((p) => path.basename(p)).sort()).toEqual([
      "grant.json",
      "scope.json",
      "tick.json",
    ]);
    for (const file of files) {
      const text = fs.readFileSync(file, "utf8");
      expect(text).toBe(canonicalJson(JSON.parse(text)));
    }

    const onDisk = readDelegationDirectory(dir);
    expect(onDisk).toEqual(delegation);
    const { scope, grant, tick } = onDisk;
    expect(grant.delegator_id).toBe(f.pin.motebit_id);
    expect(grant.delegate_public_key).toBe(a.pin.public_key);
    expect(grant.subject).toBe("repo-change");
    expect(grant.scope).toBe("repo_read_blob,repo_write_path");
    expect(grant.spend_ceiling).toBeUndefined();
    expect(grant.subject_binding?.digest).toBe(await canonicalSha256(scope));
    expect(tick.grant_id).toBe(grant.grant_id);
    expect(tick.expires_at).toBeLessThanOrEqual(grant.expires_at);
    expect(grant.grant_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    const check = await judge(onDisk, NOW + HOUR);
    expect(check).toEqual({ ok: true, tools: new Set(["repo_read_blob", "repo_write_path"]) });
    expect((await verifyTokenAgainstGrant(tick, grant, { now: NOW + HOUR })).valid).toBe(true);
    // One tick and no second: past the grant's end nothing authorizes.
    expect((await judge(onDisk, grant.expires_at + 1)).ok).toBe(false);
  });

  it("the agent pin is the verified pair of its identity file", async () => {
    const file = path.join(tmp, "agent.md");
    fs.writeFileSync(
      file,
      await generate(
        { motebitId: a.pin.motebit_id, ownerId: "owner", publicKeyHex: a.pin.public_key },
        a.keys.privateKey,
      ),
    );
    expect(await readAgentPin(file)).toEqual(a.pin);
    const tampered = fs.readFileSync(file, "utf8").replace(a.pin.public_key, x.pin.public_key);
    fs.writeFileSync(file, tampered);
    await expect(readAgentPin(file)).rejects.toThrow(/not an intact identity file/);
  });

  it("a not_before delegation opens at not_before and not before", async () => {
    const notBefore = NOW + 6 * HOUR;
    const { delegation } = await delegateToDirectory(
      request({ notBefore, lifetimeMs: 2 * HOUR }),
      path.join(tmp, "later"),
    );
    expect(delegation.grant.not_before).toBe(notBefore);
    expect(delegation.tick.not_before).toBe(notBefore);
    expect(delegation.grant.expires_at).toBe(notBefore + 2 * HOUR);
    expect((await judge(delegation, notBefore)).ok).toBe(true);
    const early = await judge(delegation, NOW);
    expect(early.ok ? [] : early.failures.map((x) => x.code)).toContain(
      "authority.repo_change.grant_not_yet_valid",
    );
  });

  it("cadence below the lifetime is impossible by construction", async () => {
    for (const [lifetimeMs, notBefore] of [
      [HOUR, undefined],
      [24 * HOUR, undefined],
      [90 * 60_000, NOW + HOUR],
      [24 * HOUR, NOW - HOUR],
    ] as const) {
      const { grant, tick } = await mintRepoTaskDelegation(
        request({ lifetimeMs, ...(notBefore !== undefined ? { notBefore } : {}) }),
      );
      const start = Math.max(grant.issued_at, grant.not_before ?? grant.issued_at);
      expect(grant.expires_at - start).toBe(lifetimeMs);
      expect(grant.cadence_ms).toBe(grant.expires_at - start);
      expect(tick.expires_at - tick.issued_at).toBeLessThanOrEqual(grant.max_token_ttl_ms);
    }
  });

  it("a second delegate into the same directory overwrites nothing", async () => {
    const dir = path.join(tmp, "same");
    await delegateToDirectory(request(), dir);
    const before = fs.readdirSync(dir).map((n) => [n, fs.readFileSync(path.join(dir, n), "utf8")]);
    await expect(delegateToDirectory(request({ task: "another" }), dir)).rejects.toThrow(
      /could not write/,
    );
    const after = fs.readdirSync(dir).map((n) => [n, fs.readFileSync(path.join(dir, n), "utf8")]);
    expect(after).toEqual(before);
  });
});

describe("repo-task delegate: a delegation that would not verify writes nothing", () => {
  it("refuses self-delegation", async () => {
    const dir = path.join(tmp, "self");
    expect(await refusalCodes(request({ delegate: f.pin }), dir)).toContain(
      "identity.repo_change.delegator_is_delegate",
    );
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses a non-canonical path", async () => {
    for (const p of [
      "notes/../typo.md",
      "notes/./typo.md",
      "/notes/typo.md",
      "notes/ſ.md",
      ".git/config",
      "notes/a.",
    ]) {
      const dir = path.join(tmp, "noncanonical");
      expect(await refusalCodes(request({ allowedPaths: [p] }), dir)).toContain(
        "integrity.repo_change.value_not_canonical",
      );
      expect(fs.existsSync(dir)).toBe(false);
    }
  });

  it("refuses a delegate key that is not in its one spelling", async () => {
    const dir = path.join(tmp, "upper");
    const delegate = { ...a.pin, public_key: a.pin.public_key.toUpperCase() };
    expect(await refusalCodes(request({ delegate }), dir)).toContain(
      "integrity.repo_change.value_not_canonical",
    );
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses a duplicate path", async () => {
    const dir = path.join(tmp, "dup");
    expect(
      await refusalCodes(
        request({ allowedPaths: ["notes/typo.md", "notes/typo.md"], maxChangedFiles: 2 }),
        dir,
      ),
    ).toContain("integrity.repo_change.value_not_canonical");
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses a lifetime over 24 hours", async () => {
    const dir = path.join(tmp, "long");
    expect(await refusalCodes(request({ lifetimeMs: 24 * HOUR + 1 }), dir)).toContain(
      "authority.repo_change.lifetime_exceeded",
    );
    expect(fs.existsSync(dir)).toBe(false);
  });

  it("refuses a tool outside the repo-change tools", async () => {
    for (const tools of [
      "repo_read_blob,shell",
      "repo_read_blob,repo_read_blob",
      "repo_read_blob, repo_write_path",
      "*",
    ]) {
      const dir = path.join(tmp, "tools");
      expect(await refusalCodes(request({ tools }), dir)).toContain(
        "authority.repo_change.scope_tools_outside",
      );
      expect(fs.existsSync(dir)).toBe(false);
    }
  });
});

describe("repo-task revoke: a revocation that binds the grant, from its delegator only", () => {
  it("the principal's revocation binds the grant", async () => {
    const dir = path.join(tmp, "d");
    const { delegation } = await delegateToDirectory(request(), dir);
    const out = path.join(tmp, "revocations");
    const { revocation, file } = await revokeToDirectory(
      { delegation, principal: principal(), now: NOW + HOUR },
      out,
    );
    expect(path.basename(file)).toBe(`${delegation.grant.grant_id}.json`);
    const text = fs.readFileSync(file, "utf8");
    expect(text).toBe(canonicalJson(revocation));
    expect(await findGrantRevocation(delegation.grant, [JSON.parse(text)])).toEqual(revocation);
    const check = await judge(delegation, NOW + HOUR, [revocation]);
    expect(check.ok ? [] : check.failures.map((x) => x.code)).toEqual([
      "revocation.repo_change.revoked",
    ]);
  });

  it("refuses a key that is not the grant's delegator key", async () => {
    const { delegation } = await delegateToDirectory(request(), path.join(tmp, "d"));
    const out = path.join(tmp, "revocations");
    const err = await revokeToDirectory(
      { delegation, principal: principal(x), now: NOW + HOUR },
      out,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RepoTaskDelegationRefusedError);
    expect((err as RepoTaskDelegationRefusedError).failures.map((f) => f.code)).toContain(
      "revoke.not_delegator",
    );
    expect(fs.existsSync(out)).toBe(false);
  });
});

describe("repo-task revoke: only a grant the principal signed, read from its own file", () => {
  it("refuses a grant whose signature does not verify (a forged grant_id)", async () => {
    const dir = path.join(tmp, "d");
    await delegateToDirectory(request(), dir);
    const grantFile = path.join(dir, "grant.json");
    const real = JSON.parse(fs.readFileSync(grantFile, "utf8"));
    const forgedId = "01a19a05-7e29-789d-8c54-cbf64a01a088";
    fs.writeFileSync(grantFile, canonicalJson({ ...real, grant_id: forgedId }));
    const out = path.join(tmp, "revocations");
    const err = await revokeToDirectory(
      { delegation: readDelegationDirectory(dir), principal: principal(), now: NOW + HOUR },
      out,
    ).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RepoTaskDelegationRefusedError);
    expect((err as RepoTaskDelegationRefusedError).failures.map((f) => f.code)).toContain(
      "integrity.repo_change.signature_invalid",
    );
    expect(fs.existsSync(out)).toBe(false);
  });

  it("a malformed tick is reported as malformed, never as a wrong key", async () => {
    const dir = path.join(tmp, "d");
    await delegateToDirectory(request(), dir);
    const tickFile = path.join(dir, "tick.json");
    const { grant_id: _dropped, ...tick } = JSON.parse(fs.readFileSync(tickFile, "utf8"));
    fs.writeFileSync(tickFile, canonicalJson(tick));
    const err = await revokeToDirectory(
      { delegation: readDelegationDirectory(dir), principal: principal(), now: NOW + HOUR },
      path.join(tmp, "revocations"),
    ).then(
      () => null,
      (e: unknown) => e,
    );
    const codes = (err as RepoTaskDelegationRefusedError).failures.map((f) => f.code);
    expect(codes).toContain("integrity.repo_change.bundle_malformed");
    expect(codes).not.toContain("revoke.not_delegator");
  });

  it("a file argument is read only as the delegation's grant.json", async () => {
    const dir = path.join(tmp, "d");
    await delegateToDirectory(request(), dir);
    fs.copyFileSync(path.join(dir, "grant.json"), path.join(dir, "grant-B.json"));
    expect(resolveDelegationDirectory(dir)).toBe(dir);
    expect(resolveDelegationDirectory(path.join(dir, "grant.json"))).toBe(dir);
    expect(() => resolveDelegationDirectory(path.join(dir, "grant-B.json"))).toThrow(
      /is not a delegation's grant\.json/,
    );
  });
});

describe("repo-task files: owner-only, exclusive, all or nothing", () => {
  /** Fail the `n`th file's write after writing part of it. */
  const failingIo = (n: number) => {
    let call = 0;
    return {
      writeSync: (fd: number, data: Uint8Array) => {
        if (++call === n) {
          fs.writeSync(fd, data.subarray(0, 3));
          throw Object.assign(new Error("EFBIG: file too large"), { code: "EFBIG" });
        }
        return fs.writeSync(fd, data);
      },
    };
  };
  const files = { "a.json": { a: 1 }, "b.json": { b: 2 }, "c.json": { c: 3 } };

  it("a write that fails midway leaves no file, no partial and no directory it created", () => {
    const dir = path.join(tmp, "new", "deeper");
    expect(() => writeCanonicalFiles(dir, files, failingIo(2))).toThrow(/EFBIG/);
    expect(fs.existsSync(path.join(tmp, "new"))).toBe(false);
  });

  it("a write that fails midway in an existing directory removes only what it wrote", () => {
    const dir = path.join(tmp, "existing");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "keep.txt"), "mine");
    expect(() => writeCanonicalFiles(dir, files, failingIo(2))).toThrow(/EFBIG/);
    expect(fs.readdirSync(dir)).toEqual(["keep.txt"]);
  });

  it("files are 0600 and a directory it creates is 0700", async () => {
    const dir = path.join(tmp, "modes");
    const { files: written } = await delegateToDirectory(request(), dir);
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    for (const f of written) expect(fs.statSync(f).mode & 0o777).toBe(0o600);
  });
});
