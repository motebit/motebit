/**
 * `motebit verify-release` keeps comparing a witness's signer against the
 * LEGACY relay key (`relay_public_key` in config.json), exactly as before the
 * per-relay record existed (design test 14). It derives no payment
 * destination, and it does not read `relay-pins.json`.
 *
 * A well-formed witness signed by another key must fail with PIN MISMATCH —
 * with no per-relay record, and also with a record whose entry for that relay
 * IS the witness's own key (which would let it pass if the record were read).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: no test reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "motebit-verify-rel-"));
});

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { handleVerifyRelease } from "../subcommands/verify-release.js";
import {
  closeFakeRelays,
  newRelayIdentity,
  sendJson,
  signDeclaration,
  startFakeRelay,
} from "./helpers/fake-relay.js";

const DIR = process.env["MOTEBIT_CONFIG_DIR"]!;
const CONFIG = path.join(DIR, "config.json");
const PINS = path.join(DIR, "relay-pins.json");
const LEGACY_KEY = "0f".repeat(32);
const BUNDLE = fileURLToPath(import.meta.url); // any readable file: "our own bytes"

let errors: string[] = [];

beforeEach(() => {
  errors = [];
  fs.rmSync(PINS, { force: true });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
  vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
    throw new Error(`process.exit(${String(code)})`);
  });
});

afterEach(async () => {
  await closeFakeRelays();
  vi.restoreAllMocks();
});

/** A relay serving a well-formed release witness signed by `witnessSigner`. */
async function relayWithWitness() {
  const witnessSigner = await newRelayIdentity();
  const relay = await startFakeRelay();
  relay.route("/.well-known/motebit-releases.json", async (_req, res) => {
    sendJson(
      res,
      200,
      await signDeclaration(witnessSigner, { content: { package: "motebit", releases: [] } }),
    );
  });
  fs.writeFileSync(CONFIG, JSON.stringify({ sync_url: relay.base, relay_public_key: LEGACY_KEY }), {
    mode: 0o600,
  });
  return { relay, witnessSigner };
}

const mismatch = (signerHex: string): string =>
  `✗ PIN MISMATCH: witness signed by ${signerHex.slice(0, 12)}… but your ` +
  `config pins ${LEGACY_KEY.slice(0, 12)}…. Do not trust this witness.`;

describe("test 14 — verify-release compares against the legacy key, as before", () => {
  it("a well-formed witness signed by another key fails with PIN MISMATCH (no per-relay record)", async () => {
    const { witnessSigner } = await relayWithWitness();
    await expect(handleVerifyRelease({ bundlePath: BUNDLE })).rejects.toThrow("process.exit(1)");
    expect(errors).toEqual([mismatch(witnessSigner.hex)]);
    expect(fs.existsSync(PINS)).toBe(false);
  });

  it("…and still fails when the per-relay record's entry for that relay is the witness's own key", async () => {
    const { relay, witnessSigner } = await relayWithWitness();
    const bytes = `${JSON.stringify({
      version: 1,
      pins: {
        [relay.base]: { public_key: witnessSigner.hex, relay_id: "relay-under-test", pinned_at: 1 },
      },
    })}\n`;
    fs.writeFileSync(PINS, bytes, { mode: 0o600 });

    await expect(handleVerifyRelease({ bundlePath: BUNDLE })).rejects.toThrow("process.exit(1)");
    expect(errors).toEqual([mismatch(witnessSigner.hex)]);
    expect(fs.readFileSync(PINS, "utf-8")).toBe(bytes);
  });
});
