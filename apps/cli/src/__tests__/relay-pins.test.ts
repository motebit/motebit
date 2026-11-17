/**
 * The per-relay record of relay keys (`relay-pins.ts`): a relay key is used
 * only for the relay URL that key signs.
 *
 * Numbered after the design's test plan (section 5). Ephemeral keys; every
 * relay is a real HTTP server on 127.0.0.1; the config directory is a
 * temporary one; no money moves. Refusals are asserted by reason value, and
 * every fixture is valid except for the one thing under test. "The next
 * start" is modelled with the test-only memory reset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: no test reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "motebit-relay-pins-"));
  delete process.env["MOTEBIT_SYNC_URL"];
});

import * as fs from "node:fs";
import * as path from "node:path";
import { preflightGrant, renderPreflight } from "../grant-preflight.js";
import {
  addRelayPin,
  bindRelayPin,
  fullRelayCheck,
  readRelayPins,
  relayKeyRemedy,
  relayKeyStartupLine,
  relayPinsPath,
  resetRelayKeyMemoryForTests,
  resolveRelayKey,
  type RelayKeyResolution,
  type RelayPinEntry,
} from "../relay-pins.js";
import type { StoredGrant } from "../subcommands/grant.js";
import { verifyTransparencyDeclaration } from "@motebit/state-export-client";
import {
  DECLARATION_PATH,
  METADATA_PATH,
  closeFakeRelays,
  deadUrl,
  deeplyNestedDeclarationBody,
  newRelayIdentity,
  sendJson,
  sendRawJson,
  signDeclaration,
  signMetadata,
  startFakeRelay,
} from "./helpers/fake-relay.js";

const DIR = process.env["MOTEBIT_CONFIG_DIR"]!;
const CONFIG = path.join(DIR, "config.json");
const PINS = path.join(DIR, "relay-pins.json");
const LOCK = `${PINS}.lock`;
const WHERE = "the `--sync-url` or `--sync` flag";
/** Short timeouts: nothing here waits five real seconds. */
const FAST = { timeoutMs: 3_000, lockTimeoutMs: 80 };
const OTHER_KEY = "0f".repeat(32);

/** Set (or remove) the legacy `relay_public_key` in config.json. */
function setLegacyKey(key: string | undefined): void {
  if (key === undefined) fs.rmSync(CONFIG, { force: true });
  else fs.writeFileSync(CONFIG, JSON.stringify({ relay_public_key: key }), { mode: 0o600 });
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

/** Hold the record's lock the way another LIVE motebit process would. */
function holdLockAsForeignProcess(): void {
  fs.writeFileSync(LOCK, `${process.ppid} foreign-lock-token`, { mode: 0o600 });
}

const NOW = 1_783_400_000_000;
const HOUR = 3_600_000;
function storedGrant(): StoredGrant {
  return {
    grant: {
      grant_id: "019f0000-0000-7000-8000-000000000000",
      scope: "delegate_to_agent",
      expires_at: NOW + 7 * 24 * HOUR,
    },
    ticks: [{ issued_at: NOW - HOUR, not_before: NOW - HOUR, expires_at: NOW + HOUR }],
  } as never;
}

/** The pre-flight's relay-pin check, given the session's result. */
async function preflightPin(relayKey: RelayKeyResolution | { status: "no_relay" }) {
  const pf = await preflightGrant({
    stored: storedGrant(),
    now: NOW,
    fullConfig: { governance: { approvalPreset: "autonomous" } } as never,
    hasRail: true,
    relayKey,
    relaySource: WHERE,
  });
  return { pf, pin: pf.checks.find((c) => c.name === "relay-pin")! };
}

beforeEach(() => {
  fs.rmSync(PINS, { recursive: true, force: true });
  fs.rmSync(LOCK, { force: true });
  fs.rmSync(CONFIG, { force: true });
  resetRelayKeyMemoryForTests();
});

afterEach(async () => {
  await closeFakeRelays();
  fs.rmSync(LOCK, { force: true });
});

it("the record lives in the config directory, MOTEBIT_CONFIG_DIR honoured", () => {
  expect(relayPinsPath()).toBe(PINS);
});

describe("test 2 — the full check: the declaration reasons", () => {
  it("establishes the key when the metadata names this URL and the declaration agrees", async () => {
    const relay = await startFakeRelay();
    expect(await fullRelayCheck(relay.base, FAST)).toEqual({
      ok: true,
      pinKey: relay.base,
      publicKey: relay.identity.hex,
      relayId: "relay-under-test",
    });
    expect(relay.requests).toEqual([`GET ${METADATA_PATH}`, `GET ${DECLARATION_PATH}`]);
  });

  it("unreachable: the declaration request gets no answer within the timeout", async () => {
    const relay = await startFakeRelay();
    relay.route(DECLARATION_PATH, () => {
      /* never answers */
    });
    expect(await fullRelayCheck(relay.base, { timeoutMs: 60 })).toEqual({
      ok: false,
      reason: "unreachable",
    });
  });

  it("redirect_refused: the declaration redirects, even to a declaration that would pass", async () => {
    const relay = await startFakeRelay();
    relay.route(DECLARATION_PATH, (_req, res) => {
      res.writeHead(302, { Location: `${relay.base}/moved-declaration.json` });
      res.end();
    });
    relay.route("/moved-declaration.json", async (_req, res) => {
      sendJson(res, 200, await signDeclaration(relay.identity));
    });
    // Following it WOULD succeed: the target is this relay's valid declaration.
    const followed = await fetch(`${relay.base}${DECLARATION_PATH}`);
    expect(followed.ok).toBe(true);
    expect(((await followed.json()) as { relay_public_key: string }).relay_public_key).toBe(
      relay.identity.hex,
    );
    relay.requests.length = 0;

    expect(await fullRelayCheck(relay.base, FAST)).toEqual({
      ok: false,
      reason: "redirect_refused",
    });
    expect(relay.count("/moved-declaration.json")).toBe(0);
  });

  it("declaration_unavailable: answered, but non-2xx", async () => {
    const relay = await startFakeRelay();
    relay.route(DECLARATION_PATH, (_req, res) => sendJson(res, 404, { error: "none" }));
    expect(await fullRelayCheck(relay.base, FAST)).toEqual({
      ok: false,
      reason: "declaration_unavailable",
    });
  });

  it("declaration_unavailable: answered, but not a declaration", async () => {
    const notJson = await startFakeRelay();
    notJson.route(DECLARATION_PATH, (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html></html>");
    });
    const wrongShape = await startFakeRelay();
    wrongShape.route(DECLARATION_PATH, (_req, res) => sendJson(res, 200, { hello: "world" }));
    for (const relay of [notJson, wrongShape]) {
      expect(await fullRelayCheck(relay.base, FAST)).toEqual({
        ok: false,
        reason: "declaration_unavailable",
      });
    }
  });

  it("declaration_invalid: the declaration fails its own verification", async () => {
    const relay = await startFakeRelay();
    relay.route(DECLARATION_PATH, async (_req, res) => {
      const declaration = await signDeclaration(relay.identity);
      sendJson(res, 200, { ...declaration, content: { posture: "edited after signing" } });
    });
    expect(await fullRelayCheck(relay.base, FAST)).toEqual({
      ok: false,
      reason: "declaration_invalid",
    });
  });

  it("declaration_key_mismatch: a valid declaration that names a different key", async () => {
    const relay = await startFakeRelay();
    const other = await newRelayIdentity();
    relay.route(DECLARATION_PATH, async (_req, res) => {
      sendJson(res, 200, await signDeclaration(other));
    });
    expect(await fullRelayCheck(relay.base, FAST)).toEqual({
      ok: false,
      reason: "declaration_key_mismatch",
    });
  });

  it("declaration_relay_id_mismatch: a valid declaration that names a different relay_id", async () => {
    const relay = await startFakeRelay({ declaration: { relay_id: "some-other-relay" } });
    expect(await fullRelayCheck(relay.base, FAST)).toEqual({
      ok: false,
      reason: "declaration_relay_id_mismatch",
    });
  });

  it("a failed metadata step does not request the declaration", async () => {
    const relay = await startFakeRelay({ signs: () => "" });
    expect(await fullRelayCheck(relay.base, FAST)).toEqual({ ok: false, reason: "endpoint_empty" });
    expect(relay.count(METADATA_PATH)).toBe(1);
    expect(relay.count(DECLARATION_PATH)).toBe(0);
  });
});

describe("a declaration the verifier throws on is the relay's fault, never a throw and never the record's", () => {
  /** A relay whose metadata is valid and whose declaration overflows the verifier. */
  async function relayWithUnverifiableDeclaration() {
    const relay = await startFakeRelay();
    const body = deeplyNestedDeclarationBody(relay.identity);
    relay.route(DECLARATION_PATH, (_req, res) => sendRawJson(res, body));
    return { relay, body };
  }

  it("the fixture: the declaration parses, and verifying it throws (it does not return a verdict)", async () => {
    const { relay, body } = await relayWithUnverifiableDeclaration();
    const parsed = JSON.parse(body) as Parameters<typeof verifyTransparencyDeclaration>[0];
    expect(parsed.relay_public_key).toBe(relay.identity.hex);
    await expect(verifyTransparencyDeclaration(parsed)).rejects.toThrow(RangeError);
  });

  it("bindRelayPin: no_key with declaration_invalid, it does not throw, no file written", async () => {
    const { relay } = await relayWithUnverifiableDeclaration();
    setLegacyKey(relay.identity.hex); // everything else would bind

    await expect(bindRelayPin(relay.base, FAST)).resolves.toEqual({
      result: "no_key",
      reason: "declaration_invalid",
    });
    expect(relay.count(DECLARATION_PATH)).toBe(1);
    expect(pinsBytes()).toBeNull();
    expect(fs.existsSync(LOCK)).toBe(false);
  });

  it("the full check: declaration_invalid", async () => {
    const { relay } = await relayWithUnverifiableDeclaration();
    await expect(fullRelayCheck(relay.base, FAST)).resolves.toEqual({
      ok: false,
      reason: "declaration_invalid",
    });
  });

  it("lazy binding: no key, with the declaration reason — not 'the record could not be read or written'", async () => {
    const { relay } = await relayWithUnverifiableDeclaration();
    setLegacyKey(relay.identity.hex);

    const res = await resolveRelayKey(relay.base, FAST);
    expect(res).toEqual({
      status: "no_key",
      relayUrl: relay.base,
      reason: "no_key",
      check: "declaration_invalid",
    });
    expect(pinsBytes()).toBeNull();
    const line = relayKeyStartupLine(res, WHERE)!;
    expect(line).toContain("This relay's key was not established (declaration_invalid).");
    expect(line).not.toContain("could not be read or written");
    expect(line).not.toContain("Maximum call stack");
    expect(line).not.toContain(PINS);
  });
});

describe("test 3 — a server holding only copies of relay A's documents", () => {
  it("B, on A's host under another path, serves A's documents: endpoint_mismatch, no entry, the message names the URL A signed", async () => {
    // One host. A lives at /a and signs /a; B lives at /b and serves A's bytes.
    const a = await startFakeRelay({ prefix: "/a" });
    a.route(`/b${METADATA_PATH}`, async (_req, res) => {
      sendJson(res, 200, await signMetadata(a.identity, `${a.base}/a`));
    });
    a.route(`/b${DECLARATION_PATH}`, async (_req, res) => {
      sendJson(res, 200, await signDeclaration(a.identity));
    });
    // This install holds A's key: everything but the URL would bind.
    setLegacyKey(a.identity.hex);

    const forB = await resolveRelayKey(`${a.base}/b`, FAST);
    expect(forB).toEqual({
      status: "no_key",
      relayUrl: `${a.base}/b`,
      reason: "no_key",
      check: "endpoint_mismatch",
      signedPinKey: `${a.base}/a`,
    });
    expect(pinsBytes()).toBeNull();
    const line = relayKeyStartupLine(forB, WHERE)!;
    expect(line).toContain(`This relay signs \`${a.base}/a\`, not the URL you named`);
    expect(line).toContain(`motebit register --sync-url ${a.base}/a`);
    expect(line).toContain(WHERE);

    // A itself, at the URL it signs, binds.
    const forA = await resolveRelayKey(`${a.base}/a`, FAST);
    expect(forA).toMatchObject({ status: "key", key: a.identity.hex, origin: "added" });
  });

  it("a signed value that is not a usable address is not echoed", async () => {
    const relay = await startFakeRelay({ signs: () => "javascript:alert(1)" });
    setLegacyKey(relay.identity.hex);
    const res = await resolveRelayKey(relay.base, FAST);
    expect(res).toMatchObject({ reason: "no_key", check: "endpoint_mismatch", signedPinKey: null });
    const line = relayKeyStartupLine(res, WHERE)!;
    expect(line).toContain("signs a value that is not a usable relay address");
    expect(line).not.toContain("javascript");
  });
});

describe("test 4 — a legacy-only install on the relay that proves the legacy key", () => {
  it("the entry is written, one line is printed, the key is passed; the next start makes no fetch", async () => {
    const relay = await startFakeRelay();
    setLegacyKey(relay.identity.hex.toUpperCase()); // compared lowercase

    const first = await resolveRelayKey(relay.base, FAST);
    expect(first).toEqual({
      status: "key",
      relayUrl: relay.base,
      key: relay.identity.hex,
      origin: "added",
    });
    const record = readRelayPins();
    expect(record.status).toBe("ok");
    if (record.status !== "ok") return;
    expect(Object.keys(record.pins)).toEqual([relay.base]);
    expect(record.pins[relay.base]).toMatchObject({
      public_key: relay.identity.hex,
      relay_id: "relay-under-test",
    });
    expect(typeof record.pins[relay.base]!.pinned_at).toBe("number");
    expect(fs.statSync(PINS).mode & 0o777).toBe(0o600);
    expect(JSON.parse(pinsBytes()!)).toMatchObject({ version: 1 });
    const line = relayKeyStartupLine(first, WHERE);
    expect(line).toContain(relay.identity.hex.slice(0, 12));
    expect(line).toContain(relay.base);

    // The next start: the entry is used and the relay is not asked.
    resetRelayKeyMemoryForTests();
    relay.requests.length = 0;
    const next = await resolveRelayKey(relay.base, FAST);
    expect(next).toEqual({
      status: "key",
      relayUrl: relay.base,
      key: relay.identity.hex,
      origin: "recorded",
    });
    expect(relay.requests).toEqual([]);
    expect(relayKeyStartupLine(next, WHERE)).toBeNull();
  });

  it("another spelling of the same relay URL uses the same entry", async () => {
    const relay = await startFakeRelay();
    writePins({ [relay.base]: entryOf(relay.identity.hex) });
    const res = await resolveRelayKey(`${relay.base.replace("http://", "HTTP://")}/`, FAST);
    expect(res).toMatchObject({ status: "key", key: relay.identity.hex, origin: "recorded" });
    expect(relay.requests).toEqual([]);
  });
});

describe("test 5 — a legacy-only install on a relay that does not prove the legacy key", () => {
  it("a relay with a different key: no entry, no key passed, the reason's line", async () => {
    const relay = await startFakeRelay();
    setLegacyKey(OTHER_KEY);

    const res = await resolveRelayKey(relay.base, FAST);
    expect(res).toEqual({ status: "no_key", relayUrl: relay.base, reason: "legacy_mismatch" });
    expect(pinsBytes()).toBeNull();
    const line = relayKeyStartupLine(res, WHERE)!;
    expect(line).toContain(
      "This install's relay key was pinned for another relay or this relay's key changed.",
    );
    expect(line).toContain(`motebit register --sync-url ${relay.base}`);
    // One attempt per process: the answer is remembered, the relay not asked again.
    const asked = relay.requests.length;
    expect(await resolveRelayKey(relay.base, FAST)).toBe(res);
    expect(relay.requests.length).toBe(asked);
  });

  it("a relay that signs no URL: no entry, no key passed, the remedy names how its operator makes it sign one", async () => {
    const relay = await startFakeRelay({ signs: () => "" });
    setLegacyKey(relay.identity.hex);

    const res = await resolveRelayKey(relay.base, FAST);
    expect(res).toEqual({
      status: "no_key",
      relayUrl: relay.base,
      reason: "no_key",
      check: "endpoint_empty",
    });
    expect(pinsBytes()).toBeNull();
    const line = relayKeyStartupLine(res, WHERE)!;
    expect(line).toContain("This relay does not sign its URL");
    expect(line).toContain("motebit relay up --federation-url <url>");
    expect(line).toContain("MOTEBIT_FEDERATION_ENDPOINT_URL=<url>");
  });
});

describe("test 6 — no legacy key and no record", () => {
  it("the relay receives no request, no key is passed, no file is created, and the REPL prints no line", async () => {
    const relay = await startFakeRelay(); // serves fully valid documents
    const res = await resolveRelayKey(relay.base, FAST);
    expect(relay.requests).toEqual([]);
    expect(res).toEqual({ status: "no_key", relayUrl: relay.base, reason: "not_pinned" });
    expect(pinsBytes()).toBeNull();
    expect(fs.existsSync(LOCK)).toBe(false);
    expect(relayKeyStartupLine(res, WHERE)).toBeNull();
    // `delegate --sovereign` and the pre-flight DO say so.
    expect(relayKeyRemedy(res as never, WHERE)).toBe(
      `No relay key is pinned. Run \`motebit register --sync-url ${relay.base}\`.`,
    );
  });
});

describe("test 6a — bindRelayPin writes only a key this install already held", () => {
  it("no legacy key: legacy_mismatch, no file written", async () => {
    const relay = await startFakeRelay();
    expect(await bindRelayPin(relay.base, FAST)).toEqual({ result: "legacy_mismatch" });
    expect(pinsBytes()).toBeNull();
  });

  it("the legacy key is removed from config.json while the full check is in flight: legacy_mismatch, no file written", async () => {
    const relay = await startFakeRelay();
    setLegacyKey(relay.identity.hex);
    relay.before(DECLARATION_PATH, () => setLegacyKey(undefined));
    expect(await bindRelayPin(relay.base, FAST)).toEqual({ result: "legacy_mismatch" });
    expect(relay.count(DECLARATION_PATH)).toBe(1);
    expect(pinsBytes()).toBeNull();
  });

  it("an entry on disk equal to the proved key, and a differing legacy key: legacy_mismatch, file byte-identical", async () => {
    const relay = await startFakeRelay();
    const before = writePins({ [relay.base]: entryOf(relay.identity.hex) });
    setLegacyKey(OTHER_KEY);
    expect(await bindRelayPin(relay.base, FAST)).toEqual({ result: "legacy_mismatch" });
    expect(pinsBytes()).toBe(before);
  });

  it("no key established: no_key with the reason, and the legacy key is not consulted", async () => {
    const relay = await startFakeRelay({ signs: () => "" });
    setLegacyKey(relay.identity.hex);
    expect(await bindRelayPin(relay.base, FAST)).toEqual({
      result: "no_key",
      reason: "endpoint_empty",
    });
    expect(pinsBytes()).toBeNull();
  });
});

describe("test 6b — addRelayPin, the store: the only writer, and it never overwrites", () => {
  const PIN = "https://relay.example";
  const KEY = "ab".repeat(32);

  it("no entry: writes it and returns added", () => {
    expect(addRelayPin(PIN, entryOf(KEY))).toEqual({ result: "added" });
    expect(JSON.parse(pinsBytes()!)).toEqual({ version: 1, pins: { [PIN]: entryOf(KEY) } });
    expect(fs.statSync(PINS).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(LOCK)).toBe(false);
  });

  it("an entry for the same pin key under a DIFFERENT key: conflict, file byte-identical", () => {
    const before = writePins({ [PIN]: entryOf(OTHER_KEY) });
    expect(addRelayPin(PIN, entryOf(KEY))).toEqual({ result: "conflict" });
    expect(pinsBytes()).toBe(before);
  });

  it("an entry for the same pin key under the SAME key: already_present, file byte-identical", () => {
    const before = writePins({ [PIN]: { ...entryOf(KEY), pinned_at: 42 } });
    expect(addRelayPin(PIN, entryOf(KEY))).toEqual({ result: "already_present" });
    expect(pinsBytes()).toBe(before);
  });

  it("another relay's entry is kept when one is added", () => {
    writePins({ "https://other.example": entryOf(OTHER_KEY) });
    expect(addRelayPin(PIN, entryOf(KEY))).toEqual({ result: "added" });
    expect(JSON.parse(pinsBytes()!).pins).toEqual({
      "https://other.example": entryOf(OTHER_KEY),
      [PIN]: entryOf(KEY),
    });
  });

  it("the lock is held by another live process: unavailable, does not throw, writes nothing", () => {
    holdLockAsForeignProcess();
    let result: ReturnType<typeof addRelayPin> | undefined;
    expect(() => {
      result = addRelayPin(PIN, entryOf(KEY), { lockTimeoutMs: 80 });
    }).not.toThrow();
    expect(result).toMatchObject({ result: "unavailable" });
    expect((result as { cause: string }).cause).toContain("locked by another motebit process");
    expect(pinsBytes()).toBeNull();
    // The foreign lock is not broken.
    expect(fs.readFileSync(LOCK, "utf-8")).toBe(`${process.ppid} foreign-lock-token`);
  });

  it("a directory at the file's path: unavailable, does not throw, writes nothing", () => {
    fs.mkdirSync(PINS);
    let result: ReturnType<typeof addRelayPin> | undefined;
    expect(() => {
      result = addRelayPin(PIN, entryOf(KEY), { lockTimeoutMs: 80 });
    }).not.toThrow();
    expect(result).toMatchObject({ result: "unavailable" });
    expect(fs.statSync(PINS).isDirectory()).toBe(true);
    expect(fs.readdirSync(PINS)).toEqual([]);
  });

  it("a damaged file: unavailable, does not throw, writes nothing", () => {
    fs.writeFileSync(PINS, "{ not json");
    let result: ReturnType<typeof addRelayPin> | undefined;
    expect(() => {
      result = addRelayPin(PIN, entryOf(KEY), { lockTimeoutMs: 80 });
    }).not.toThrow();
    expect(result).toMatchObject({ result: "unavailable" });
    expect(pinsBytes()).toBe("{ not json");
  });
});

describe("test 6c — the record's lock is held by another live process (the real store)", () => {
  it("lazy binding: resolveRelayKey resolves with no key, and the warning names the file and the cause", async () => {
    const relay = await startFakeRelay();
    setLegacyKey(relay.identity.hex);
    holdLockAsForeignProcess();

    const res = await resolveRelayKey(relay.base, FAST); // resolves; never throws
    expect(res).toMatchObject({ status: "no_key", reason: "unavailable", file: PINS });
    expect(pinsBytes()).toBeNull();
    const line = relayKeyStartupLine(res, WHERE)!;
    expect(line).toContain(`The relay key record \`${PINS}\` could not be read or written`);
    expect(line).toContain("locked by another motebit process");
    expect(line).toContain(`motebit register --sync-url ${relay.base}`);
  });
});

describe("test 6d — lazy binding finds a different key recorded meanwhile (conflict)", () => {
  it("no key is used; the line names the file and the entry; the answer is remembered; the pre-flight fails naming the conflict", async () => {
    const relay = await startFakeRelay();
    setLegacyKey(relay.identity.hex);
    // Another process records a DIFFERENT key for this relay while this
    // process's full check is in flight.
    let recorded = "";
    relay.before(DECLARATION_PATH, () => {
      recorded = writePins({ [relay.base]: entryOf(OTHER_KEY) });
    });

    const res = await resolveRelayKey(relay.base, FAST);
    expect(res).toEqual({
      status: "no_key",
      relayUrl: relay.base,
      reason: "conflict",
      file: PINS,
      pinKey: relay.base,
    });
    expect(pinsBytes()).toBe(recorded); // nothing changed
    const line = relayKeyStartupLine(res, WHERE)!;
    expect(line).toContain(
      `A different key is already recorded for this relay in \`${PINS}\` (entry \`${relay.base}\`)`,
    );
    expect(line).toContain("No relay key is used in this session.");
    expect(line).toContain("Verify the relay's key out of band, then remove that entry.");

    // A second call in the same process: the same answer, with no request and
    // no look at the file (which now holds an entry a fresh read would use).
    const asked = relay.requests.length;
    const again = await resolveRelayKey(relay.base, FAST);
    expect(again).toBe(res);
    expect(again.status).toBe("no_key");
    expect(relay.requests.length).toBe(asked);

    const { pf, pin } = await preflightPin(again);
    expect(pf.armed).toBe(false);
    expect(pin.ok).toBe(false);
    expect(pin.detail).toContain(relay.base);
    expect(pin.remedy).toContain("A different key is already recorded for this relay");
    expect(pin.remedy).toContain(PINS);
  });
});

describe("test 6e — one answer per process", () => {
  it("after no_key, an entry added by another process is not picked up in this process; the pre-flight fails", async () => {
    const url = await deadUrl();
    setLegacyKey(OTHER_KEY);
    const first = await resolveRelayKey(url, { timeoutMs: 500, lockTimeoutMs: 80 });
    expect(first).toMatchObject({ status: "no_key", reason: "no_key", check: "unreachable" });

    writePins({ [url]: entryOf(OTHER_KEY) }); // another process binds it
    const second = await resolveRelayKey(url, { timeoutMs: 500, lockTimeoutMs: 80 });
    expect(second).toBe(first);
    expect(second.status).toBe("no_key");
    const { pin } = await preflightPin(second);
    expect(pin.ok).toBe(false);
    expect(pin.remedy).toContain("Could not reach the relay");

    // The next start does use it.
    resetRelayKeyMemoryForTests();
    expect(await resolveRelayKey(url, FAST)).toMatchObject({ status: "key", key: OTHER_KEY });
  });

  it("after unavailable, an entry added by another process is not picked up in this process; the pre-flight fails", async () => {
    const relay = await startFakeRelay();
    setLegacyKey(relay.identity.hex);
    holdLockAsForeignProcess();
    const first = await resolveRelayKey(relay.base, FAST);
    expect(first).toMatchObject({ status: "no_key", reason: "unavailable" });

    fs.rmSync(LOCK, { force: true });
    writePins({ [relay.base]: entryOf(relay.identity.hex) });
    const second = await resolveRelayKey(relay.base, FAST);
    expect(second).toBe(first);
    expect(second.status).toBe("no_key");
    const { pin } = await preflightPin(second);
    expect(pin.ok).toBe(false);
    expect(pin.remedy).toContain("could not be read or written");
  });
});

describe("test 11 — two bindings of the same key for one relay, interleaved", () => {
  it("both succeed and the file holds the one entry", async () => {
    const relay = await startFakeRelay();
    setLegacyKey(relay.identity.hex);
    // Hold both runs after their network work, before either reaches the store.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let waiting = 0;
    const gated: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (typeof input === "string" && input.endsWith(DECLARATION_PATH)) {
        waiting++;
        await gate;
      }
      return res;
    };

    const one = bindRelayPin(relay.base, { ...FAST, fetchImpl: gated });
    const two = bindRelayPin(relay.base, { ...FAST, fetchImpl: gated });
    await vi.waitFor(() => expect(waiting).toBe(2));
    expect(pinsBytes()).toBeNull();
    release();
    const results = await Promise.all([one, two]);

    expect(results.map((r) => r.result).sort()).toEqual(["added", "already_present"]);
    for (const r of results) expect(r).toMatchObject({ publicKey: relay.identity.hex });
    const record = JSON.parse(pinsBytes()!) as { pins: Record<string, RelayPinEntry> };
    expect(Object.keys(record.pins)).toEqual([relay.base]);
    expect(record.pins[relay.base]!.public_key).toBe(relay.identity.hex);
  });
});

describe("test 12 — a damaged record is 'pins unknown', never empty", () => {
  const MOVE_ASIDE = "Move the file aside";
  const UPGRADE = "Upgrade the CLI";
  const cases: Array<{
    name: string;
    make: () => void;
    damage: "damaged" | "newer_version";
    remedy: string;
  }> = [
    {
      name: "invalid JSON",
      make: () => fs.writeFileSync(PINS, "{ not json"),
      damage: "damaged",
      remedy: MOVE_ASIDE,
    },
    {
      name: "unreadable (a directory at its path)",
      make: () => fs.mkdirSync(PINS),
      damage: "damaged",
      remedy: MOVE_ASIDE,
    },
    {
      name: "no version",
      make: () => fs.writeFileSync(PINS, JSON.stringify({ pins: {} })),
      damage: "damaged",
      remedy: MOVE_ASIDE,
    },
    {
      name: "wrong shape (pins is not an object)",
      make: () => fs.writeFileSync(PINS, JSON.stringify({ version: 1, pins: [] })),
      damage: "damaged",
      remedy: MOVE_ASIDE,
    },
    {
      name: "wrong shape (an entry without a 64-hex key)",
      make: () =>
        fs.writeFileSync(
          PINS,
          JSON.stringify({
            version: 1,
            pins: { "https://relay.example": { public_key: "abc", relay_id: "r", pinned_at: 1 } },
          }),
        ),
      damage: "damaged",
      remedy: MOVE_ASIDE,
    },
    {
      name: "a version this binary does not know and that is not newer",
      make: () => fs.writeFileSync(PINS, JSON.stringify({ version: "1", pins: {} })),
      damage: "damaged",
      remedy: MOVE_ASIDE,
    },
    {
      name: "version: 2 (written by a newer CLI)",
      make: () => fs.writeFileSync(PINS, JSON.stringify({ version: 2, pins: {} })),
      damage: "newer_version",
      remedy: UPGRADE,
    },
  ];

  const snapshot = (): string =>
    fs.statSync(PINS).isDirectory()
      ? `dir:${fs.readdirSync(PINS).join(",")}`
      : fs.readFileSync(PINS, "utf-8");

  for (const c of cases) {
    it(`${c.name}: no key, reason damaged, no request, the remedy, bytes unchanged; the pre-flight fails with it`, async () => {
      const relay = await startFakeRelay();
      setLegacyKey(relay.identity.hex); // an intact record would bind
      c.make();
      const before = snapshot();

      const res = await resolveRelayKey(relay.base, FAST);
      expect(res).toMatchObject({
        status: "no_key",
        reason: "damaged",
        file: PINS,
        damage: c.damage,
      });
      expect(relay.requests).toEqual([]);
      expect(snapshot()).toBe(before);
      const line = relayKeyStartupLine(res, WHERE)!;
      expect(line).toContain(PINS);
      expect(line).toContain(c.remedy);
      expect(line).not.toContain(c.remedy === UPGRADE ? MOVE_ASIDE : UPGRADE);

      const { pf, pin } = await preflightPin(res);
      expect(pf.armed).toBe(false);
      expect(pin.ok).toBe(false);
      expect(pin.remedy).toContain(c.remedy);
      expect(renderPreflight(pf, (s) => s).join("\n")).toContain(PINS);
    });
  }

  it("an absent file is an empty record, not damage", () => {
    expect(readRelayPins()).toEqual({ status: "ok", pins: {} });
  });
});
