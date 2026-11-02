/**
 * The `motebit repo-task delegate` / `revoke` command shells: the principal's
 * key is unlocked only after every refusal that needs no key, and it is erased
 * before the process exits on every path. The process-touching calls are
 * injected and recorded; `exit` throws so a test sees where it was called.
 * Every key is generated in-test; nothing reads ~/.motebit.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { bytesToHex, deriveSovereignMotebitId, generateKeypair } from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import type { RepoTaskPin } from "@motebit/runtime";

import { parseCliArgs } from "../../args.js";
import type { FullConfig } from "../../config.js";
import { handleRepoTaskDelegate, handleRepoTaskRevoke } from "../../subcommands/repo-task.js";
import type { RepoTaskCommandDeps } from "../../subcommands/repo-task.js";

class ExitCalled extends Error {}

interface Party {
  keys: KeyPair;
  pin: RepoTaskPin;
}
async function party(): Promise<Party> {
  const keys = await generateKeypair();
  const public_key = bytesToHex(keys.publicKey);
  return { keys, pin: { motebit_id: await deriveSovereignMotebitId(public_key), public_key } };
}

let f: Party;
let a: Party;
let tmp: string;
let events: string[];

beforeEach(async () => {
  f = await party();
  a = await party();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repo-task-cmd-"));
  events = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function deps(over: { principal?: Party; delegate?: RepoTaskPin } = {}): RepoTaskCommandDeps {
  const p = over.principal ?? f;
  return {
    loadFullConfig: () =>
      ({ motebit_id: p.pin.motebit_id, device_public_key: p.pin.public_key }) as FullConfig,
    loadActiveSigningKey: () => {
      events.push("load");
      return Promise.resolve({
        source: "encrypted-config",
        privateKey: new Uint8Array(p.keys.privateKey),
        publicKey: p.pin.public_key,
      });
    },
    secureErase: (key) => {
      events.push("erase");
      key.fill(0);
    },
    readAgentPin: () => Promise.resolve(over.delegate ?? a.pin),
    exit: (code) => {
      events.push(`exit ${code}`);
      throw new ExitCalled();
    },
    now: () => 1_900_000_000_000,
  };
}

function delegateArgs(...extra: string[]) {
  return parseCliArgs([
    "repo-task",
    "delegate",
    "--repo",
    "motebit/motebit",
    "--path",
    "notes/typo.md",
    "--task",
    "Fix the typo.",
    "--delegate",
    "agent.md",
    "--output",
    path.join(tmp, "out"),
    ...extra,
  ]);
}

const DELEGATE = "repo-task delegate: a refusal that needs no key never unlocks it";

describe(DELEGATE, () => {
  const refusesBeforeKey = async (config: ReturnType<typeof parseCliArgs>, d = deps()) => {
    await expect(handleRepoTaskDelegate(config, d)).rejects.toBeInstanceOf(ExitCalled);
    expect(events).toEqual(["exit 1"]);
    expect(fs.existsSync(path.join(tmp, "out"))).toBe(false);
  };

  it("--hours 25", async () => {
    await refusesBeforeKey(delegateArgs("--hours", "25"));
  });
  it("a non-canonical --path", async () => {
    await refusesBeforeKey(delegateArgs("--path", "notes/../x.md"));
  });
  it("a repeated --path", async () => {
    await refusesBeforeKey(delegateArgs("--path", "notes/typo.md"));
  });
  it("a --scope outside the repo-change tools", async () => {
    await refusesBeforeKey(delegateArgs("--scope", "repo_read_blob,shell"));
  });
  it("self-delegation", async () => {
    await refusesBeforeKey(delegateArgs(), deps({ delegate: f.pin }));
  });
  it("a --base-ref other than main", async () => {
    await refusesBeforeKey(delegateArgs("--base-ref", "dev"));
  });
});

describe("repo-task delegate and revoke: the key is erased before any exit", () => {
  it("a refusal after the key is unlocked erases it first", async () => {
    // A delegate key in another spelling passes the key-free checks; the
    // signer refuses it once the key is held.
    const upper = { ...a.pin, public_key: a.pin.public_key.toUpperCase() };
    await expect(
      handleRepoTaskDelegate(delegateArgs(), deps({ delegate: upper })),
    ).rejects.toBeInstanceOf(ExitCalled);
    expect(events).toEqual(["load", "erase", "exit 1"]);
    expect(fs.existsSync(path.join(tmp, "out"))).toBe(false);
  });

  it("a delegation that verifies is written and the key erased", async () => {
    await handleRepoTaskDelegate(delegateArgs(), deps());
    expect(events).toEqual(["load", "erase"]);
    expect(fs.readdirSync(path.join(tmp, "out")).sort()).toEqual([
      "grant.json",
      "scope.json",
      "tick.json",
    ]);
  });

  it("revoke from another key refuses before unlocking it", async () => {
    await handleRepoTaskDelegate(delegateArgs(), deps());
    events = [];
    const revoke = parseCliArgs(["repo-task", "revoke", path.join(tmp, "out")]);
    await expect(handleRepoTaskRevoke(revoke, deps({ principal: a }))).rejects.toBeInstanceOf(
      ExitCalled,
    );
    expect(events).toEqual(["exit 1"]);
    events = [];
    await handleRepoTaskRevoke(revoke, deps());
    expect(events).toEqual(["load", "erase"]);
  });
});
