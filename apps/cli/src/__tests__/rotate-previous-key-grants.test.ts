/**
 * `motebit rotate` prints ONE line after a successful rotation when live
 * stored grants were signed by a key other than the new one (a grant spends
 * only under this motebit's current key), and nothing when there are none.
 * The rotation algorithm is stubbed; this pins the terminal's wiring.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { generateKeypair, bytesToHex } from "@motebit/encryption";

const rotated = vi.hoisted(() => ({ newPublicKeyHex: "" }));

vi.mock("../rotation.js", () => ({
  RotationUnlockError: class extends Error {},
  performRotation: vi.fn(async () => ({
    kind: "rotated",
    motebitId: "did:motebit:founder",
    newPublicKeyHex: rotated.newPublicKeyHex,
    relay: "recorded",
    rotations: 1,
    relayKeyBefore: null,
    retiredKeyKeptAt: null,
    notes: [],
  })),
}));
vi.mock("../machine-roster-rotation.js", () => ({
  rosterCaptureBeforeRotate: vi.fn(async () => undefined),
  rosterHookAfterRotate: vi.fn(async () => null),
}));
vi.mock("../subcommands/_helpers.js", () => ({ getRelayUrl: () => "http://relay.test" }));

const DAY = 86_400_000;
const ID = "did:motebit:founder";
let dir: string;
let oldKeyHex: string;

async function writeGrant(kp: { publicKey: Uint8Array; privateKey: Uint8Array }): Promise<void> {
  const { mintGrantWithSchedule } = await import("../subcommands/grant.js");
  const { grant, ticks } = await mintGrantWithSchedule({
    motebitId: ID,
    publicKeyHex: bytesToHex(kp.publicKey),
    privateKey: kp.privateKey,
    scope: "pay_invoice",
    subject: "billing:vendor=acme",
    ceiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 1_000_000 },
    cadenceMs: DAY,
    days: 7,
    now: Date.now(),
  });
  fs.writeFileSync(
    path.join(dir, "grants", `${grant.grant_id}.json`),
    JSON.stringify({ grant, ticks }),
  );
}

async function runRotate(): Promise<string[]> {
  const { handleRotate } = await import("../subcommands/rotate.js");
  const out: string[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  });
  try {
    await handleRotate({} as Parameters<typeof handleRotate>[0]);
  } finally {
    log.mockRestore();
  }
  return out;
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "motebit-rotate-grants-"));
  fs.mkdirSync(path.join(dir, "grants"), { recursive: true });
  fs.writeFileSync(path.join(dir, "identity.md"), "stub");
  fs.writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ motebit_id: ID, cli_encrypted_key: { stub: true } }),
  );
  vi.stubEnv("MOTEBIT_CONFIG_DIR", dir);
  vi.stubEnv("MOTEBIT_PASSPHRASE", "test-passphrase");
  const oldKp = await generateKeypair();
  oldKeyHex = bytesToHex(oldKp.publicKey);
});

afterEach(() => {
  for (const f of fs.readdirSync(path.join(dir, "grants"))) fs.rmSync(path.join(dir, "grants", f));
});

afterAll(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("motebit rotate — previous-key grants line", () => {
  it("prints exactly one line when a live grant was signed by the previous key", async () => {
    const oldKp = await generateKeypair();
    oldKeyHex = bytesToHex(oldKp.publicKey);
    await writeGrant(oldKp);
    const newKp = await generateKeypair();
    rotated.newPublicKeyHex = bytesToHex(newKp.publicKey);
    expect(rotated.newPublicKeyHex).not.toBe(oldKeyHex);

    const out = await runRotate();
    expect(out.some((l) => l.includes("Key rotation complete."))).toBe(true);
    const grantLines = out.filter((l) => l.includes("signed by a previous key"));
    expect(grantLines).toEqual([
      "  Grants: 1 standing grant was signed by a previous key and no longer authorizes spending — re-issue with `motebit grant create`",
    ]);
  });

  it("prints nothing about grants when every stored grant is under the new key", async () => {
    const newKp = await generateKeypair();
    await writeGrant(newKp);
    rotated.newPublicKeyHex = bytesToHex(newKp.publicKey);

    const out = await runRotate();
    expect(out.some((l) => l.includes("Key rotation complete."))).toBe(true);
    expect(out.some((l) => l.includes("Grants:"))).toBe(false);
  });
});
