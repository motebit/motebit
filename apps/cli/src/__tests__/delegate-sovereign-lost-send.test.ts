/**
 * #885 composition over the CLI door: `motebit delegate --sovereign` hands
 * the rail's own-transaction confirmer to the payment path. The rail signs,
 * reports its signature, "sends", and then throws (a lost confirmation);
 * the confirmer says THAT transaction landed. The command must submit the
 * task with that transaction — one payment — and never report a failure.
 * Unwired, the same run ends `payment_status_unknown` and exits 1.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { P2pPaymentProof, SovereignP2pPaymentRequest } from "@motebit/sdk";
import type { CliConfig } from "../args.js";
import { isRelayMetadataUrl, relayMetadataResponse } from "./helpers/signed-relay-metadata.js";

const ME = "019df0f4-084e-7910-90a8-3492ced8fb8f";
const WORKER = "worker-researcher";
const RELAY = "https://relay.test";
const TASK = "0b6e1f7c-8a43-4a1b-9d6e-5f2a7c3e9b10";

const state = vi.hoisted(() => ({ dbPath: "", submits: [] as string[] }));

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

type Hooks = {
  beforeBroadcast?: (t: { signature: string; lastValidBlockHeight: number }) => unknown;
};
const buildP2pPayment = vi.fn(
  async (_r: SovereignP2pPaymentRequest, hooks?: Hooks): Promise<P2pPaymentProof> => {
    await hooks?.beforeBroadcast?.({ signature: "OwnLostSig885", lastValidBlockHeight: 9 });
    throw new Error("was not confirmed in 30.00 seconds");
  },
);
const confirmP2pPayment = vi.fn(
  async (q: { request: SovereignP2pPaymentRequest; transaction: { signature: string } }) => ({
    status: "landed" as const,
    proof: {
      tx_hash: q.transaction.signature,
      chain: "solana",
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      to_address: q.request.workerAddress,
      amount_micro: q.request.amountMicro,
      fee_to_address: q.request.treasuryAddress,
      fee_amount_micro: q.request.feeAmountMicro,
    },
  }),
);
vi.mock("@motebit/wallet-solana", () => ({
  createSolanaWalletRail: () => ({ buildP2pPayment, confirmP2pPayment }),
}));

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("motebit delegate --sovereign: a lost send whose own tx landed (#885)", () => {
  const original = globalThis.fetch;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "motebit-885-lost-"));
    state.dbPath = join(dir, "motebit.db");
    state.submits = [];
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
      const pricing = [{ capability: "web_search", unit_cost: 0.25 }];
      if (path === "/api/v1/agents/discover") {
        return json(200, {
          agents: [
            {
              motebit_id: WORKER,
              settlement_address: "WorkerAddr11111111111111111111111111111111",
              settlement_modes: "relay,p2p",
              pricing,
            },
          ],
        });
      }
      if (path.endsWith("/p2p-eligibility")) return json(200, { allowed: true });
      if (path.endsWith("/listing")) return json(200, { pricing });
      if (method === "POST" && path === `/agent/${ME}/task`) {
        const body = JSON.parse(init!.body as string) as { payment_proof: P2pPaymentProof };
        state.submits.push(body.payment_proof.tx_hash);
        return json(201, { task_id: TASK });
      }
      if (method === "GET" && path === `/agent/${ME}/task/${TASK}`) {
        return json(200, {
          task: { status: "completed" },
          receipt: {
            task_id: TASK,
            relay_task_id: TASK,
            motebit_id: WORKER,
            device_id: "d",
            submitted_at: 1,
            completed_at: 2,
            status: "completed",
            result: "the research",
            tools_used: [],
            memories_formed: 0,
            prompt_hash: "a".repeat(64),
            result_hash: "b".repeat(64),
            suite: "motebit-jcs-ed25519-b64-v1",
            signature: "s",
          },
        });
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

  it("submits with the hire's own landed transaction — one payment, no failure", async () => {
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
    const deadline = Date.now() + 20_000;
    while (!settled && Date.now() < deadline) {
      await vi.advanceTimersByTimeAsync(2_000);
      await new Promise<void>((r) => setImmediate(r));
    }
    const outcome = await run;
    vi.useRealTimers();
    expect(String(outcome)).not.toContain("exit 1");
    expect(buildP2pPayment).toHaveBeenCalledTimes(1);
    expect(confirmP2pPayment.mock.calls[0]?.[0].transaction.signature).toBe("OwnLostSig885");
    expect(state.submits).toEqual(["OwnLostSig885"]);
  });
});
