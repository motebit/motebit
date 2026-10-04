/**
 * #885 over the real SQLite ledger: `motebit delegate --sovereign` pays, and
 * the relay never admits the task (every submission of that same payment
 * gets a 503). The payment must be on record in the database, and the NEXT
 * `motebit delegate` run — a new process, a new ledger session — must
 * refuse to pay again for the same worker and capability.
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
const RELAY = "https://relay.test";

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

const proof: P2pPaymentProof = {
  tx_hash: "NotAdmittedTx885",
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

async function runDelegate(): Promise<unknown> {
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
  return outcome;
}

describe("motebit delegate --sovereign: paid, not admitted (#885)", () => {
  const original = globalThis.fetch;
  let dir: string;
  let errors: string[];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "motebit-885-"));
    state.dbPath = join(dir, "motebit.db");
    state.submits = [];
    errors = [];
    buildP2pPayment.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(" "));
    });
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
      if (method === "POST" && path === `/agent/${ME}/task`) {
        const body = JSON.parse(init!.body as string) as { payment_proof: P2pPaymentProof };
        state.submits.push(body.payment_proof.tx_hash);
        return json(503, { error: "Service Unavailable" });
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

  it("one broadcast; the payment is on record; the next run refuses to pay again", async () => {
    const first = await runDelegate();
    expect(String(first)).toContain("exit 1");
    expect(buildP2pPayment).toHaveBeenCalledTimes(1);
    // Every submission carried the SAME payment.
    expect(state.submits.length).toBeGreaterThan(1);
    expect(new Set(state.submits)).toEqual(new Set([proof.tx_hash]));
    expect(errors.join("\n")).toMatch(/has not confirmed admitting the task/);
    expect(errors.join("\n")).toMatch(/Do not run this again/);

    const db = createMotebitDatabase(state.dbPath);
    const owed = db.paidIntentStore.listOutstanding(ME);
    db.close();
    expect(owed.map((e) => [e.task_id, e.tx_hash, e.worker_motebit_id, e.state])).toEqual([
      [`p2p-payment:${proof.tx_hash}`, proof.tx_hash, WORKER, "unretrieved"],
    ]);

    // A new process: a new ledger session on the same database.
    const submitsBefore = state.submits.length;
    const second = await runDelegate();
    expect(String(second)).toContain("exit 1");
    expect(buildP2pPayment).toHaveBeenCalledTimes(1);
    expect(state.submits.length).toBe(submitsBefore);
    expect(errors.join("\n")).toMatch(/intent_already_paid/);
  });
});
