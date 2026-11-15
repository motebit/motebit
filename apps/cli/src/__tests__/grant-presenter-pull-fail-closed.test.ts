/**
 * A FAILED relay revocation pull is not "nothing revoked".
 *
 * `motebit --grant <id>` (and `serve --direct --grant <id>`) merge the local
 * grant file's revocation with the relay's revocation feed at each
 * presentation. The pull mapped every failure (timeout, 429/5xx, network
 * error, a body that is not the feed) to an empty list, silently: on a machine
 * holding a copy of a grant revoked elsewhere, one failed pull verified the
 * grant, and the payment is broadcast before the relay's own fence sees the
 * task. A failed pull now presents NO grant: the turn runs grantless, and R4
 * asks the owner (chat) or is refused (direct task, no one to ask).
 *
 * Every pull here goes to an injected fetch; nothing touches the network.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateKeypair,
  bytesToHex,
  signDelegationRevocation,
  type DelegationRevocation,
} from "@motebit/encryption";
import {
  MotebitRuntime,
  NullRenderer,
  createInMemoryStorage,
  verifyGrantForTurn,
} from "@motebit/runtime";
import { RiskLevel } from "@motebit/sdk";
import type { ToolDefinition } from "@motebit/sdk";
import { createDirectTaskHandler } from "../direct-task-handler.js";

const DAY = 24 * 3_600_000;
const M = 1_000_000;
const ID = "owner-0000-0000-0000-0000000000f1";
const RELAY = "https://relay.invalid";

type GrantMod = typeof import("../subcommands/grant.js");
type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };

let dir: string;
let grantMod: GrantMod;
let owner: Kp;
let pub: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "motebit-grant-pull-"));
  vi.stubEnv("MOTEBIT_CONFIG_DIR", dir);
  vi.stubEnv("MOTEBIT_SYNC_URL", RELAY);
  vi.resetModules();
  grantMod = await import("../subcommands/grant.js");
  owner = await generateKeypair();
  pub = bytesToHex(owner.publicKey);
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** A stored self-grant (delegator = delegate = the owner), slot 0 active. */
async function storeGrant(withLocalRevocation = false): Promise<{
  grantId: string;
  revocation: DelegationRevocation;
}> {
  const minted = await grantMod.mintGrantWithSchedule({
    motebitId: ID,
    publicKeyHex: pub,
    privateKey: owner.privateKey,
    scope: "transfer_funds",
    subject: "billing:vendor=acme",
    ceiling: { schema: "motebit.spend-ceiling.v1", lifetime_limit_micro: 5 * M },
    cadenceMs: DAY,
    days: 3,
    now: Date.now() - 1000,
  });
  const revocation = await signDelegationRevocation(
    {
      grant_id: minted.grant.grant_id,
      delegator_id: minted.grant.delegator_id,
      delegator_public_key: minted.grant.delegator_public_key,
      revoked_at: Date.now(),
    },
    owner.privateKey,
  );
  const grantsDir = join(dir, grantMod.GRANTS_DIR_NAME);
  mkdirSync(grantsDir, { recursive: true });
  writeFileSync(
    join(grantsDir, `${minted.grant.grant_id}.json`),
    JSON.stringify({
      grant: minted.grant,
      ticks: minted.ticks,
      ...(withLocalRevocation ? { revocation } : {}),
    }),
  );
  return { grantId: minted.grant.grant_id, revocation };
}

type FakeFetch = typeof fetch & { calls: string[] };

/** An injected fetch: records the URL, then answers as `respond` says. */
function fakeFetch(respond: (init?: RequestInit) => Promise<Response>): FakeFetch {
  const calls: string[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return respond(init);
  }) as FakeFetch;
  impl.calls = calls;
  return impl;
}
const json = (status: number, body: unknown): FakeFetch =>
  fakeFetch(() => Promise.resolve(new Response(JSON.stringify(body), { status })));
const text = (status: number, body: string): FakeFetch =>
  fakeFetch(() => Promise.resolve(new Response(body, { status })));
const networkError = (): FakeFetch =>
  fakeFetch(() => Promise.reject(new TypeError("fetch failed")));
/** Never answers; rejects only when the caller's timeout signal aborts. */
const hangs = (): FakeFetch =>
  fakeFetch(
    (init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason as Error));
      }),
  );

const self = (): { presenter: { motebitId: string; publicKeyHex: string } } & {
  delegator: { motebitId: string; publicKeyHex: string };
} => ({
  presenter: { motebitId: ID, publicKeyHex: pub },
  delegator: { motebitId: ID, publicKeyHex: pub },
});

/** Present once and run the runtime's verifier over what was presented. */
async function presentAndVerify(
  grantId: string,
  fetchImpl: FakeFetch,
): Promise<{ presented: boolean; verified: boolean }> {
  const presenter = await grantMod.createGrantPresenter(grantId, {
    fetch: fetchImpl,
    pullTimeoutMs: 30,
  });
  expect(presenter).not.toBeNull();
  const turn = await presenter!.delegationForTurn();
  if (turn == null) return { presented: false, verified: false };
  const verified = await verifyGrantForTurn(
    turn.delegation.token,
    turn.delegation.grant,
    turn.delegation.revocations,
    self(),
  );
  return { presented: true, verified: verified != null };
}

describe("revocation pull: a failed pull presents no grant", () => {
  const FAILURES: Array<[string, () => FakeFetch]> = [
    ["a timeout", hangs],
    ["HTTP 429", () => json(429, { error: "rate limited" })],
    ["HTTP 500", () => json(500, { error: "boom" })],
    // The status decides, not the body: an error answer that happens to carry
    // a feed-shaped body is still a failed read.
    ["HTTP 429 with a feed-shaped body", () => json(429, { records: [] })],
    ["HTTP 500 with a feed-shaped body", () => json(500, { records: [] })],
    ["a network error", networkError],
    ["a body that is not JSON", () => text(200, "<html>gateway</html>")],
    ["a 200 body with no records array", () => json(200, { ok: true })],
    ["a 200 body whose records is not an array", () => json(200, { records: "none" })],
    ["a 200 body whose records holds a non-object", () => json(200, { records: [null] })],
  ];
  for (const [name, make] of FAILURES) {
    it(`${name}: no grant is presented`, async () => {
      const { grantId } = await storeGrant();
      const fetchImpl = make();
      const presenter = await grantMod.createGrantPresenter(grantId, {
        fetch: fetchImpl,
        pullTimeoutMs: 30,
      });
      expect(await presenter!.delegationForTurn()).toBeNull();
      expect(await presenter!.presentForTurn()).toEqual({
        status: "withheld",
        reason: "revocation_unconfirmed",
      });
      // The relay WAS asked — this is a failed read, not a skipped one.
      expect(fetchImpl.calls[0]).toBe(`${RELAY}/api/v1/delegations/revocations`);
    });
  }

  it("the pull's result names failure and empty success as different answers", async () => {
    expect(await grantMod.pullRelayRevocations({ fetch: json(503, {}) })).toMatchObject({
      status: "failed",
    });
    expect(await grantMod.pullRelayRevocations({ fetch: json(200, { records: [] }) })).toEqual({
      status: "ok",
      records: [],
    });
  });

  it("200 with an empty list: the grant is presented and verifies", async () => {
    const { grantId } = await storeGrant();
    expect(await presentAndVerify(grantId, json(200, { records: [], next_since: 0 }))).toEqual({
      presented: true,
      verified: true,
    });
  });

  it("200 listing this grant's revocation: presented with it, and the verifier refuses", async () => {
    const { grantId, revocation } = await storeGrant();
    expect(await presentAndVerify(grantId, json(200, { records: [revocation] }))).toEqual({
      presented: true,
      verified: false,
    });
  });

  it("no relay configured: the grant is presented from local state, and nothing is fetched", async () => {
    const { grantId } = await storeGrant();
    vi.stubEnv("MOTEBIT_SYNC_URL", "");
    try {
      const fetchImpl = networkError();
      expect(await presentAndVerify(grantId, fetchImpl)).toEqual({
        presented: true,
        verified: true,
      });
      expect(fetchImpl.calls).toHaveLength(0);
    } finally {
      vi.stubEnv("MOTEBIT_SYNC_URL", RELAY);
    }
  });

  it("no relay configured + a local revocation: the verifier refuses", async () => {
    const { grantId } = await storeGrant(true);
    vi.stubEnv("MOTEBIT_SYNC_URL", "");
    try {
      expect(await presentAndVerify(grantId, networkError())).toEqual({
        presented: true,
        verified: false,
      });
    } finally {
      vi.stubEnv("MOTEBIT_SYNC_URL", RELAY);
    }
  });

  it("a local revocation + a failed pull: no authority", async () => {
    const { grantId } = await storeGrant(true);
    expect((await presentAndVerify(grantId, json(500, {}))).verified).toBe(false);
  });

  it("a local revocation + a successful empty pull: the verifier still refuses", async () => {
    const { grantId } = await storeGrant(true);
    expect(await presentAndVerify(grantId, json(200, { records: [] }))).toEqual({
      presented: true,
      verified: false,
    });
  });
});

describe("revocation pull: the notice fires once per session", () => {
  it("several failed-pull turns call onRevocationUnconfirmed exactly once", async () => {
    const { grantId } = await storeGrant();
    const notice = vi.fn();
    const presenter = await grantMod.createGrantPresenter(grantId, {
      fetch: json(500, {}),
      onRevocationUnconfirmed: notice,
    });
    for (let turn = 0; turn < 4; turn++) {
      expect(await presenter!.delegationForTurn()).toBeNull();
    }
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it("a successful pull never fires it, and a later failure still does", async () => {
    const { grantId } = await storeGrant();
    const notice = vi.fn();
    let status = 200;
    const presenter = await grantMod.createGrantPresenter(grantId, {
      fetch: fakeFetch(() =>
        Promise.resolve(new Response(JSON.stringify({ records: [] }), { status })),
      ),
      onRevocationUnconfirmed: notice,
    });
    expect(await presenter!.delegationForTurn()).not.toBeNull();
    expect(notice).not.toHaveBeenCalled();
    status = 502;
    expect(await presenter!.delegationForTurn()).toBeNull();
    expect(await presenter!.delegationForTurn()).toBeNull();
    expect(notice).toHaveBeenCalledTimes(1);
    // The relay answers again: the grant is presented again.
    status = 200;
    expect(await presenter!.delegationForTurn()).not.toBeNull();
  });
});

// ── The real runtime path ────────────────────────────────────────────

const ARGS = { counterparty: "vendor-acme", amount_micro: 1 * M };
const TRANSFER: ToolDefinition = {
  name: "transfer_funds",
  mode: "api",
  description: "Transfer USDC to an address",
  inputSchema: { type: "object", properties: {} },
  riskHint: { risk: RiskLevel.R4_MONEY },
};
const POLICY = {
  operatorMode: true,
  maxRiskLevel: RiskLevel.R4_MONEY,
  requireApprovalAbove: RiskLevel.R3_EXECUTE,
  denyAbove: RiskLevel.R4_MONEY,
};

/** A model that calls the R4 tool once, then finishes. */
function scriptedProvider(): unknown {
  const gen = (ctx: { conversation_history?: unknown }) => {
    const history = JSON.stringify(ctx.conversation_history ?? []);
    const seenResult = history.includes("tool_result") || history.includes('"role":"tool"');
    return seenResult
      ? { text: "done", confidence: 0.8, memory_candidates: [], state_updates: {} }
      : {
          text: "",
          confidence: 0.8,
          memory_candidates: [],
          state_updates: {},
          tool_calls: [{ id: "c1", name: "transfer_funds", args: { ...ARGS } }],
        };
  };
  return {
    model: "mock-model",
    setModel: vi.fn(),
    generate: vi.fn(async (ctx: { conversation_history?: unknown }) => gen(ctx)),
    estimateConfidence: vi.fn(async () => 0.8),
    extractMemoryCandidates: vi.fn(async () => []),
    async *generateStream(ctx: { conversation_history?: unknown }) {
      const response = gen(ctx);
      if (response.text) yield { type: "text" as const, text: response.text };
      yield { type: "done" as const, response };
    },
  };
}

/** One owner chat turn, wired as the REPL wires it (apps/cli/src/index.ts). */
async function ownerTurn(fetchImpl: FakeFetch): Promise<{
  buildPayment: ReturnType<typeof vi.fn>;
  chunkTypes: string[];
  runtime: MotebitRuntime;
}> {
  const { grantId } = await storeGrant();
  const runtime = new MotebitRuntime(
    { motebitId: ID, tickRateHz: 0, signingKeys: owner, policy: POLICY },
    {
      storage: createInMemoryStorage(),
      renderer: new NullRenderer(),
      ai: scriptedProvider() as never,
    },
  );
  // The counting fake payment builder: the only thing that "moves money".
  const buildPayment = vi.fn(async () => ({ signature: "fake-sig" }));
  runtime.getToolRegistry().register(TRANSFER, async () => {
    await buildPayment();
    return { ok: true, data: "moved" };
  });
  const presenter = await grantMod.createGrantPresenter(grantId, { fetch: fetchImpl });
  const presentation = await presenter!.presentForTurn();
  const grantOptions =
    presentation.status === "presented" ? { delegation: presentation.delegation } : undefined;
  const chunkTypes: string[] = [];
  for await (const chunk of runtime.sendMessageStreaming("pay acme", undefined, grantOptions)) {
    chunkTypes.push(chunk.type);
  }
  return { buildPayment, chunkTypes, runtime };
}

describe("revocation pull: the runtime path (owner chat turn)", () => {
  it("failed pull: the R4 call does not auto-execute — it pauses for approval, zero payments built", async () => {
    const { buildPayment, chunkTypes, runtime } = await ownerTurn(json(500, {}));
    expect(buildPayment).toHaveBeenCalledTimes(0);
    expect(chunkTypes).toContain("approval_request");
    // The fallback is the existing human path: the owner's tap moves it, once.
    for await (const _chunk of runtime.resumeAfterApproval(true)) {
      // drain
    }
    expect(buildPayment).toHaveBeenCalledTimes(1);
  });

  it("control — successful empty pull: the grant clears the R4 call with no pause", async () => {
    const { buildPayment, chunkTypes } = await ownerTurn(json(200, { records: [] }));
    expect(chunkTypes).not.toContain("approval_request");
    expect(buildPayment).toHaveBeenCalledTimes(1);
  });
});

/** One direct task, wired as `serve --direct --grant` wires it (daemon.ts). */
async function directTask(fetchImpl: FakeFetch): Promise<{
  moved: ReturnType<typeof vi.fn>;
  receipt: Record<string, unknown>;
  notice: ReturnType<typeof vi.fn>;
}> {
  const { grantId } = await storeGrant();
  const runtime = new MotebitRuntime(
    { motebitId: ID, tickRateHz: 0, signingKeys: owner, policy: POLICY },
    { storage: createInMemoryStorage(), renderer: new NullRenderer() },
  );
  const moved = vi.fn(async () => ({ ok: true, data: "moved" }));
  // Late-bound: metered at its rail seam, so the gated path does not price
  // the task's args — this test is about whether the grant is presented.
  runtime.getToolRegistry().register(
    {
      ...TRANSFER,
      moneyBinding: "late",
      inputSchema: {
        type: "object",
        properties: { destination: { type: "string" } },
        required: ["destination"],
      },
    },
    moved,
  );
  const notice = vi.fn();
  const serveGrant = await grantMod.createGrantPresenter(grantId, {
    fetch: fetchImpl,
    onRevocationUnconfirmed: notice,
  });
  const handler = createDirectTaskHandler({
    runtime,
    motebitId: ID,
    deviceId: "dev-f1",
    publicKeyHex: pub,
    privateKey: owner.privateKey,
    preferExternalTools: false,
    log: () => {},
    delegationForTask: () => serveGrant!.delegationForTurn(),
  });
  let receipt: Record<string, unknown> | undefined;
  // The caller the transport verified IS the self-grant's delegate.
  for await (const chunk of handler("VendorAddr1111111111111111111111111111111111", {
    relayTaskId: "relay-task-f1",
    caller: { motebitId: ID, publicKeyHex: pub },
  })) {
    if (chunk.type === "task_result") receipt = chunk.receipt;
  }
  expect(receipt).toBeDefined();
  return { moved, receipt: receipt!, notice };
}

describe("revocation pull: serve --direct --grant inherits it", () => {
  it("failed pull: the R4 task is refused and the tool never runs", async () => {
    const { moved, receipt, notice } = await directTask(networkError());
    expect(moved).toHaveBeenCalledTimes(0);
    expect(receipt.status).toBe("failed");
    expect(String(receipt.result)).toMatch(/approval/i);
    expect(notice).toHaveBeenCalledTimes(1);
  });

  it("control — successful empty pull: the granted task runs once", async () => {
    const { moved, receipt, notice } = await directTask(json(200, { records: [] }));
    expect(moved).toHaveBeenCalledTimes(1);
    expect(receipt.status).toBe("completed");
    expect(notice).not.toHaveBeenCalled();
  });
});
