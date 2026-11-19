/**
 * The operator token module: the record (design test 1) and
 * `operatorTokenFor` (design test 3).
 *
 * Tamper: scripts/tampers/cli-operator-token-per-relay.ts
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { CONFIG_DIR } = await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: nothing here reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  const dir = fs.mkdtempSync(p.join(os.tmpdir(), "mb-ot-unit-"));
  process.env["MOTEBIT_CONFIG_DIR"] = dir;
  for (const k of ["MOTEBIT_SYNC_URL", "MOTEBIT_API_TOKEN", "MOTEBIT_SYNC_TOKEN"])
    delete process.env[k];
  return { CONFIG_DIR: dir };
});

import {
  ALL_OPERATOR_TOKEN_SOURCES,
  bearerHeaders,
  bindOperatorToken,
  NO_FLAG_CONFIG,
  operatorTokenFor,
  operatorTokenIsSet,
  relayOperatorTokensPath,
  resetOperatorTokenMemoryForTests,
  treasuryProbeSkippedDetail,
} from "../relay-operator-token.js";

const FILE = path.join(CONFIG_DIR, "relay-operator-tokens.json");
const A = "https://relay-a.test";
const B = "https://relay-b.test";
const TOKEN = "operator-token-0123456789abcdef";
const sha = (t: string): string => createHash("sha256").update(t, "utf-8").digest("hex");
const flag = (t: string | undefined) => ({ syncToken: t });

let stderr: string[];

beforeEach(() => {
  fs.rmSync(FILE, { force: true });
  resetOperatorTokenMemoryForTests();
  delete process.env["MOTEBIT_API_TOKEN"];
  delete process.env["MOTEBIT_SYNC_TOKEN"];
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function writeRecord(doc: unknown): void {
  fs.writeFileSync(FILE, typeof doc === "string" ? doc : JSON.stringify(doc), { mode: 0o600 });
}

const bound = (url: string, token = TOKEN): void =>
  writeRecord({ version: 1, tokens: { [url]: sha(token) } });

describe("the operator token record", () => {
  it("is relay-operator-tokens.json in the config directory", () => {
    expect(relayOperatorTokensPath()).toBe(FILE);
  });

  it("a missing file is no entries: the token is withheld, and nothing is said about the file", () => {
    expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
    expect(stderr.join("")).not.toContain("is unusable");
    expect(fs.existsSync(FILE)).toBe(false);
  });

  it("a file that does not parse is no entries, with one line naming the file, and never an exit", () => {
    writeRecord("{ not json");
    const exit = vi.spyOn(process, "exit");
    expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
    expect(operatorTokenFor(B, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
    const lines = stderr.filter((l) => l.includes("is unusable"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(FILE);
    expect(exit).not.toHaveBeenCalled();
  });

  it("another version is no entries, even when it holds a matching entry", () => {
    writeRecord({ version: 2, tokens: { [A]: sha(TOKEN) } });
    expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
    expect(stderr.join("")).toContain("is unusable");
  });

  it("a missing version is no entries", () => {
    writeRecord({ tokens: { [A]: sha(TOKEN) } });
    expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
  });

  it("a non-string value is no entries for the whole file, the good entry included", () => {
    writeRecord({ version: 1, tokens: { [A]: sha(TOKEN), [B]: 7 } });
    expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
    expect(stderr.join("")).toContain("is unusable");
  });

  it("`tokens` that is not an object is no entries", () => {
    writeRecord({ version: 1, tokens: [sha(TOKEN)] });
    expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
  });

  it("a `__proto__` key is not usable as an entry for any relay", () => {
    // As a string value: one more key, which no relay URL normalizes to.
    writeRecord(`{"version":1,"tokens":{"__proto__":"${sha(TOKEN)}"}}`);
    expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
    expect(operatorTokenFor("__proto__", ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
    // As an object (a prototype carrying an entry for A): the file is refused.
    resetOperatorTokenMemoryForTests();
    writeRecord(`{"version":1,"tokens":{"__proto__":{"${A}":"${sha(TOKEN)}"}}}`);
    expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
  });

  it("is written owner-only (0600), holding the hash and never the token", () => {
    const r = bindOperatorToken(A, flag(TOKEN));
    expect(r.ok).toBe(true);
    expect(fs.statSync(FILE).mode & 0o777).toBe(0o600);
    const raw = fs.readFileSync(FILE, "utf-8");
    expect(raw).not.toContain(TOKEN);
    expect(JSON.parse(raw)).toEqual({ version: 1, tokens: { [A]: sha(TOKEN) } });
  });

  it("is replaced atomically: a second bind keeps the first entry and leaves no temp file", () => {
    expect(bindOperatorToken(A, flag(TOKEN)).ok).toBe(true);
    const inodeBefore = fs.statSync(FILE).ino;
    expect(bindOperatorToken(B, flag("another-token")).ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(FILE, "utf-8"))).toEqual({
      version: 1,
      tokens: { [A]: sha(TOKEN), [B]: sha("another-token") },
    });
    // Written beside and renamed over, never edited in place.
    expect(fs.statSync(FILE).ino).not.toBe(inodeBefore);
    expect(fs.readdirSync(CONFIG_DIR).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(fs.statSync(FILE).mode & 0o777).toBe(0o600);
  });
});

describe("operatorTokenFor", () => {
  it("returns the token for the relay it is bound to, with the URL it was asked about", () => {
    bound(A);
    const got = operatorTokenFor(`${A}/`, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN));
    expect(got?.token).toBe(TOKEN);
    expect(got?.relayUrl).toBe(`${A}/`);
    expect(bearerHeaders(got!)).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(stderr.join("")).toBe("");
  });

  it("returns nothing for a relay with no entry", () => {
    expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
  });

  it("returns nothing for ANOTHER relay's URL", () => {
    bound(A);
    expect(operatorTokenFor(B, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
  });

  it("returns nothing when the token changed after binding", () => {
    bound(A, "the-old-token");
    expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
  });

  describe("which spellings of a URL share an entry (relayPinKey)", () => {
    const same = [
      ["a trailing slash", `${A}/`],
      ["several trailing slashes", `${A}///`],
      ["host in another case", "https://RELAY-A.test"],
      ["scheme in another case", "HTTPS://relay-a.test"],
      ["the default port spelled out", "https://relay-a.test:443"],
    ] as const;
    for (const [what, url] of same) {
      it(`${what}: the same relay`, () => {
        bound(A);
        expect(operatorTokenFor(url, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))?.token).toBe(TOKEN);
      });
    }

    const different = [
      ["a path", `${A}/v1`],
      ["another port", "https://relay-a.test:8443"],
      ["http instead of https", "http://relay-a.test"],
      ["a subdomain", "https://x.relay-a.test"],
    ] as const;
    for (const [what, url] of different) {
      it(`${what}: a different relay`, () => {
        bound(A);
        expect(operatorTokenFor(url, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
      });
    }

    it("a path is kept: a token bound to a path is not sent to the bare host", () => {
      bound(`${A}/relay-one`);
      expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
      expect(
        operatorTokenFor(`${A}/relay-one/`, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))?.token,
      ).toBe(TOKEN);
    });

    it("`localhost` and `127.0.0.1` are different entries", () => {
      bound("http://localhost:3000");
      expect(
        operatorTokenFor("http://127.0.0.1:3000", ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN)),
      ).toBeUndefined();
    });

    const refused = [
      ["userinfo", "https://user@relay-a.test"],
      ["a query", `${A}?x=1`],
      ["a fragment", `${A}#x`],
      ["a space", "https://relay-a.test /"],
      ["a backslash", "https:\\\\relay-a.test"],
      ["another scheme", "ftp://relay-a.test"],
      ["not a URL", "relay-a.test"],
    ] as const;
    for (const [what, url] of refused) {
      it(`a URL with ${what} gets no token, whatever the record holds`, () => {
        writeRecord({ version: 1, tokens: { [url]: sha(TOKEN), [A]: sha(TOKEN) } });
        expect(operatorTokenFor(url, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toBeUndefined();
        expect(stderr.join("")).toContain("cannot have a token bound to it");
      });
    }
  });

  describe("sources", () => {
    it("the flag wins over both variables, and the api variable over the sync one", () => {
      process.env["MOTEBIT_API_TOKEN"] = "from-api";
      process.env["MOTEBIT_SYNC_TOKEN"] = "from-sync";
      writeRecord({
        version: 1,
        tokens: { [A]: sha("from-flag"), [B]: sha("from-api"), "https://c.test": sha("from-sync") },
      });
      expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag("from-flag"))?.token).toBe(
        "from-flag",
      );
      expect(operatorTokenFor(B, ALL_OPERATOR_TOKEN_SOURCES, flag(undefined))?.token).toBe(
        "from-api",
      );
      delete process.env["MOTEBIT_API_TOKEN"];
      expect(
        operatorTokenFor("https://c.test", ALL_OPERATOR_TOKEN_SOURCES, flag(undefined))?.token,
      ).toBe("from-sync");
    });

    it("a site reads only the sources it names: [flag, sync] never reads the api variable", () => {
      process.env["MOTEBIT_API_TOKEN"] = TOKEN;
      bound(A);
      expect(operatorTokenFor(A, ["flag", "sync"], flag(undefined))).toBeUndefined();
      expect(stderr.join("")).toBe("");
      process.env["MOTEBIT_SYNC_TOKEN"] = TOKEN;
      expect(operatorTokenFor(A, ["flag", "sync"], flag(undefined))?.token).toBe(TOKEN);
    });

    it("[flag, api] never reads the sync variable", () => {
      process.env["MOTEBIT_SYNC_TOKEN"] = TOKEN;
      bound(A);
      expect(operatorTokenFor(A, ["flag", "api"], flag(undefined))).toBeUndefined();
      process.env["MOTEBIT_API_TOKEN"] = TOKEN;
      expect(operatorTokenFor(A, ["flag", "api"], flag(undefined))?.token).toBe(TOKEN);
    });

    it("[api, sync] never reads the flag", () => {
      bound(A);
      expect(operatorTokenFor(A, ["api", "sync"], flag(TOKEN))).toBeUndefined();
      process.env["MOTEBIT_SYNC_TOKEN"] = TOKEN;
      expect(operatorTokenFor(A, ["api", "sync"], NO_FLAG_CONFIG)?.token).toBe(TOKEN);
    });

    it("the order given is the precedence: [sync, api] takes the sync variable first", () => {
      process.env["MOTEBIT_API_TOKEN"] = "from-api";
      process.env["MOTEBIT_SYNC_TOKEN"] = TOKEN;
      bound(A);
      expect(operatorTokenFor(A, ["sync", "api"], flag(undefined))?.token).toBe(TOKEN);
    });

    it("an empty flag hides the variables and then counts as unset — nothing sent, nothing said", () => {
      process.env["MOTEBIT_API_TOKEN"] = TOKEN;
      bound(A);
      expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(""))).toBeUndefined();
      expect(stderr.join("")).toBe("");
    });

    it("an empty api variable hides the sync variable the same way", () => {
      process.env["MOTEBIT_API_TOKEN"] = "";
      process.env["MOTEBIT_SYNC_TOKEN"] = TOKEN;
      bound(A);
      expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(undefined))).toBeUndefined();
      expect(stderr.join("")).toBe("");
    });

    it("no source set: nothing sent, nothing said", () => {
      bound(A);
      expect(operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(undefined))).toBeUndefined();
      expect(stderr.join("")).toBe("");
    });
  });

  describe("the withheld line", () => {
    it("names the source, the URL and the bind command, and never the token", () => {
      process.env["MOTEBIT_SYNC_TOKEN"] = TOKEN;
      expect(operatorTokenFor(B, ALL_OPERATOR_TOKEN_SOURCES, flag(undefined))).toBeUndefined();
      const text = stderr.join("");
      expect(text).toContain("MOTEBIT_SYNC_TOKEN");
      expect(text).toContain(`was not sent to ${B}`);
      expect(text).toContain(`motebit relay bind-token --sync-url ${B}`);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(sha(TOKEN));
    });

    it("names the flag when the flag supplied the token", () => {
      operatorTokenFor(B, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN));
      expect(stderr.join("")).toContain("--sync-token");
    });

    it("is printed once per process and relay, however the URL is spelled", () => {
      for (let i = 0; i < 3; i++) operatorTokenFor(B, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN));
      operatorTokenFor(`${B}/`, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN));
      expect(stderr.filter((l) => l.includes("was not sent to"))).toHaveLength(1);
    });

    it("is printed again for another relay", () => {
      operatorTokenFor(B, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN));
      operatorTokenFor("https://relay-c.test", ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN));
      expect(stderr.filter((l) => l.includes("was not sent to"))).toHaveLength(2);
    });

    it("prints the URL without its control characters", () => {
      operatorTokenFor(
        "https://relay-b.test/\u001b[31mred",
        ALL_OPERATOR_TOKEN_SOURCES,
        flag(TOKEN),
      );
      const text = stderr.join("");
      expect(text).toContain("was not sent to");
      expect(text).not.toContain("\u001b");
    });

    it("is not printed when the token is sent", () => {
      bound(A);
      operatorTokenFor(A, ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN));
      expect(stderr.join("")).toBe("");
    });
  });
});

describe("operatorTokenIsSet (what /connect refuses on)", () => {
  it("is set whether or not the token is bound, and names the source", () => {
    expect(operatorTokenIsSet(ALL_OPERATOR_TOKEN_SOURCES, flag(TOKEN))).toEqual({
      source: "--sync-token",
    });
    process.env["MOTEBIT_API_TOKEN"] = TOKEN;
    expect(operatorTokenIsSet(ALL_OPERATOR_TOKEN_SOURCES, flag(undefined))).toEqual({
      source: "MOTEBIT_API_TOKEN",
    });
    delete process.env["MOTEBIT_API_TOKEN"];
    process.env["MOTEBIT_SYNC_TOKEN"] = TOKEN;
    expect(operatorTokenIsSet(ALL_OPERATOR_TOKEN_SOURCES, flag(undefined))).toEqual({
      source: "MOTEBIT_SYNC_TOKEN",
    });
    expect(stderr.join("")).toBe("");
  });

  it("is not set with no source, or with an empty first source", () => {
    expect(operatorTokenIsSet(ALL_OPERATOR_TOKEN_SOURCES, flag(undefined))).toBeUndefined();
    process.env["MOTEBIT_API_TOKEN"] = TOKEN;
    expect(operatorTokenIsSet(ALL_OPERATOR_TOKEN_SOURCES, flag(""))).toBeUndefined();
  });
});

describe("treasuryProbeSkippedDetail (motebit doctor)", () => {
  it("says the token is set but not bound, with the bind command, when that is why none was sent", () => {
    process.env["MOTEBIT_API_TOKEN"] = TOKEN;
    const detail = treasuryProbeSkippedDetail(B, ["api", "sync"], NO_FLAG_CONFIG, undefined);
    expect(detail).toContain("set but not bound to this relay");
    expect(detail).toContain(`motebit relay bind-token --sync-url ${B}`);
    expect(detail).not.toContain(TOKEN);
  });

  it("keeps the plain hint when no token is set, and when a bound token was refused", () => {
    expect(treasuryProbeSkippedDetail(B, ["api", "sync"], NO_FLAG_CONFIG, undefined)).toBe(
      "skipped — operator-only check (set MOTEBIT_API_TOKEN to enable)",
    );
    process.env["MOTEBIT_API_TOKEN"] = TOKEN;
    bound(B);
    const got = operatorTokenFor(B, ["api", "sync"], NO_FLAG_CONFIG);
    expect(treasuryProbeSkippedDetail(B, ["api", "sync"], NO_FLAG_CONFIG, got)).toBe(
      "skipped — operator-only check (set MOTEBIT_API_TOKEN to enable)",
    );
  });
});
