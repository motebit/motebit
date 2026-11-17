/**
 * `motebit delegate --sovereign` uses a relay key only for the relay that key
 * signs. With no key for ITS relay it exits 1 naming the relay and the
 * remedy, and nothing is broadcast — whatever `relay_public_key` holds.
 *
 * The real `handleDelegate` against a real fake relay on 127.0.0.1 that
 * offers a priced, P2P-payable worker (so a key WOULD lead to a payment: the
 * control case proves it), with a wallet that records every payment it is
 * asked to build. Numbered after the design's test plan (section 5).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  dbPath: "",
  relay: "",
  legacy: undefined as string | undefined,
}));

await vi.hoisted(async () => {
  // CONFIG_DIR is read at module load: no test reads the developer's ~/.motebit.
  const fs = await import("node:fs");
  const os = await import("node:os");
  const p = await import("node:path");
  process.env["MOTEBIT_CONFIG_DIR"] = fs.mkdtempSync(p.join(os.tmpdir(), "motebit-deleg-pins-"));
  delete process.env["MOTEBIT_SYNC_URL"];
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { P2pPaymentProof, SovereignP2pPaymentRequest } from "@motebit/sdk";
import type { CliConfig } from "../args.js";
import { resetRelayKeyMemoryForTests, type RelayPinEntry } from "../relay-pins.js";
import {
  DECLARATION_PATH,
  closeFakeRelays,
  sendJson,
  startFakeRelay,
  type FakeRelay,
} from "./helpers/fake-relay.js";

const ME = "019df0f4-084e-7910-90a8-3492ced8fb8f";
const WORKER = "worker-researcher";
const WORKER_ADDR = "WorkerAddr11111111111111111111111111111111";
const OTHER_KEY = "0f".repeat(32);
const DIR = process.env["MOTEBIT_CONFIG_DIR"]!;
const PINS = path.join(DIR, "relay-pins.json");
const LOCK = `${PINS}.lock`;
const FAST = { relayKey: { timeoutMs: 3_000, lockTimeoutMs: 80 } };

vi.mock("../config.js", async (orig) => ({
  ...(await orig<typeof import("../config.js")>()),
  loadFullConfig: () => ({
    motebit_id: ME,
    ...(state.legacy !== undefined ? { relay_public_key: state.legacy } : {}),
  }),
}));
vi.mock("../identity.js", async (orig) => ({
  ...(await orig<typeof import("../identity.js")>()),
  loadActiveSigningKey: async () => ({ privateKey: new Uint8Array(32).fill(1) }),
}));
vi.mock("../runtime-factory.js", () => ({ getDbPath: () => state.dbPath }));
vi.mock("../subcommands/_helpers.js", async (orig) => ({
  ...(await orig<typeof import("../subcommands/_helpers.js")>()),
  requireMotebitId: () => ME,
  getRelayUrl: () => state.relay,
  getRelayAuthHeaders: async () => ({ Authorization: "Bearer t" }),
}));

/** Every payment the wallet was asked to build (each one would be a broadcast). */
const buildP2pPayment = vi.fn(
  async (req: SovereignP2pPaymentRequest): Promise<P2pPaymentProof> => ({
    tx_hash: "TxThatMustNotExist",
    chain: "solana",
    network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
    to_address: req.workerAddress,
    amount_micro: req.amountMicro,
    fee_to_address: req.treasuryAddress,
    fee_amount_micro: req.feeAmountMicro,
  }),
);
vi.mock("@motebit/wallet-solana", () => ({
  createSolanaWalletRail: () => ({ buildP2pPayment }),
}));

const entryOf = (key: string): RelayPinEntry => ({
  public_key: key,
  relay_id: "relay-under-test",
  pinned_at: 1,
});

function writePins(pins: Record<string, RelayPinEntry>): string {
  const bytes = `${JSON.stringify({ version: 1, pins }, null, 2)}\n`;
  fs.writeFileSync(PINS, bytes, { mode: 0o600 });
  return bytes;
}

/** A fake relay offering a priced, P2P-payable worker. */
async function payableRelay(): Promise<FakeRelay> {
  const relay = await startFakeRelay();
  relay.route("/api/v1/agents/discover", (_req, res) => sendJson(res, 200, { agents: [worker()] }));
  relay.route(/\/p2p-eligibility/, (_req, res) =>
    sendJson(res, 200, { allowed: true, settlement_address: WORKER_ADDR }),
  );
  relay.route(`/api/v1/agents/${WORKER}/listing`, (_req, res) =>
    sendJson(res, 200, { pricing: [{ capability: "web_search", unit_cost: 0.25 }] }),
  );
  relay.route(`/agent/${ME}/task`, (_req, res) =>
    // Stop after the payment: these tests are about whether one is built.
    sendJson(res, 400, { error: "stop here", code: "TEST_STOP" }),
  );
  state.relay = relay.base;
  return relay;
}

const worker = () => ({
  motebit_id: WORKER,
  settlement_address: WORKER_ADDR,
  settlement_modes: "relay,p2p",
  pricing: [{ capability: "web_search", unit_cost: 0.25 }],
});

let errors: string[] = [];

async function delegateSovereign(): Promise<unknown> {
  const { handleDelegate } = await import("../subcommands/delegate.js");
  const config = {
    positionals: ["delegate", "research", "X"],
    sovereign: true,
    capability: "web_search",
    payNewAgents: true,
  } as unknown as CliConfig;
  return handleDelegate(config, FAST).catch((err: unknown) => err);
}

beforeEach(() => {
  errors = [];
  state.legacy = undefined;
  state.dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "motebit-deleg-pins-db-")),
    "m.db",
  );
  fs.rmSync(PINS, { recursive: true, force: true });
  fs.rmSync(LOCK, { force: true });
  buildP2pPayment.mockClear();
  resetRelayKeyMemoryForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`exit ${code}`);
  }) as never);
});

afterEach(async () => {
  await closeFakeRelays();
  vi.restoreAllMocks();
  fs.rmSync(LOCK, { force: true });
});

describe("delegate --sovereign and the per-relay key", () => {
  it("control: with this relay's entry recorded, the payment IS built (the fixture can pay)", async () => {
    const relay = await payableRelay();
    writePins({ [relay.base]: entryOf(relay.identity.hex) });

    await delegateSovereign();

    expect(errors.join("\n")).not.toContain("requires a pinned relay key");
    expect(buildP2pPayment).toHaveBeenCalledTimes(1);
  });

  it("test 13: no entry and no legacy key: exits 1 naming the relay and the remedy; nothing is broadcast, the relay is not asked", async () => {
    const relay = await payableRelay();

    const outcome = await delegateSovereign();

    expect(String(outcome)).toContain("exit 1");
    expect(errors).toEqual([
      `Sovereign delegation requires a pinned relay key for ${relay.base} (the fee leg's treasury derives from it).`,
      `No relay key is pinned. Run \`motebit register --sync-url ${relay.base}\`.`,
    ]);
    expect(buildP2pPayment).not.toHaveBeenCalled();
    expect(relay.requests).toEqual([]);
  });

  it("the defect: the install holds ANOTHER relay's key: exits 1, that key is never used here, nothing is broadcast", async () => {
    const relay = await payableRelay();
    state.legacy = OTHER_KEY; // pinned by `register` against a different relay

    const outcome = await delegateSovereign();

    expect(String(outcome)).toContain("exit 1");
    expect(errors[0]).toContain(`requires a pinned relay key for ${relay.base}`);
    expect(errors[1]).toContain(
      "This install's relay key was pinned for another relay or this relay's key changed.",
    );
    expect(buildP2pPayment).not.toHaveBeenCalled();
    expect(fs.existsSync(PINS)).toBe(false);
  });

  it("test 6c: the record's lock is held by another live process: the exit-1 line gives that cause; nothing is broadcast", async () => {
    const relay = await payableRelay();
    state.legacy = relay.identity.hex;
    fs.writeFileSync(LOCK, `${process.ppid} foreign-lock-token`, { mode: 0o600 });

    const outcome = await delegateSovereign();

    expect(String(outcome)).toContain("exit 1");
    expect(errors[1]).toContain(`The relay key record \`${PINS}\` could not be read or written`);
    expect(errors[1]).toContain("locked by another motebit process");
    expect(buildP2pPayment).not.toHaveBeenCalled();
    expect(fs.existsSync(PINS)).toBe(false);
  });

  it("test 6d: a different key is recorded for this relay while the check is in flight (conflict): exits 1 without broadcasting", async () => {
    const relay = await payableRelay();
    state.legacy = relay.identity.hex;
    let recorded = "";
    relay.before(DECLARATION_PATH, () => {
      recorded = writePins({ [relay.base]: entryOf(OTHER_KEY) });
    });

    const outcome = await delegateSovereign();

    expect(String(outcome)).toContain("exit 1");
    expect(errors[1]).toContain(
      `A different key is already recorded for this relay in \`${PINS}\` (entry \`${relay.base}\`)`,
    );
    expect(buildP2pPayment).not.toHaveBeenCalled();
    expect(fs.readFileSync(PINS, "utf-8")).toBe(recorded);
  });

  it("test 12: a damaged record: exits 1 with the remedy, makes no request, nothing is broadcast; bytes unchanged", async () => {
    const relay = await payableRelay();
    state.legacy = relay.identity.hex;
    fs.writeFileSync(PINS, "{ not json");

    const outcome = await delegateSovereign();

    expect(String(outcome)).toContain("exit 1");
    expect(errors[1]).toContain(PINS);
    expect(errors[1]).toContain("Move the file aside");
    expect(buildP2pPayment).not.toHaveBeenCalled();
    expect(relay.requests).toEqual([]);
    expect(fs.readFileSync(PINS, "utf-8")).toBe("{ not json");
  });
});
