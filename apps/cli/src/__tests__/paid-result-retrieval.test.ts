/**
 * #874 end to end on the CLI's own storage: a paid delegation whose result
 * poll is LOST (the #871 fault hook, the #433 shape), a restart onto the
 * same SQLite file, and `/result` fetching the result the relay still
 * holds — one payment, one submission, the whole way through.
 *
 * Session 1 drives the REAL `selectAndRunDelegation` through
 * `faultingFetch(…, { kind: "lost" })`. Session 2 is a NEW `MotebitRuntime`
 * over a NEW connection to the same database file, built with the CLI's
 * own `buildStorageAdapters` — the wiring a restarted `motebit` uses.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MotebitRuntime,
  NullRenderer,
  PaidIntentLedger,
  paidResultsNotice,
  selectAndRunDelegation,
} from "@motebit/runtime";
import { createMotebitDatabase } from "@motebit/persistence";
import type { ExecutionReceipt, P2pPaymentProof } from "@motebit/sdk";
import type { CliConfig } from "../args.js";
import { faultingFetch } from "../fault-injection.js";
import { buildStorageAdapters } from "../runtime-factory.js";
import { handleSlashCommand } from "../index.js";
import {
  advanceAfterRealAsync,
  isRelayMetadataUrl,
  relayMetadataResponse,
  SIGNING_PINNED_HEX,
} from "./helpers/signed-relay-metadata.js";

const RELAY = "https://relay.test";
const ME = "019df0f4-084e-7910-90a8-3492ced8fb8f";
const WORKER = "worker-researcher";
const TASK = "ed665235-0341-4086-bd77-72c0d9396fe6";
const RELAY_KEY = SIGNING_PINNED_HEX;

const proof: P2pPaymentProof = {
  tx_hash: "XaMuKuMCtx",
  chain: "solana",
  network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  to_address: "WorkerAddr11111111111111111111111111111111",
  amount_micro: 250_000,
  fee_to_address: "Treasury1111111111111111111111111111111111",
  fee_amount_micro: 13_158,
};

const receipt: ExecutionReceipt = {
  task_id: TASK,
  motebit_id: WORKER,
  device_id: "worker-device",
  submitted_at: 1,
  completed_at: 2,
  status: "completed",
  result: "The paid research answer.",
  tools_used: ["web_search"],
  memories_formed: 0,
  prompt_hash: "a".repeat(64),
  result_hash: "b".repeat(64),
  suite: "motebit-jcs-ed25519-b64-v1",
  signature: "sig",
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A relay that holds the result the whole time — only the client's view of it is faulted. */
function stubRelay(): { fetch: typeof fetch; submits: () => number } {
  let submits = 0;
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
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
    if (path === `/api/v1/agents/${WORKER}/p2p-eligibility`) return json(200, { allowed: true });
    if (path === `/api/v1/agents/${WORKER}/listing`) {
      return json(200, { pricing: [{ capability: "web_search", unit_cost: 0.25 }] });
    }
    if (method === "POST" && path === `/agent/${ME}/task`) {
      submits++;
      return json(201, { task_id: TASK });
    }
    if (method === "GET" && path === `/agent/${ME}/task/${TASK}`) {
      return json(200, { task: { status: "completed" }, receipt });
    }
    return new Response("not stubbed", { status: 500 });
  }) as typeof fetch;
  return { fetch: f, submits: () => submits };
}

const config = { positionals: [] } as unknown as CliConfig;
const logged = (): string =>
  (console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls.flat().join("\n");

describe("paid result lost, restart, /result (#874 on the CLI's SQLite)", () => {
  const original = globalThis.fetch;
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "motebit-874-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = original;
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("delivers the paid result after a restart — submits = 1, one payment, re-hire refused", async () => {
    const dbPath = join(dir, "motebit.db");
    const relay = stubRelay();
    const buildP2pPayment = vi.fn(async () => proof);

    // ── Session 1: pay, then lose every result poll ──────────────────────
    const db1 = createMotebitDatabase(dbPath);
    globalThis.fetch = faultingFetch(relay.fetch, { kind: "lost" });
    vi.useFakeTimers();
    const pending = selectAndRunDelegation({
      motebitId: ME,
      syncUrl: RELAY,
      authToken: async () => "token",
      prompt: "research X",
      requiredCapabilities: ["web_search"],
      relayPublicKey: RELAY_KEY,
      buildP2pPayment,
      acknowledgeNoHistoryRisk: true,
      paidIntentLedger: new PaidIntentLedger(db1.paidIntentStore, ME),
      timeoutMs: 10_000,
      logger: { warn: () => {} },
    });
    await advanceAfterRealAsync(15_000);
    const first = await pending;
    vi.useRealTimers();
    expect(first.ok).toBe(false);
    if (!first.ok) expect(first.error.settledPayment?.taskId).toBe(TASK);
    expect(relay.submits()).toBe(1);
    db1.close(); // the process exits

    // ── Session 2: a new runtime over the same file ──────────────────────
    globalThis.fetch = relay.fetch; // no fault: the relay still holds the result
    const db2 = createMotebitDatabase(dbPath);
    const runtime = new MotebitRuntime(
      { motebitId: ME, tickRateHz: 0 },
      { storage: buildStorageAdapters(db2), renderer: new NullRenderer() },
    );
    runtime.enableInteractiveDelegation({
      syncUrl: RELAY,
      authToken: async () => "token",
      relayPublicKey: RELAY_KEY,
      buildP2pPayment,
      acknowledgeNoHistoryRisk: true,
    });

    // The startup notice (index.ts prints exactly this line, dimmed).
    expect(paidResultsNotice(runtime.outstandingPaidResults())).toBe(
      "1 paid result not retrieved — /result ed665235",
    );

    // "Hire again" is refused across the session boundary, before broadcast.
    const rehire = await runtime.getToolRegistry().execute("delegate_to_agent", {
      prompt: "research X",
      required_capabilities: ["web_search"],
    });
    expect(rehire.ok).toBe(false);
    expect(rehire.error).toContain("INTENT_ALREADY_PAID");
    expect(rehire.error).toContain(`/result ${TASK}`);

    // `/result` lists, then fetches by the short id the notice showed.
    await handleSlashCommand("result", "", runtime, config);
    expect(logged()).toContain("1 paid result not retrieved");
    expect(logged()).toContain("ed665235");
    await handleSlashCommand("result", "ed665235", runtime, config);
    expect(logged()).toContain("The paid research answer.");
    expect(logged()).toContain("Free read");

    // One payment, one submission — never a second hire.
    expect(buildP2pPayment).toHaveBeenCalledTimes(1);
    expect(relay.submits()).toBe(1);
    runtime.stop();
    db2.close();

    // The retrieval itself is durable: a third start shows nothing owed.
    const db3 = createMotebitDatabase(dbPath);
    expect(db3.paidIntentStore.listOutstanding(ME)).toEqual([]);
    db3.close();
  });
});
