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

import {
  bytesToHex,
  canonicalJson,
  deriveSovereignMotebitId,
  findGrantRevocation,
  generateKeypair,
} from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import type { RepoTaskPin } from "@motebit/runtime";

import { parseCliArgs } from "../../args.js";
import type { FullConfig } from "../../config.js";
import {
  RepoTaskDelegationRefusedError,
  delegateToDirectory,
  revokeToDirectory,
} from "../delegation.js";
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

/** A refusal met only once the key is held (as the post-sign self-check would). */
const postKeyRefusal = () =>
  Promise.reject(
    new RepoTaskDelegationRefusedError([
      { code: "integrity.repo_change.signature_invalid", detail: "injected" },
    ]),
  );

function deps(
  over: {
    principal?: Party;
    delegate?: RepoTaskPin;
    refuseAfterKey?: boolean;
    configKey?: string;
    revokeToDirectory?: RepoTaskCommandDeps["revokeToDirectory"];
  } = {},
): RepoTaskCommandDeps {
  const p = over.principal ?? f;
  return {
    loadFullConfig: () =>
      ({
        motebit_id: p.pin.motebit_id,
        device_public_key: over.configKey ?? p.pin.public_key,
      }) as FullConfig,
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
    delegateToDirectory: over.refuseAfterKey ? postKeyRefusal : delegateToDirectory,
    revokeToDirectory:
      over.revokeToDirectory ?? (over.refuseAfterKey ? postKeyRefusal : revokeToDirectory),
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
  it("self-delegation (the same identity)", async () => {
    await refusesBeforeKey(delegateArgs(), deps({ delegate: f.pin }));
  });
  it("self-delegation by key under another id", async () => {
    await refusesBeforeKey(
      delegateArgs(),
      deps({ delegate: { ...a.pin, public_key: f.pin.public_key } }),
    );
  });
  it("an uppercase configured principal key", async () => {
    await refusesBeforeKey(delegateArgs(), deps({ configKey: f.pin.public_key.toUpperCase() }));
  });
  it("an output file that already exists", async () => {
    fs.mkdirSync(path.join(tmp, "out"));
    fs.writeFileSync(path.join(tmp, "out", "tick.json"), "{}");
    await expect(handleRepoTaskDelegate(delegateArgs(), deps())).rejects.toBeInstanceOf(ExitCalled);
    expect(events).toEqual(["exit 1"]);
    expect(fs.readdirSync(path.join(tmp, "out"))).toEqual(["tick.json"]);
  });
  it("a delegate with an empty motebit_id", async () => {
    await refusesBeforeKey(delegateArgs(), deps({ delegate: { ...a.pin, motebit_id: "" } }));
  });
  it("a --base-ref other than main", async () => {
    await refusesBeforeKey(delegateArgs("--base-ref", "dev"));
  });
  it("a delegate key in another spelling", async () => {
    const upper = { ...a.pin, public_key: a.pin.public_key.toUpperCase() };
    await refusesBeforeKey(delegateArgs(), deps({ delegate: upper }));
  });
});

const REVOKE = "repo-task revoke: needs only the grant (or its id), never the scope or the tick";

describe(REVOKE, () => {
  const out = () => path.join(tmp, "out");
  const rev = () => path.join(tmp, "rev");
  const grantOf = () => JSON.parse(fs.readFileSync(path.join(out(), "grant.json"), "utf8"));
  const rewrite = (
    name: string,
    change: (v: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const file = path.join(out(), name);
    fs.writeFileSync(file, canonicalJson(change(JSON.parse(fs.readFileSync(file, "utf8")))));
  };
  const revoke = (arg: string, d = deps()) =>
    handleRepoTaskRevoke(parseCliArgs(["repo-task", "revoke", arg, "--output", rev()]), d);
  const revokesBindingly = async (arg: string) => {
    events = [];
    await revoke(arg);
    expect(events).toEqual(["load", "erase"]);
    const grant = grantOf();
    const written = JSON.parse(fs.readFileSync(path.join(rev(), `${grant.grant_id}.json`), "utf8"));
    expect(await findGrantRevocation(grant, [written])).toEqual(written);
  };
  const refusesBeforeKey = async (arg: string, message: RegExp, d = deps(), revExists = false) => {
    events = [];
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...x: unknown[]) => {
      lines.push(x.map(String).join(" "));
    });
    await expect(revoke(arg, d)).rejects.toBeInstanceOf(ExitCalled);
    expect(events).toEqual(["exit 1"]);
    expect(lines.join("\n")).toMatch(message);
    if (!revExists) expect(fs.existsSync(rev())).toBe(false);
  };

  it("by grant_id, with no files at all", async () => {
    await handleRepoTaskDelegate(delegateArgs(), deps());
    const grant = grantOf();
    fs.rmSync(out(), { recursive: true });
    events = [];
    await revoke(grant.grant_id);
    expect(events).toEqual(["load", "erase"]);
    const written = JSON.parse(fs.readFileSync(path.join(rev(), `${grant.grant_id}.json`), "utf8"));
    expect(await findGrantRevocation(grant, [written])).toEqual(written);
  });
  it("a grant_id not in its one spelling is refused before the key", async () => {
    await refusesBeforeKey("01A19A05-7E29-789D-8C54-CBF64A01A088", /not a lowercase UUID/);
  });
  it("beside a damaged tick", async () => {
    await handleRepoTaskDelegate(delegateArgs(), deps());
    rewrite("tick.json", ({ grant_id: _dropped, ...t }) => t);
    await revokesBindingly(out());
  });
  it("beside an edited scope", async () => {
    await handleRepoTaskDelegate(delegateArgs(), deps());
    rewrite("scope.json", (sc) => ({ ...sc, task: "something else" }));
    await revokesBindingly(path.join(out(), "grant.json"));
  });
  it("with the tick and the scope missing", async () => {
    await handleRepoTaskDelegate(delegateArgs(), deps());
    fs.rmSync(path.join(out(), "tick.json"));
    fs.rmSync(path.join(out(), "scope.json"));
    await revokesBindingly(out());
  });
  it("a forged grant.json is refused before the key, as not signed by its key", async () => {
    await handleRepoTaskDelegate(delegateArgs(), deps());
    rewrite("grant.json", (g) => ({ ...g, grant_id: "01a19a05-7e29-789d-8c54-cbf64a01a088" }));
    await refusesBeforeKey(
      out(),
      /signature_invalid: the grant's signature does not verify under its own delegator key/,
    );
  });
  it("a grant of another principal is refused before the key", async () => {
    await handleRepoTaskDelegate(delegateArgs(), deps());
    await refusesBeforeKey(out(), /revoke\.not_delegator/, deps({ principal: a }));
  });
  it("an existing revocation file is refused before the key", async () => {
    await handleRepoTaskDelegate(delegateArgs(), deps());
    await revoke(out());
    await refusesBeforeKey(out(), /already exists/, deps(), true);
  });
  it("a revocation file that appears after the key is a clean refusal, the key erased first", async () => {
    await handleRepoTaskDelegate(delegateArgs(), deps());
    events = [];
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...x: unknown[]) => {
      lines.push(x.map(String).join(" "));
    });
    const racing: RepoTaskCommandDeps["revokeToDirectory"] = (input, dir) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${input.target.grant_id}.json`), "{}");
      return revokeToDirectory(input, dir);
    };
    await expect(revoke(out(), deps({ revokeToDirectory: racing }))).rejects.toBeInstanceOf(
      ExitCalled,
    );
    expect(events).toEqual(["load", "erase", "exit 1"]);
    expect(lines.join("\n")).toMatch(/a revocation for [0-9a-f-]{36} already exists at /);
  });
  it("an uppercase configured principal key is refused before the key", async () => {
    await handleRepoTaskDelegate(delegateArgs(), deps());
    const grant = grantOf();
    await refusesBeforeKey(
      grant.grant_id,
      /device_public_key .* is not in its one spelling/,
      deps({ configKey: f.pin.public_key.toUpperCase() }),
    );
  });
  it("by grant_id, the target key is the loaded key, never the config string", async () => {
    await handleRepoTaskDelegate(delegateArgs(), deps());
    const grant = grantOf();
    events = [];
    // The config names another (canonical) key; the loaded key is the grant's signer.
    await revoke(grant.grant_id, deps({ configKey: a.pin.public_key }));
    expect(events).toEqual(["load", "erase"]);
    const written = JSON.parse(fs.readFileSync(path.join(rev(), `${grant.grant_id}.json`), "utf8"));
    expect(await findGrantRevocation(grant, [written])).toEqual(written);
  });
});

describe("repo-task delegate and revoke: the key is erased before any exit", () => {
  it("a refusal after the key is unlocked erases it first", async () => {
    await expect(
      handleRepoTaskDelegate(delegateArgs(), deps({ refuseAfterKey: true })),
    ).rejects.toBeInstanceOf(ExitCalled);
    expect(events).toEqual(["load", "erase", "exit 1"]);
    expect(fs.existsSync(path.join(tmp, "out"))).toBe(false);
  });

  it("a revoke refused after the key is unlocked erases it first", async () => {
    await handleRepoTaskDelegate(delegateArgs(), deps());
    events = [];
    const revoke = parseCliArgs(["repo-task", "revoke", path.join(tmp, "out")]);
    await expect(
      handleRepoTaskRevoke(revoke, deps({ refuseAfterKey: true })),
    ).rejects.toBeInstanceOf(ExitCalled);
    expect(events).toEqual(["load", "erase", "exit 1"]);
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
});
