/**
 * `motebit delegate --sovereign` pays from the sovereign wallet. Before
 * #874 it was the one paid path with no paid-intent interlock at all; it
 * now passes the DURABLE ledger. This drives the real `handleDelegate` over
 * a real SQLite file with the wallet and relay stubbed: the payment settles,
 * the result never arrives, and the payment must be on record in the
 * database the next `motebit` session reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMotebitDatabase } from "@motebit/persistence";
import type { P2pPaymentProof } from "@motebit/sdk";
import type { CliConfig } from "../args.js";
import { isRelayMetadataUrl, relayMetadataResponse } from "./helpers/signed-relay-metadata.js";

const ME = "019df0f4-084e-7910-90a8-3492ced8fb8f";
const WORKER = "worker-researcher";
const TASK = "ed665235-0341-4086-bd77-72c0d9396fe6";
const RELAY = "https://relay.test";

const state = vi.hoisted(() => ({ dbPath: "" }));

vi.mock("../config.js", async (orig) => ({
  ...(await orig<typeof import("../config.js")>()),
  loadFullConfig: () => ({
    motebit_id: ME,
    relay_public_key:
      "ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c" /* SIGNING_PINNED_HEX (helpers/signed-relay-metadata) */,
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
  getRelayUrl: () => RELAY,
  getRelayAuthHeaders: async () => ({ Authorization: "Bearer t" }),
}));

const proof: P2pPaymentProof = {
  tx_hash: "XaMuKuMCtx",
  chain: "solana",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  to_address: "WorkerAddr11111111111111111111111111111111",
  amount_micro: 250_000,
  fee_to_address: "Treasury1111111111111111111111111111111111",
  fee_amount_micro: 13_158,
};
const buildP2pPayment = vi.fn(async () => proof);
vi.mock("@motebit/wallet-solana", () => ({
  createSolanaWalletRail: () => ({ buildP2pPayment }),
}));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("motebit delegate --sovereign records into the durable ledger (#874)", () => {
  const original = globalThis.fetch;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "motebit-874-sov-"));
    state.dbPath = join(dir, "motebit.db");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (isRelayMetadataUrl(url)) return relayMetadataResponse();
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname;
      if (path === "/api/v1/agents/discover") {
        return json(200, {
          agents: [
            {
              motebit_id: WORKER,
              settlement_address: proof.to_address,
              settlement_modes: "relay,p2p",
              pricing: [{ capability: "web_search", unit_cost: 0.25 }],
            },
          ],
        });
      }
      if (path.endsWith("/p2p-eligibility")) return json(200, { allowed: true });
      if (path.endsWith("/listing")) {
        return json(200, { pricing: [{ capability: "web_search", unit_cost: 0.25 }] });
      }
      if (method === "POST" && path === `/agent/${ME}/task`) return json(201, { task_id: TASK });
      // The result never arrives.
      if (method === "GET" && path === `/agent/${ME}/task/${TASK}`) {
        return json(404, { error: "Task not found", code: "TASK_NOT_FOUND" });
      }
      return new Response("not stubbed", { status: 500 });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = original;
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("a settled payment whose result never arrived is on record for the next session", async () => {
    const { handleDelegate } = await import("../subcommands/delegate.js");
    const config = {
      positionals: ["delegate", "research", "X"],
      sovereign: true,
      capability: "web_search",
      payNewAgents: true,
    } as unknown as CliConfig;

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const run = handleDelegate(config)
      .catch((err: unknown) => err)
      .finally(() => {
        settled = true;
      });
    // Dynamic imports and the SQLite open resolve on real time; keep
    // advancing the poll clock until the command finishes.
    const deadline = Date.now() + 20_000;
    while (!settled && Date.now() < deadline) {
      await vi.advanceTimersByTimeAsync(2_000);
      await new Promise<void>((r) => setImmediate(r));
    }
    const outcome = await run;
    vi.useRealTimers();
    expect(String(outcome)).toContain("exit 1"); // the delegation failed: no result
    expect(buildP2pPayment).toHaveBeenCalledTimes(1);

    const db = createMotebitDatabase(state.dbPath);
    const owed = db.paidIntentStore.listOutstanding(ME);
    db.close();
    expect(owed.map((e) => [e.task_id, e.tx_hash, e.worker_motebit_id])).toEqual([
      [TASK, "XaMuKuMCtx", WORKER],
    ]);
  });
});
