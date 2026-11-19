/**
 * `motebit register` and the per-relay key record.
 *
 * `register`'s own flow is unchanged (bootstrap, then the legacy pin with its
 * PIN MISMATCH rule). After it, ONE `bindRelayPin` call records the key this
 * relay proves for this URL — only when it is the key the install holds as
 * its legacy key. Numbered after the design's test plan (section 5).
 *
 * Real `handleRegister`, a real identity in a temporary config directory,
 * real fake relays on 127.0.0.1, ephemeral keys.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: no test reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "motebit-reg-pins-cfg-"));
  for (const k of [
    "MOTEBIT_SYNC_URL",
    "MOTEBIT_RELAY_URL",
    "MOTEBIT_API_TOKEN",
    "MOTEBIT_SYNC_TOKEN",
  ])
    delete process.env[k];
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseCliArgs } from "../args.js";
import { bootstrapReplIdentity } from "../cli-event-push.js";
import { loadFullConfig, saveFullConfig, type FullConfig } from "../config.js";
import { resetRelayKeyMemoryForTests, resolveRelayKey, type RelayPinEntry } from "../relay-pins.js";
import { resolveRelayUrl } from "../subcommands/_helpers.js";
import { handleRegister } from "../subcommands/register.js";
import {
  DECLARATION_PATH,
  METADATA_PATH,
  closeFakeRelays,
  deeplyNestedDeclarationBody,
  sendJson,
  sendRawJson,
  signDeclaration,
  startFakeRelay,
  type FakeRelay,
} from "./helpers/fake-relay.js";

const DIR = process.env["MOTEBIT_CONFIG_DIR"]!;
const CONFIG = path.join(DIR, "config.json");
const PINS = path.join(DIR, "relay-pins.json");
const LOCK = `${PINS}.lock`;
const PASS = "pass-register-pins";
const OTHER_KEY = "0f".repeat(32);
const FAST = { relayKey: { timeoutMs: 3_000, lockTimeoutMs: 80 } };

let logs: string[] = [];
let warnings: string[] = [];
let errors: string[] = [];

/** A fresh identity in the temporary config directory, with no relay state. */
async function freshInstall(): Promise<void> {
  fs.rmSync(CONFIG, { force: true });
  fs.rmSync(PINS, { recursive: true, force: true });
  fs.rmSync(LOCK, { force: true });
  await bootstrapReplIdentity({
    dbPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "motebit-reg-pins-db-")), "motebit.db"),
    fullConfig: {} as FullConfig,
    passphrase: PASS,
    syncConfigured: true,
  });
}

function setLegacyKey(key: string | undefined): void {
  const cfg = loadFullConfig();
  if (key === undefined) delete cfg.relay_public_key;
  else cfg.relay_public_key = key;
  saveFullConfig(cfg);
}

function pinsBytes(): string | null {
  try {
    return fs.readFileSync(PINS, "utf-8");
  } catch {
    return null;
  }
}

function writePins(pins: Record<string, RelayPinEntry>): string {
  const bytes = `${JSON.stringify({ version: 1, pins }, null, 2)}\n`;
  fs.writeFileSync(PINS, bytes, { mode: 0o600 });
  return bytes;
}

const entryOf = (key: string): RelayPinEntry => ({
  public_key: key,
  relay_id: "relay-under-test",
  pinned_at: 1,
});

const register = (relay: FakeRelay | string): Promise<void> =>
  handleRegister(
    parseCliArgs(["register", "--sync-url", typeof relay === "string" ? relay : relay.base]),
    FAST,
  );

/** `handleRegister` exits through `process.exit`, which the tests turn into a throw. */
const EXIT_1 = "process.exit(1)";

beforeEach(async () => {
  logs = [];
  warnings = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "warn").mockImplementation(
    (...a: unknown[]) => void warnings.push(a.join(" ")),
  );
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
  vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${String(code)})`);
  });
  process.env["MOTEBIT_PASSPHRASE"] = PASS;
  resetRelayKeyMemoryForTests();
  await freshInstall();
});

afterEach(async () => {
  await closeFakeRelays();
  vi.restoreAllMocks();
  delete process.env["MOTEBIT_PASSPHRASE"];
  delete process.env["MOTEBIT_SYNC_URL"];
  fs.rmSync(LOCK, { force: true });
});

describe("test 9 — register on a fresh install", () => {
  it("a relay that signs its URL: the legacy key is written as today AND the entry is written", async () => {
    const relay = await startFakeRelay();
    await register(relay);

    expect(loadFullConfig().relay_public_key).toBe(relay.identity.hex);
    expect(logs.join("\n")).toContain(`Pinned relay key ${relay.identity.hex.slice(0, 12)}…`);
    const record = JSON.parse(pinsBytes()!) as {
      version: number;
      pins: Record<string, RelayPinEntry>;
    };
    expect(record.version).toBe(1);
    expect(Object.keys(record.pins)).toEqual([relay.base]);
    expect(record.pins[relay.base]).toMatchObject({
      public_key: relay.identity.hex,
      relay_id: "relay-under-test",
    });
    expect(warnings).toEqual([]);
    expect(errors).toEqual([]);

    // Registering again is quiet: the entry is already there.
    await register(relay);
    expect(warnings).toEqual([]);
    expect(Object.keys((JSON.parse(pinsBytes()!) as typeof record).pins)).toEqual([relay.base]);
  });

  it("a relay that signs no URL: the legacy key is written as today, no entry, a warning with the remedy, exit 0", async () => {
    const relay = await startFakeRelay({ signs: () => "" });
    await register(relay); // resolves: no exit

    expect(loadFullConfig().relay_public_key).toBe(relay.identity.hex);
    expect(pinsBytes()).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("This relay does not sign its URL");
    expect(warnings[0]).toContain("motebit relay up --federation-url <url>");
    expect(warnings[0]).toContain("MOTEBIT_FEDERATION_ENDPOINT_URL=<url>");
    expect(errors).toEqual([]);
  });
});

describe("test 10 — register and a key that disagrees", () => {
  it("the legacy key equals the relay's key but this relay's entry holds a different key: exit 1, per-relay PIN MISMATCH naming the file and the entry; file byte-identical", async () => {
    const relay = await startFakeRelay();
    setLegacyKey(relay.identity.hex);
    const before = writePins({ [relay.base]: entryOf(OTHER_KEY) });

    await expect(register(relay)).rejects.toThrow(EXIT_1);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("PIN MISMATCH");
    expect(errors[0]).toContain(PINS); // the real path, under MOTEBIT_CONFIG_DIR
    expect(errors[0]).toContain(`entry ${relay.base}`);
    expect(errors[0]).toContain("remove that entry");
    expect(pinsBytes()).toBe(before);
  });

  it("the legacy key differs from the relay's key and the existing step compared: today's PIN MISMATCH, unchanged, and no entry written", async () => {
    const relay = await startFakeRelay();
    setLegacyKey(OTHER_KEY);

    await expect(register(relay)).rejects.toThrow(EXIT_1);

    expect(errors).toEqual([
      `PIN MISMATCH: this relay now declares key ${relay.identity.hex.slice(0, 12)}… but your ` +
        `config pins ${OTHER_KEY.slice(0, 12)}…. A relay that changes identity must be ` +
        `re-pinned deliberately: verify out-of-band, then remove relay_public_key from ` +
        `~/.motebit/config.json and re-run register. Refusing to overwrite.`,
    ]);
    expect(pinsBytes()).toBeNull();
    // The existing step exited: the added step never ran.
    expect(relay.count(METADATA_PATH)).toBe(0);
    expect(relay.count(DECLARATION_PATH)).toBe(1);
    expect(loadFullConfig().relay_public_key).toBe(OTHER_KEY);
  });
});

describe("test 10a — the existing step returns without comparing", () => {
  /** The declaration fails ONCE (the existing step's fetch), then is served. */
  function failDeclarationOnce(relay: FakeRelay): void {
    let served = 0;
    relay.route(DECLARATION_PATH, async (_req, res) => {
      if (served++ === 0) return sendJson(res, 500, { error: "once" });
      sendJson(res, 200, await signDeclaration(relay.identity));
    });
  }

  it("a differing legacy key, the full check then succeeds: no entry, the legacy_mismatch warning, exit code as today", async () => {
    const relay = await startFakeRelay();
    setLegacyKey(OTHER_KEY);
    failDeclarationOnce(relay);

    await register(relay); // exit code as today: 0

    expect(pinsBytes()).toBeNull();
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("could not fetch the relay transparency declaration");
    expect(warnings[1]).toBe(
      `Warning: This install's relay key does not match the key this relay proved, so nothing ` +
        `was changed for this relay. Run \`motebit register --sync-url ${relay.base}\` again.`,
    );
    expect(loadFullConfig().relay_public_key).toBe(OTHER_KEY);
    // Counts: the metadata once; the declaration twice (existing step + full check).
    expect(relay.count(METADATA_PATH)).toBe(1);
    expect(relay.count(DECLARATION_PATH)).toBe(2);
  });

  it("no legacy key, the full check then succeeds: no entry, the legacy_mismatch warning, exit code as today", async () => {
    const relay = await startFakeRelay();
    failDeclarationOnce(relay);

    await register(relay);

    expect(pinsBytes()).toBeNull();
    expect(loadFullConfig().relay_public_key).toBeUndefined();
    expect(warnings).toHaveLength(2);
    expect(warnings[1]).toContain(
      "This install's relay key does not match the key this relay proved, so nothing was changed for this relay.",
    );
    expect(relay.count(METADATA_PATH)).toBe(1);
    expect(relay.count(DECLARATION_PATH)).toBe(2);
  });

  it("an existing entry and no key established (endpoint_empty): the entry is untouched; the declaration is requested once", async () => {
    const relay = await startFakeRelay({ signs: () => "" });
    setLegacyKey(relay.identity.hex);
    const before = writePins({ [relay.base]: entryOf(OTHER_KEY) });

    await register(relay);

    expect(pinsBytes()).toBe(before);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("This relay does not sign its URL");
    // The metadata step failed: once for the metadata, once (the existing
    // step) for the declaration — the full check does not request it.
    expect(relay.count(METADATA_PATH)).toBe(1);
    expect(relay.count(DECLARATION_PATH)).toBe(1);
  });

  it("request counts on the ordinary path: the metadata exactly once, the declaration twice", async () => {
    const relay = await startFakeRelay();
    await register(relay);
    expect(relay.count(METADATA_PATH)).toBe(1);
    expect(relay.count(DECLARATION_PATH)).toBe(2);
  });

  it("an unpinnable relay URL (an `@` in the path, which works on main): bindRelayPin requests neither document", async () => {
    const relay = await startFakeRelay({ prefix: "/@relay" });
    await register(`${relay.base}/@relay`);

    // Registration and the legacy pin work exactly as today.
    expect(loadFullConfig().relay_public_key).toBe(relay.identity.hex);
    expect(relay.count(`/@relay${METADATA_PATH}`)).toBe(0);
    expect(relay.count(`/@relay${DECLARATION_PATH}`)).toBe(1); // the existing step
    expect(pinsBytes()).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("This relay URL cannot be used for a relay key");
  });
});

describe("test 6c — register while another live process holds the record's lock", () => {
  it("the warning names the file and the cause; exit code as today; nothing written", async () => {
    const relay = await startFakeRelay();
    fs.writeFileSync(LOCK, `${process.ppid} foreign-lock-token`, { mode: 0o600 });

    await register(relay); // resolves: the registration itself succeeded

    expect(pinsBytes()).toBeNull();
    expect(loadFullConfig().relay_public_key).toBe(relay.identity.hex);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`The relay key record \`${PINS}\` could not be read or written`);
    expect(warnings[0]).toContain("locked by another motebit process");
    expect(warnings[0]).toContain(`motebit register --sync-url ${relay.base}\` again`);
    expect(errors).toEqual([]);
  });
});

describe("register against a relay whose declaration cannot be verified", () => {
  /** What one `register` run left behind. */
  async function outcomeOf(relay: FakeRelay): Promise<{
    exit: string;
    legacyKey: string | undefined;
    pins: string | null;
    lastWarning: string;
  }> {
    warnings = [];
    const exit = await register(relay).then(
      () => "resolved (exit 0)",
      (err: unknown) => String(err),
    );
    return {
      exit,
      legacyKey: loadFullConfig().relay_public_key,
      pins: pinsBytes(),
      lastWarning: warnings.at(-1) ?? "",
    };
  }

  it("a declaration the verifier throws on: the same exit code and legacy-key behaviour as an invalid declaration, with the no_key warning", async () => {
    // The reference: a declaration that fails verification with a verdict.
    const invalid = await startFakeRelay();
    invalid.route(DECLARATION_PATH, async (_req, res) => {
      const declaration = await signDeclaration(invalid.identity);
      sendJson(res, 200, { ...declaration, content: { posture: "edited after signing" } });
    });
    const reference = await outcomeOf(invalid);
    expect(reference).toEqual({
      exit: "resolved (exit 0)",
      legacyKey: undefined,
      pins: null,
      lastWarning:
        `Warning: no per-relay key was recorded for ${invalid.base}. ` +
        "This relay's key was not established (declaration_invalid).",
    });

    // The case: a declaration nested so deeply that verifying it THROWS.
    await freshInstall();
    const deep = await startFakeRelay();
    const body = deeplyNestedDeclarationBody(deep.identity);
    deep.route(DECLARATION_PATH, (_req, res) => sendRawJson(res, body));
    const outcome = await outcomeOf(deep);

    expect(outcome).toEqual({
      ...reference,
      lastWarning: reference.lastWarning.replace(invalid.base, deep.base),
    });
    expect(errors).toEqual([]);
    // The existing step absorbed the same throw, as it does on main.
    expect(warnings[0]).toContain("could not fetch the relay transparency declaration");
    expect(deep.count(METADATA_PATH)).toBe(1);
    expect(deep.count(DECLARATION_PATH)).toBe(2);
  });
});

describe("test 12 — register with a damaged record", () => {
  it("exits 1 naming the file, before the passphrase prompt and any request; bytes unchanged", async () => {
    const relay = await startFakeRelay();
    fs.writeFileSync(PINS, "{ not json");
    // A wrong passphrase: had registration reached the key, THAT would be the error.
    process.env["MOTEBIT_PASSPHRASE"] = "not-the-passphrase";

    await expect(register(relay)).rejects.toThrow(EXIT_1);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(PINS);
    expect(errors[0]).toContain("Move the file aside");
    expect(relay.requests).toEqual([]);
    expect(pinsBytes()).toBe("{ not json");
    expect(loadFullConfig().relay_public_key).toBeUndefined();
  });

  it("a record written by a newer CLI: exits 1 with the upgrade remedy, no request", async () => {
    const relay = await startFakeRelay();
    const bytes = JSON.stringify({ version: 2, pins: {} });
    fs.writeFileSync(PINS, bytes);

    await expect(register(relay)).rejects.toThrow(EXIT_1);

    expect(errors[0]).toContain(PINS);
    expect(errors[0]).toContain("Upgrade the CLI");
    expect(relay.requests).toEqual([]);
    expect(pinsBytes()).toBe(bytes);
  });
});

describe("test 7 — register on A, then sessions naming B", () => {
  /** What `index.ts` hands the relay wiring for the session's relay. */
  async function keyPassedFor(argv: string[]): Promise<{ url: string; key: string | undefined }> {
    resetRelayKeyMemoryForTests(); // a new session
    const url = resolveRelayUrl(parseCliArgs(argv), loadFullConfig())!;
    const resolution = await resolveRelayKey(url, FAST.relayKey);
    return { url, key: resolution.status === "key" ? resolution.key : undefined };
  }

  it("no key is passed for B named by --sync-url, by MOTEBIT_SYNC_URL, or by the saved sync_url", async () => {
    const a = await startFakeRelay();
    const b = await startFakeRelay(); // its own key, fully valid documents
    await register(a);
    expect(loadFullConfig().sync_url).toBe(a.base);
    expect(loadFullConfig().relay_public_key).toBe(a.identity.hex);

    // A session on A gets A's key.
    expect(await keyPassedFor([])).toEqual({ url: a.base, key: a.identity.hex });

    // B by the flag.
    expect(await keyPassedFor(["--sync-url", b.base])).toEqual({ url: b.base, key: undefined });

    // B by the environment.
    process.env["MOTEBIT_SYNC_URL"] = b.base;
    expect(await keyPassedFor([])).toEqual({ url: b.base, key: undefined });
    delete process.env["MOTEBIT_SYNC_URL"];

    // B by the saved config.
    const cfg = loadFullConfig();
    cfg.sync_url = b.base;
    saveFullConfig(cfg);
    expect(await keyPassedFor([])).toEqual({ url: b.base, key: undefined });

    // Nothing was recorded for B, and A's entry stands.
    const record = JSON.parse(pinsBytes()!) as { pins: Record<string, RelayPinEntry> };
    expect(Object.keys(record.pins)).toEqual([a.base]);
  });
});
