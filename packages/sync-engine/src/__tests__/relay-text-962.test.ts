/**
 * #962 round 6 (C2, C3) — relay-controlled text never enters an Error message
 * raw, and the sanitizer it goes through is complete.
 *
 * C2: the CLI's `/sync` printed `getLastError().message` raw and uncapped;
 * that text is the relay's (the socket's `sync push: <relay message>`, the
 * HTTP adapters' status text). Sanitizing at each print site is a guard a
 * new print site forgets, so the sanitizing moves to the boundary: every
 * error a sync-engine adapter builds from relay text carries it sanitized,
 * and `SyncEngine.getLastError()` only ever exposes a sanitized message.
 *
 * C3: the sanitizer split a surrogate pair at the cap (a lone \ud83d before
 * the ellipsis) and let bidi and invisible controls through (U+202E, U+202C,
 * U+2066, U+200B).
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { EventType } from "@motebit/sdk";
import type { EventLogEntry } from "@motebit/sdk";
import { InMemoryEventStore } from "@motebit/event-log";
import * as syncEngine from "../index.js";
import { HttpEventStoreAdapter, SyncEngine } from "../index.js";

const sanitize = (syncEngine as { sanitizeRelayText?: (t: string, max?: number) => string })
  .sanitizeRelayText;

/** OSC title set, BEL, clear screen — the reviewer's probe, padded to 544 characters. */
const HOSTILE = "\x1b]0;PWNED\x07\x1b[2J" + "X".repeat(530);

/** Every character the round-6 law strips, with its name. */
const STRIPPED: Array<[string, string]> = [
  ["U+0000 NUL", "\u0000"],
  ["U+0007 BEL", "\u0007"],
  ["U+001B ESC", "\u001b"],
  ["U+007F DEL", "\u007f"],
  ["U+0085 NEL (C1)", "\u0085"],
  ["U+009B CSI (C1)", "\u009b"],
  ["U+202A LRE", "\u202a"],
  ["U+202B RLE", "\u202b"],
  ["U+202C PDF", "\u202c"],
  ["U+202D LRO", "\u202d"],
  ["U+202E RLO", "\u202e"],
  ["U+2066 LRI", "\u2066"],
  ["U+2067 RLI", "\u2067"],
  ["U+2068 FSI", "\u2068"],
  ["U+2069 PDI", "\u2069"],
  ["U+200B ZWSP", "\u200b"],
  ["U+200C ZWNJ", "\u200c"],
  ["U+200D ZWJ", "\u200d"],
  ["U+200E LRM", "\u200e"],
  ["U+200F RLM", "\u200f"],
  ["U+FEFF BOM", "\ufeff"],
  ["U+2028 LINE SEPARATOR", "\u2028"],
  ["U+2029 PARAGRAPH SEPARATOR", "\u2029"],
];

/** Anything the law forbids in printed relay text. */
const FORBIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029\ufeff]/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

describe("#962 round 6 C3 — sanitizeRelayText", () => {
  it("is exported by @motebit/sync-engine (the one sanitizer every surface uses)", () => {
    expect(typeof sanitize).toBe("function");
  });

  for (const [name, ch] of STRIPPED) {
    it(`strips ${name}`, () => {
      // A newline after: an ESC (or a C1 CSI) takes the printable bytes after
      // it as its sequence ("ESC t" is one), never a control character.
      const out = sanitize!(`safe${ch}\ntext`);
      expect(FORBIDDEN.test(out), JSON.stringify(out)).toBe(false);
      expect(out.replace(/ /g, "")).toBe("safetext");
    });
  }

  it("a bidi override cannot reorder what is printed (U+202E … U+202C)", () => {
    const out = sanitize!("invoice \u202eexe.fdp\u202c done");
    expect(out).toBe("invoice exe.fdp done");
  });

  it("truncation never splits a surrogate pair", () => {
    for (let pad = 0; pad < 4; pad++) {
      const text = "a".repeat(199 - pad) + "\u{1f600}".repeat(20);
      const out = sanitize!(text, 200);
      expect(LONE_SURROGATE.test(out), JSON.stringify(out.slice(190, 210))).toBe(false);
    }
  });

  it("truncation never splits a grapheme cluster (a flag, a family emoji)", () => {
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
    const flag = "\u{1f1fa}\u{1f1f8}";
    const out = sanitize!("a".repeat(199) + flag + flag, 200);
    expect(out.startsWith("a".repeat(199) + flag)).toBe(true);
    expect(out).toContain("1 more");
    expect(LONE_SURROGATE.test(sanitize!("b".repeat(199) + family + family, 200))).toBe(false);
  });

  it("a lone surrogate in the input is not printed", () => {
    expect(LONE_SURROGATE.test(sanitize!("x\ud83dy"))).toBe(false);
  });

  it("the reviewer's probe: OSC + BEL + clear screen, 544 characters", () => {
    const out = sanitize!(HOSTILE);
    expect(FORBIDDEN.test(out)).toBe(false);
    expect(out).not.toContain("]0;");
    expect(out).not.toContain("[2J");
    expect([...new Intl.Segmenter().segment(out)].length).toBeLessThanOrEqual(240);
  });
});

const MID = "mote-962rt";
function event(clock: number): EventLogEntry {
  return {
    event_id: `e${clock}`,
    motebit_id: MID as EventLogEntry["motebit_id"],
    timestamp: clock,
    event_type: EventType.StateUpdated,
    payload: {},
    version_clock: clock,
    tombstoned: false,
  };
}

describe("#962 round 6 C2 — relay text is sanitized at the sync-engine boundary", () => {
  it("getLastError() never carries raw relay text, whatever the adapter threw", async () => {
    const local = new InMemoryEventStore();
    await local.append(event(1));
    const remote = new InMemoryEventStore();
    const relay = Object.assign(Object.create(remote) as InMemoryEventStore, {
      append: () => Promise.reject(new Error(`sync push: push refused ${HOSTILE}`)),
    });
    const engine = new SyncEngine(local, MID);
    engine.connectRemote(relay);
    await engine.sync();
    const msg = engine.getLastError()?.message ?? "";
    expect(msg).toContain("push refused");
    expect(FORBIDDEN.test(msg), JSON.stringify(msg.slice(0, 60))).toBe(false);
    expect(msg.length).toBeLessThanOrEqual(300);
  });

  it("the HTTP adapter's refusal: a hostile status text is sanitized in the Error it throws", async () => {
    const real = globalThis.fetch;
    // A relay's reason phrase may carry C1 bytes (obs-text, 0x80-0xff): the
    // adapter rebuilds responses, so only a ByteString survives to its Error.
    globalThis.fetch = (() => {
      const res = new Response("", { status: 400 });
      Object.defineProperty(res, "statusText", {
        value: "Bad\x9b2J gateway\x85\x9d",
      });
      return Promise.resolve(res);
    }) as typeof fetch;
    const adapter = new HttpEventStoreAdapter({
      baseUrl: "http://relay.test",
      motebitId: MID,
      maxRetries: 0,
    });
    const err = await adapter
      .append(event(1))
      .then(
        () => null,
        (e: unknown) => e as Error,
      )
      .finally(() => {
        globalThis.fetch = real;
      });
    expect(err).not.toBeNull();
    expect(err!.message).toContain("Push failed: 400");
    expect(FORBIDDEN.test(err!.message), JSON.stringify(err!.message)).toBe(false);
  });

  it("static: every Error a sync-engine source builds from relay text goes through sanitizeRelayText", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const offenders: string[] = [];
    let examined = 0;
    for (const f of readdirSync(src).filter((n) => n.endsWith(".ts"))) {
      const lines = readFileSync(join(src, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/new Error\(/.test(line)) return;
        if (
          !/statusText|msg\.message|\.text\(\)|\bbody\b|data\.error|json\.error|err\.error/.test(
            line,
          )
        )
          return;
        examined++;
        if (!/sanitizeRelayText\(/.test(line)) offenders.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    // Aperture: what the scan looked at.
    expect(examined, "relay-text Error constructions examined").toBeGreaterThan(10);
    expect(offenders, offenders.join("\n")).toEqual([]);
  });
});
