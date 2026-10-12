/**
 * After `motebit rotate`, stored grants are untouched, but a grant spends
 * only while its delegator key is this motebit's CURRENT identity key
 * (`grantDelegatorIs`: immediate issuer, owner id AND current key). The CLI
 * says so: `grant list` marks each grant signed by a previous key, and
 * `rotate` prints one line when live ones exist. Calm output, no prompts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeypair, bytesToHex } from "@motebit/encryption";
import { verifyGrantForTurn } from "@motebit/runtime";
import {
  formatGrantListLines,
  mintGrantWithSchedule,
  previousKeyGrantNotice,
  PREVIOUS_KEY_MARK,
  signedByPreviousKey,
  type StoredGrant,
} from "../subcommands/grant.js";

const DAY = 86_400_000;
const M = 1_000_000;
const T0 = 1_760_000_000_000;
const ID = "did:motebit:founder";

let oldKeyHex: string;
let newKeyHex: string;
let oldGrant: StoredGrant;
let newGrant: StoredGrant;

async function mint(kp: { publicKey: Uint8Array; privateKey: Uint8Array }): Promise<StoredGrant> {
  const { grant, ticks } = await mintGrantWithSchedule({
    motebitId: ID,
    publicKeyHex: bytesToHex(kp.publicKey),
    privateKey: kp.privateKey,
    scope: "pay_invoice",
    subject: "billing:vendor=acme",
    ceiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 5 * M },
    cadenceMs: DAY,
    days: 7,
    now: T0,
  });
  return { grant, ticks };
}

beforeAll(async () => {
  const oldKp = await generateKeypair();
  const newKp = await generateKeypair();
  oldKeyHex = bytesToHex(oldKp.publicKey);
  newKeyHex = bytesToHex(newKp.publicKey);
  oldGrant = await mint(oldKp);
  newGrant = await mint(newKp);
});

describe("the narrowing the marks describe", () => {
  it("a self-grant signed under the previous key no longer verifies for the rotated runtime", async () => {
    const self = (keyHex: string) => ({ motebitId: ID, publicKeyHex: keyHex });
    // Under the key that signed it: verifies.
    expect(
      await verifyGrantForTurn(oldGrant.ticks[0]!, oldGrant.grant, [], {
        presenter: self(oldKeyHex),
        delegator: self(oldKeyHex),
        now: T0 + 1,
      }),
    ).not.toBeNull();
    // After rotation (same motebit_id, current key = new key): refused.
    expect(
      await verifyGrantForTurn(oldGrant.ticks[0]!, oldGrant.grant, [], {
        presenter: self(newKeyHex),
        delegator: self(newKeyHex),
        now: T0 + 1,
      }),
    ).toBeNull();
    // A grant re-issued under the current key verifies.
    expect(
      await verifyGrantForTurn(newGrant.ticks[0]!, newGrant.grant, [], {
        presenter: self(newKeyHex),
        delegator: self(newKeyHex),
        now: T0 + 1,
      }),
    ).not.toBeNull();
  });
});

describe("signedByPreviousKey", () => {
  it("compares against the current key, case-insensitively; unknown current key marks nothing", () => {
    expect(signedByPreviousKey(oldGrant.grant, newKeyHex)).toBe(true);
    expect(signedByPreviousKey(newGrant.grant, newKeyHex)).toBe(false);
    expect(signedByPreviousKey(newGrant.grant, newKeyHex.toUpperCase())).toBe(false);
    expect(signedByPreviousKey(oldGrant.grant, undefined)).toBe(false);
    expect(signedByPreviousKey(oldGrant.grant, "")).toBe(false);
  });
});

describe("grant list marks", () => {
  it("marks exactly the grants signed by a previous key, under their own line", () => {
    const lines = formatGrantListLines([oldGrant, newGrant], {
      now: T0 + 1,
      spent: new Map(),
      currentPublicKeyHex: newKeyHex,
    });
    expect(lines).toEqual([
      expect.stringContaining(oldGrant.grant.grant_id),
      `  ${PREVIOUS_KEY_MARK}`,
      expect.stringContaining(newGrant.grant.grant_id),
    ]);
    expect(PREVIOUS_KEY_MARK).toBe(
      "signed by a previous key — re-issue with `motebit grant create`",
    );
  });

  it("marks nothing when every grant is under the current key", () => {
    const lines = formatGrantListLines([newGrant], {
      now: T0 + 1,
      spent: new Map(),
      currentPublicKeyHex: newKeyHex,
    });
    expect(lines).toHaveLength(1);
  });
});

describe("rotate notice", () => {
  it("one line when live grants were signed by a previous key", () => {
    const line = previousKeyGrantNotice([oldGrant, newGrant], newKeyHex, T0 + 1);
    expect(line).toBe(
      "  Grants: 1 standing grant was signed by a previous key and no longer authorizes spending — re-issue with `motebit grant create`",
    );
    const two = previousKeyGrantNotice([oldGrant, oldGrant], newKeyHex, T0 + 1);
    expect(two).toContain(
      "2 standing grants were signed by a previous key and no longer authorize spending",
    );
  });

  it("silent when none: all current-key, revoked, or expired", () => {
    expect(previousKeyGrantNotice([newGrant], newKeyHex, T0 + 1)).toBeNull();
    expect(previousKeyGrantNotice([], newKeyHex, T0 + 1)).toBeNull();
    const revoked = { ...oldGrant, revocation: {} as NonNullable<StoredGrant["revocation"]> };
    expect(previousKeyGrantNotice([revoked], newKeyHex, T0 + 1)).toBeNull();
    expect(previousKeyGrantNotice([oldGrant], newKeyHex, T0 + 8 * DAY)).toBeNull();
  });
});

describe("handleGrantList (wired to the stored grants and the config's current key)", () => {
  let dir: string;
  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-grant-prevkey-"));
    fs.mkdirSync(path.join(dir, "grants"), { recursive: true });
    for (const s of [oldGrant, newGrant]) {
      fs.writeFileSync(path.join(dir, "grants", `${s.grant.grant_id}.json`), JSON.stringify(s));
    }
    fs.writeFileSync(
      path.join(dir, "config.json"),
      JSON.stringify({ motebit_id: ID, device_public_key: newKeyHex }),
    );
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("prints the mark under the previous-key grant only", async () => {
    vi.stubEnv("MOTEBIT_CONFIG_DIR", dir);
    vi.resetModules();
    const { handleGrantList } = await import("../subcommands/grant.js");
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      out.push(a.map(String).join(" "));
    });
    try {
      await handleGrantList();
    } finally {
      spy.mockRestore();
    }
    const at = out.findIndex((l) => l.startsWith(oldGrant.grant.grant_id));
    expect(at).toBeGreaterThanOrEqual(0);
    expect(out[at + 1]).toBe(`  ${PREVIOUS_KEY_MARK}`);
    expect(out.filter((l) => l.includes(PREVIOUS_KEY_MARK))).toHaveLength(1);
  });
});
