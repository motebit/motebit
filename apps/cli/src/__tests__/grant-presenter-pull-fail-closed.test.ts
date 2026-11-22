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
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
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
/** A relay named ONLY in the environment: the presenter must never ask it. */
const ENV_RELAY = "https://env-relay.invalid";
/** The relay the "session" resolved and passes to the presenter. */
let sessionRelay: string | undefined = RELAY;

type GrantMod = typeof import("../subcommands/grant.js");
type Kp = { publicKey: Uint8Array; privateKey: Uint8Array };

let dir: string;
let grantMod: GrantMod;
let owner: Kp;
let pub: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "motebit-grant-pull-"));
  vi.stubEnv("MOTEBIT_CONFIG_DIR", dir);
  vi.stubEnv("MOTEBIT_SYNC_URL", ENV_RELAY);
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
/**
 * A relay that answers with a redirect to a host serving a well-shaped empty
 * feed. As fetch does: `redirect: "error"` rejects; anything else follows it.
 */
const redirects = (): FakeFetch =>
  fakeFetch((init) =>
    init?.redirect === "error"
      ? Promise.reject(new TypeError("fetch failed: unexpected redirect"))
      : Promise.resolve(new Response(JSON.stringify({ records: [] }), { status: 200 })),
  );
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
    relayUrls: () => [sessionRelay],
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
    ["a redirected answer", redirects],
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
        relayUrls: () => [sessionRelay],
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
    expect(
      await grantMod.pullRelayRevocations({ relayUrl: RELAY, fetch: json(503, {}) }),
    ).toMatchObject({
      status: "failed",
    });
    expect(
      await grantMod.pullRelayRevocations({ relayUrl: RELAY, fetch: json(200, { records: [] }) }),
    ).toEqual({
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

  // MOTEBIT_SYNC_URL names ENV_RELAY throughout this file: zero fetches here
  // also shows the presenter falls back to no source of its own.
  it("no relay configured: the grant is presented from local state, and nothing is fetched", async () => {
    const { grantId } = await storeGrant();
    sessionRelay = undefined;
    try {
      const fetchImpl = networkError();
      expect(await presentAndVerify(grantId, fetchImpl)).toEqual({
        presented: true,
        verified: true,
      });
      expect(fetchImpl.calls).toHaveLength(0);
    } finally {
      sessionRelay = RELAY;
    }
  });

  it("no relay configured + a local revocation: the verifier refuses", async () => {
    const { grantId } = await storeGrant(true);
    sessionRelay = undefined;
    try {
      expect(await presentAndVerify(grantId, networkError())).toEqual({
        presented: true,
        verified: false,
      });
    } finally {
      sessionRelay = RELAY;
    }
  });

  it("a local revocation + a failed pull: no authority", async () => {
    const { grantId } = await storeGrant(true);
    // Withheld, not "presented and then refused": the status is asserted, so
    // this fails when the withhold branch is removed.
    expect(await presentAndVerify(grantId, json(500, {}))).toEqual({
      presented: false,
      verified: false,
    });
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => [RELAY],
      fetch: json(500, {}),
    });
    expect((await presenter!.presentForTurn()).status).toBe("withheld");
  });

  it("a local revocation + a successful empty pull: the verifier still refuses", async () => {
    const { grantId } = await storeGrant(true);
    expect(await presentAndVerify(grantId, json(200, { records: [] }))).toEqual({
      presented: true,
      verified: false,
    });
  });
});

describe("revocation pull: the notice fires once per outage", () => {
  it("consecutive failed-pull turns call onRevocationUnconfirmed exactly once, with the reason", async () => {
    const { grantId } = await storeGrant();
    const notice = vi.fn();
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => [RELAY],
      fetch: json(429, {}),
      onRevocationUnconfirmed: notice,
    });
    for (let turn = 0; turn < 4; turn++) {
      expect(await presenter!.delegationForTurn()).toBeNull();
    }
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith("HTTP 429 (relay.invalid)");
  });

  it("failure, success, failure: each outage is announced once", async () => {
    const { grantId } = await storeGrant();
    const notice = vi.fn();
    let status = 200;
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => [RELAY],
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
    expect(notice).toHaveBeenLastCalledWith("HTTP 502 (relay.invalid)");
    // The relay answers again: the grant is presented again, the outage over.
    status = 200;
    expect(await presenter!.delegationForTurn()).not.toBeNull();
    expect(notice).toHaveBeenCalledTimes(1);
    // A second, distinct outage is announced again — once.
    status = 503;
    expect(await presenter!.delegationForTurn()).toBeNull();
    expect(await presenter!.delegationForTurn()).toBeNull();
    expect(notice).toHaveBeenCalledTimes(2);
    expect(notice).toHaveBeenLastCalledWith("HTTP 503 (relay.invalid)");
  });
});

/** A fetch answering per relay origin; an unlisted origin is unreachable. */
function relayRouter(answers: Record<string, () => Response>): FakeFetch {
  const calls: string[] = [];
  const impl = ((input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const answer = answers[new URL(url).origin];
    return answer != null
      ? Promise.resolve(answer())
      : Promise.reject(new TypeError("fetch failed"));
  }) as FakeFetch;
  impl.calls = calls;
  return impl;
}
const feedOk =
  (records: unknown[] = []) =>
  (): Response =>
    new Response(JSON.stringify({ records }), { status: 200 });
const feedStatus = (code: number) => (): Response => new Response("{}", { status: code });
const feedUrl = (relay: string): string => `${relay}/api/v1/delegations/revocations`;

// THE SET: every relay named by the flag, the environment, the saved config, and
// the relay the session is connected to — all of them, not the winning one. A
// revocation may sit on any: `motebit grant revoke` run without the flag posts
// to the config relay while a `--sync-url` session talks to another.
describe("revocation pull: every source that names a relay is asked, not the winner", () => {
  const A = "https://a.invalid";
  const B = "https://b.invalid";
  type Sources = { flag?: string; env?: string; cfg?: string };
  type Kind = "REPL" | "serve (http)" | "serve (stdio)";
  const KINDS: Kind[] = ["REPL", "serve (http)", "serve (stdio)"];

  afterEach(() => {
    vi.stubEnv("MOTEBIT_SYNC_URL", ENV_RELAY);
    rmSync(join(dir, "config.json"), { force: true });
  });

  async function saveConfigRelay(url: string | undefined): Promise<void> {
    const { loadFullConfig, saveFullConfig } = await import("../config.js");
    if (url === undefined) rmSync(join(dir, "config.json"), { force: true });
    else saveFullConfig({ ...loadFullConfig(), sync_url: url });
  }

  /**
   * A `--grant` session of `kind` started under `sources`, composing its relay
   * set exactly as index.ts / daemon.ts do: the real `namedRelayUrl` /
   * `daemonRelay` for the session's own relay, then the real composer.
   */
  async function start(
    kind: Kind,
    sources: Sources,
    fetchImpl: FakeFetch,
  ): Promise<{
    status: () => Promise<string>;
    verified: () => Promise<boolean>;
    revocation: DelegationRevocation;
  }> {
    const { namedRelayUrl } = await import("../sync-opt-in.js");
    const { daemonRelay } = await import("../sync-configured.js");
    const { loadFullConfig } = await import("../config.js");
    const { parseCliArgs } = await import("../args.js");
    await saveConfigRelay(sources.cfg);
    vi.stubEnv("MOTEBIT_SYNC_URL", sources.env ?? "");
    const config = parseCliArgs(sources.flag != null ? ["--sync-url", sources.flag] : []);
    let relayUrls: () => readonly (string | undefined)[];
    if (kind === "REPL") {
      const sessionRelay = new grantMod.SessionRelays();
      sessionRelay.add(namedRelayUrl(config, loadFullConfig()));
      relayUrls = () => grantMod.replGrantRelayUrls(sessionRelay, config);
    } else {
      const relay = daemonRelay(
        config,
        loadFullConfig(),
        kind === "serve (http)" ? "http" : "stdio",
      );
      relayUrls = () => grantMod.daemonGrantRelayUrls(relay, config);
    }
    const { grantId, revocation } = await storeGrant();
    const presenter = await grantMod.createGrantPresenter(grantId, { relayUrls, fetch: fetchImpl });
    return {
      status: async () => (await presenter!.presentForTurn()).status,
      verified: async () => {
        const turn = await presenter!.delegationForTurn();
        if (turn == null) return false;
        const { token, grant, revocations } = turn.delegation;
        return (await verifyGrantForTurn(token, grant, revocations, self())) != null;
      },
      revocation,
    };
  }

  const COMBOS: Array<[string, Sources]> = [
    ["flag=A + config=B", { flag: A, cfg: B }],
    ["flag=A + env=B", { flag: A, env: B }],
    ["env=A + config=B", { env: A, cfg: B }],
  ];
  for (const kind of KINDS) {
    for (const [name, sources] of COMBOS) {
      it(`${kind}: ${name}: both relays are asked, either failing withholds, either's revocation refuses`, async () => {
        // Both answer: presented, and BOTH were asked.
        const both = relayRouter({ [A]: feedOk(), [B]: feedOk() });
        const s = await start(kind, sources, both);
        expect(await s.status()).toBe("presented");
        expect([...both.calls].sort()).toEqual([feedUrl(A), feedUrl(B)]);
        expect(await s.verified()).toBe(true);
        // Either one failing withholds.
        for (const down of [A, B]) {
          const up = down === A ? B : A;
          const t = await start(
            kind,
            sources,
            relayRouter({ [up]: feedOk(), [down]: feedStatus(500) }),
          );
          expect(await t.status()).toBe("withheld");
        }
        // A revocation on either one refuses (posted to the "losing" relay too).
        for (const holder of [A, B]) {
          const other = holder === A ? B : A;
          const router: Record<string, () => Response> = { [other]: feedOk() };
          const t = await start(kind, sources, relayRouter(router));
          router[holder] = feedOk([t.revocation]);
          expect(await t.status()).toBe("presented");
          expect(await t.verified()).toBe(false);
        }
      });
    }

    for (const [name, sources] of [
      ["flag=A", { flag: A }],
      ["env=A", { env: A }],
    ] as Array<[string, Sources]>) {
      it(`${kind}: started with ${name}, config B saved by another process mid-session: B is asked on the next turn`, async () => {
        const router = relayRouter({ [A]: feedOk(), [B]: feedStatus(500) });
        const s = await start(kind, sources, router);
        expect(await s.status()).toBe("presented");
        expect(router.calls).toEqual([feedUrl(A)]);
        await saveConfigRelay(B);
        expect(await s.status()).toBe("withheld");
        expect(router.calls).toContain(feedUrl(B));
      });
    }

    it(`${kind}: --sync-url only (no env, no config) + a failed pull: withheld`, async () => {
      const router = relayRouter({ "https://flag-relay.invalid": feedStatus(500) });
      const s = await start(kind, { flag: "https://flag-relay.invalid/" }, router);
      expect(await s.status()).toBe("withheld");
      expect(router.calls).toEqual([feedUrl("https://flag-relay.invalid")]);
    });

    it(`${kind}: config sync_url "" + env set + a failed pull: withheld (the env relay is asked)`, async () => {
      const router = relayRouter({});
      const s = await start(kind, { env: A, cfg: "" }, router);
      expect(await s.status()).toBe("withheld");
      expect(router.calls).toEqual([feedUrl(A)]);
    });

    it(`${kind}: whitespace-only everywhere is no relay: presented, nothing is fetched`, async () => {
      const router = relayRouter({});
      const s = await start(kind, { flag: "   ", env: "  ", cfg: " " }, router);
      expect(await s.status()).toBe("presented");
      expect(router.calls).toHaveLength(0);
    });
  }

  it("the single pull reads a whitespace-only URL as no relay", async () => {
    expect(
      await grantMod.pullRelayRevocations({ relayUrl: "  \t ", fetch: networkError() }),
    ).toEqual({ status: "no_relay" });
  });
});

// THE RULE: each turn, pull from EVERY relay this identity is known to use, and
// withhold if ANY pull fails.
describe("revocation pull: every known relay is asked, any failure withholds", () => {
  const A = "https://a.invalid";
  const B = "https://b.invalid";
  const feed = (url: string): string => `${url}/api/v1/delegations/revocations`;
  /** A fetch answering per relay origin. */
  const byRelay = (answers: Record<string, () => Response>): FakeFetch => {
    const impl = fakeFetch(() => Promise.reject(new TypeError("unrouted")));
    const routed = ((input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      impl.calls.push(url);
      const answer = answers[new URL(url).origin];
      return answer != null
        ? Promise.resolve(answer())
        : Promise.reject(new TypeError("fetch failed"));
    }) as FakeFetch;
    routed.calls = impl.calls;
    return routed;
  };
  const ok =
    (records: unknown[] = []) =>
    (): Response =>
      new Response(JSON.stringify({ records }), { status: 200 });
  const status = (code: number) => (): Response => new Response("{}", { status: code });

  it("two relays, one fails: withheld, and the notice names the failing host only", async () => {
    const { grantId } = await storeGrant();
    const notice = vi.fn();
    const fetchImpl = byRelay({ [A]: ok(), [B]: status(500) });
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => [A, B],
      fetch: fetchImpl,
      onRevocationUnconfirmed: notice,
    });
    expect((await presenter!.presentForTurn()).status).toBe("withheld");
    expect([...fetchImpl.calls].sort()).toEqual([feed(A), feed(B)]);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith("HTTP 500 (b.invalid)");
  });

  it("two relays, both ok: the records are merged (a revocation on either one refuses)", async () => {
    const { grantId, revocation } = await storeGrant();
    for (const holder of [A, B]) {
      const other = holder === A ? B : A;
      const presenter = await grantMod.createGrantPresenter(grantId, {
        relayUrls: () => [A, B],
        fetch: byRelay({ [holder]: ok([revocation]), [other]: ok() }),
      });
      const turn = await presenter!.delegationForTurn();
      expect(turn).not.toBeNull();
      expect(turn!.delegation.revocations).toEqual([revocation]);
      expect(
        await verifyGrantForTurn(
          turn!.delegation.token,
          turn!.delegation.grant,
          turn!.delegation.revocations,
          self(),
        ),
      ).toBeNull();
    }
  });

  it("duplicates (after normalisation) are asked once", async () => {
    const { grantId } = await storeGrant();
    const fetchImpl = byRelay({ [A]: ok() });
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => [A, `${A}/`, ` ${A}// `, undefined, "  "],
      fetch: fetchImpl,
    });
    expect((await presenter!.presentForTurn()).status).toBe("presented");
    expect(fetchImpl.calls).toEqual([feed(A)]);
  });

  it("an empty set is no relay: presented from local state, zero fetches", async () => {
    const { grantId } = await storeGrant();
    const fetchImpl = networkError();
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => [undefined, "", "   "],
      fetch: fetchImpl,
    });
    expect((await presenter!.presentForTurn()).status).toBe("presented");
    expect(fetchImpl.calls).toHaveLength(0);
    expect(await grantMod.pullRevocationsFromRelays([], { fetch: fetchImpl })).toEqual({
      status: "no_relay",
    });
  });

  it("no relayUrls given + a relay named only in the environment: nothing is fetched", async () => {
    // MOTEBIT_SYNC_URL names ENV_RELAY here; the presenter has no source of its own.
    const { grantId } = await storeGrant();
    const fetchImpl = networkError();
    const presenter = await grantMod.createGrantPresenter(grantId, { fetch: fetchImpl });
    expect((await presenter!.presentForTurn()).status).toBe("presented");
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it("an answer that was redirected (a fetch that followed one anyway) is a failed pull", async () => {
    const { grantId } = await storeGrant();
    const notice = vi.fn();
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => [A],
      fetch: fakeFetch(() => {
        const res = new Response(JSON.stringify({ records: [] }), { status: 200 });
        Object.defineProperty(res, "redirected", { value: true });
        return Promise.resolve(res);
      }),
      onRevocationUnconfirmed: notice,
    });
    expect((await presenter!.presentForTurn()).status).toBe("withheld");
    expect(notice).toHaveBeenCalledWith("redirected (a.invalid)");
  });

  it("the set is asked again at EACH presentation, never captured", async () => {
    const { grantId } = await storeGrant();
    const current: { url: string | undefined } = { url: undefined };
    const fetchImpl = byRelay({ [A]: status(500) });
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => [current.url],
      fetch: fetchImpl,
    });
    expect((await presenter!.presentForTurn()).status).toBe("presented");
    current.url = A;
    expect((await presenter!.presentForTurn()).status).toBe("withheld");
  });

  it("a relay set that cannot be read withholds", async () => {
    const { grantId } = await storeGrant();
    const notice = vi.fn();
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => {
        throw new Error("config damaged at /secret/path");
      },
      onRevocationUnconfirmed: notice,
    });
    expect((await presenter!.presentForTurn()).status).toBe("withheld");
    expect(notice).toHaveBeenCalledWith("relay configuration unreadable");
  });
});

describe("revocation pull: the notice follows the failing relay", () => {
  const A = "https://a.invalid";
  const B = "https://b.invalid";

  it("A fails, then A recovers while B fails: announced again, naming B", async () => {
    const { grantId } = await storeGrant();
    const notice = vi.fn();
    const answers: Record<string, () => Response> = { [A]: feedStatus(503), [B]: feedOk() };
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => [A, B],
      fetch: relayRouter(answers),
      onRevocationUnconfirmed: notice,
    });
    expect((await presenter!.presentForTurn()).status).toBe("withheld");
    expect((await presenter!.presentForTurn()).status).toBe("withheld");
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenLastCalledWith("HTTP 503 (a.invalid)");
    // No fully successful turn in between: A recovers as B starts failing.
    answers[A] = feedOk();
    answers[B] = feedStatus(429);
    expect((await presenter!.presentForTurn()).status).toBe("withheld");
    expect((await presenter!.presentForTurn()).status).toBe("withheld");
    expect(notice).toHaveBeenCalledTimes(2);
    expect(notice).toHaveBeenLastCalledWith("HTTP 429 (b.invalid)");
    // Both failing is a new set too; the same set again is silent.
    answers[A] = feedStatus(500);
    expect((await presenter!.presentForTurn()).status).toBe("withheld");
    expect((await presenter!.presentForTurn()).status).toBe("withheld");
    expect(notice).toHaveBeenCalledTimes(3);
    expect(notice).toHaveBeenLastCalledWith("HTTP 500 (a.invalid); HTTP 429 (b.invalid)");
  });

  it("the same relay failing differently (500, then a timeout) is the same outage: silent", async () => {
    const { grantId } = await storeGrant();
    const notice = vi.fn();
    const answers: Record<string, () => Response> = { [A]: feedStatus(500) };
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => [A],
      fetch: relayRouter(answers),
      onRevocationUnconfirmed: notice,
    });
    expect((await presenter!.presentForTurn()).status).toBe("withheld");
    answers[A] = feedStatus(502);
    expect((await presenter!.presentForTurn()).status).toBe("withheld");
    expect(notice).toHaveBeenCalledTimes(1);
  });
});

describe("revocation pull: the reason never carries a URL or an error's own text", () => {
  const SECRET = "s3cr3t-token";
  const WITH_USERINFO = `https://user:${SECRET}@relay.invalid/base?key=${SECRET}`;

  async function reasonFor(relayUrl: string, fetchImpl: FakeFetch): Promise<string> {
    const { grantId } = await storeGrant();
    const notice = vi.fn<(reason: string) => void>();
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => [relayUrl],
      fetch: fetchImpl,
      pullTimeoutMs: 30,
      onRevocationUnconfirmed: notice,
    });
    expect((await presenter!.presentForTurn()).status).toBe("withheld");
    expect(notice).toHaveBeenCalledTimes(1);
    return notice.mock.calls[0]![0];
  }

  it("a thrown error quoting the credentialed URL: host only, a fixed word", async () => {
    const reason = await reasonFor(
      WITH_USERINFO,
      fakeFetch(() =>
        Promise.reject(
          new TypeError(`Request cannot be constructed from ${WITH_USERINFO} (credentials)`),
        ),
      ),
    );
    expect(reason).toBe("network error (relay.invalid)");
    expect(reason).not.toContain(SECRET);
    expect(reason).not.toContain("user");
  });

  it("an HTTP error from a credentialed URL: status and host only", async () => {
    const reason = await reasonFor(WITH_USERINFO, json(503, {}));
    expect(reason).toBe("HTTP 503 (relay.invalid)");
    expect(reason).not.toContain(SECRET);
  });

  it("each failure kind maps to its fixed reason", async () => {
    expect(await reasonFor(RELAY, hangs())).toBe("timeout (relay.invalid)");
    expect(await reasonFor(RELAY, networkError())).toBe("network error (relay.invalid)");
    expect(
      await reasonFor(
        RELAY,
        fakeFetch(() =>
          // What Node's fetch throws for `redirect: "error"`.
          Promise.reject(
            new TypeError("fetch failed", { cause: new Error("unexpected redirect") }),
          ),
        ),
      ),
    ).toBe("redirected (relay.invalid)");
    expect(await reasonFor(RELAY, text(200, "<html>"))).toBe(
      "not a revocation feed (relay.invalid)",
    );
    expect(await reasonFor(RELAY, json(200, { ok: true }))).toBe(
      "not a revocation feed (relay.invalid)",
    );
    expect(await reasonFor(`not a url ${SECRET}`, networkError())).toBe("invalid relay URL");
    expect(await reasonFor(`ftp://${SECRET}@relay.invalid`, networkError())).toBe(
      "invalid relay URL",
    );
  });
});

// The REPL, over a REAL MotebitRuntime and the real `/connect` handler, wired as
// apps/cli/src/index.ts + repl-relay.ts wire it: delegation enabled against the
// startup relay, one `SessionRelays` shared by the slash-command context and
// `replGrantRelayUrls`.
//
// THE PROPERTY: the relay `delegate_to_agent` would submit to is in the set
// that was pulled, and a revocation held only on that relay refuses the grant.
// `/connect B` in a session already on a relay is refused: it sends nothing
// and adds nothing, so the session's relay and the pulled set stay as they
// were. A first `/connect` (a session on no relay) adds its relay, and the
// relay the saved config named just before, to a set that only grows.
describe("revocation pull: the relay delegation submits to is always pulled (/connect adds, never replaces)", () => {
  const A = "https://a.invalid";
  const B = "https://b.invalid";
  const C = "https://c.invalid";
  const feed = (url: string): string => `${url}/api/v1/delegations/revocations`;
  let feedAnswer: Record<string, () => Response>;
  let feedCalls: string[];
  let taskCalls: string[];
  // `/connect` refuses when an operator token is set, so neither variable may
  // leak in from the machine running the suite. Deleted, not emptied: an
  // empty string counts as defined and shadows the next source.
  const TOKEN_VARS = ["MOTEBIT_API_TOKEN", "MOTEBIT_SYNC_TOKEN"] as const;
  let tokenVarsBefore: Array<string | undefined>;

  beforeEach(() => {
    tokenVarsBefore = TOKEN_VARS.map((k) => process.env[k]);
    for (const k of TOKEN_VARS) delete process.env[k];
    feedAnswer = {};
    feedCalls = [];
    taskCalls = [];
    rmSync(join(dir, "config.json"), { force: true });
    vi.stubEnv("MOTEBIT_SYNC_URL", "");
    vi.spyOn(console, "log").mockImplementation(() => {});
    // One fetch for everything the session does: /connect's bootstrap and
    // discovery are answered; the feed answers per relay (unlisted: an empty
    // feed); a task submission is recorded and refused; the rest is refused.
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/api/v1/agents/bootstrap")) {
        return Promise.resolve(new Response(JSON.stringify({ registered: true }), { status: 200 }));
      }
      if (url.endsWith("/api/v1/agents/discover")) {
        return Promise.resolve(new Response(JSON.stringify({ agents: [] }), { status: 200 }));
      }
      if (url.endsWith("/api/v1/delegations/revocations")) {
        feedCalls.push(url);
        const answer = feedAnswer[new URL(url).origin] ?? ok();
        return Promise.resolve(answer());
      }
      if (url.endsWith("/task")) taskCalls.push(url);
      return Promise.reject(new TypeError(`network denied: ${url}`));
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.stubEnv("MOTEBIT_SYNC_URL", ENV_RELAY);
    rmSync(join(dir, "config.json"), { force: true });
    TOKEN_VARS.forEach((k, i) => {
      const before = tokenVarsBefore[i];
      if (before === undefined) delete process.env[k];
      else process.env[k] = before;
    });
  });

  /** A REPL session with `--grant`, started under these relay sources. */
  async function session(sources: { flag?: string; env?: string; cfg?: string } = {}): Promise<{
    present: () => Promise<string>;
    /** The origins asked by one presentation. */
    pulled: () => Promise<string[]>;
    verified: () => Promise<boolean>;
    connect: (url: string) => Promise<void>;
    /** The session's own relay set (`SessionRelays`), as it stands. */
    relays: () => readonly string[];
    /** The origin `delegate_to_agent` submits a task to, or null when not enabled. */
    delegationOrigin: () => Promise<string | null>;
    revocation: DelegationRevocation;
  }> {
    const { handleSlashCommand } = await import("../slash-commands.js");
    const { namedRelayUrl } = await import("../sync-opt-in.js");
    const { loadFullConfig, saveFullConfig } = await import("../config.js");
    const { parseCliArgs } = await import("../args.js");
    if (sources.cfg != null) saveFullConfig({ ...loadFullConfig(), sync_url: sources.cfg });
    vi.stubEnv("MOTEBIT_SYNC_URL", sources.env ?? "");
    const config = parseCliArgs(sources.flag != null ? ["--sync-url", sources.flag] : []);
    // The startup config object the REPL keeps and hands to every slash command.
    const startupConfig = { ...loadFullConfig(), device_public_key: pub };
    const runtime = new MotebitRuntime(
      { motebitId: ID, tickRateHz: 0, signingKeys: owner, policy: POLICY },
      { storage: createInMemoryStorage(), renderer: new NullRenderer() },
    );
    const authToken = (): Promise<string> => Promise.resolve("token");
    // index.ts: `const syncUrl = resolveRelayUrl(config, reloadedConfig)`, then
    // repl-relay.ts enables delegation against it when a relay is named.
    const syncUrl = namedRelayUrl(config, loadFullConfig());
    const sessionRelay = new grantMod.SessionRelays();
    sessionRelay.add(syncUrl);
    if (syncUrl != null) {
      runtime.bindRelay({ syncUrl, authToken, tools: true, invokeCapability: true });
    }
    const { grantId, revocation } = await storeGrant();
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => grantMod.replGrantRelayUrls(sessionRelay, config),
    });
    return {
      present: async () => (await presenter!.presentForTurn()).status,
      pulled: async () => {
        feedCalls = [];
        await presenter!.presentForTurn();
        return feedCalls.map((u) => new URL(u).origin).sort();
      },
      verified: async () => {
        const turn = await presenter!.delegationForTurn();
        if (turn == null) return false;
        const { token, grant, revocations } = turn.delegation;
        return (await verifyGrantForTurn(token, grant, revocations, self())) != null;
      },
      connect: (url) =>
        handleSlashCommand("connect", url, runtime, config, startupConfig, {
          moteDb: {} as never,
          motebitId: ID,
          mcpAdapters: [],
          privateKeyBytes: owner.privateKey,
          deviceId: "dev-f1",
          sessionRelay,
        }),
      relays: () => sessionRelay.urls,
      delegationOrigin: async () => {
        if (!runtime.getToolRegistry().has("delegate_to_agent")) return null;
        taskCalls = [];
        await runtime.getToolRegistry().execute("delegate_to_agent", { prompt: "do it" });
        expect(taskCalls).toHaveLength(1);
        return new URL(taskCalls[0]!).origin;
      },
      revocation,
    };
  }
  const ok =
    (records: unknown[] = []) =>
    (): Response =>
      new Response(JSON.stringify({ records }), { status: 200 });
  const http500 = (): Response => new Response("{}", { status: 500 });

  /** The property, asserted: the delegation relay is pulled, and its revocation refuses. */
  async function expectDelegationRelayGoverns(
    s: Awaited<ReturnType<typeof session>>,
    expectedOrigin: string,
  ): Promise<void> {
    const origin = await s.delegationOrigin();
    expect(origin).toBe(expectedOrigin);
    expect(await s.pulled()).toContain(origin);
    feedAnswer = {};
    expect(await s.verified()).toBe(true);
    // The revocation exists ONLY on the relay delegation submits to.
    feedAnswer = { [origin!]: ok([s.revocation]) };
    expect(await s.present()).toBe("presented");
    expect(await s.verified()).toBe(false);
    // …and that relay failing withholds.
    feedAnswer = { [origin!]: http500 };
    expect(await s.present()).toBe("withheld");
  }

  it("(a) config=A at start, /connect B is refused: the set is unchanged, only A is pulled, delegation still submits to A", async () => {
    const { loadFullConfig } = await import("../config.js");
    const s = await session({ cfg: A });
    expect(s.relays()).toEqual([A]);
    await s.connect(B);
    expect(s.relays()).toEqual([A]);
    expect(loadFullConfig().sync_url).toBe(A);
    expect(await s.pulled()).toEqual([A]);
    await expectDelegationRelayGoverns(s, A);
  });

  it("(b) no relay at start, /connect B, then /connect C is refused: the set is [B], only B is pulled, delegation submits to B", async () => {
    const { loadFullConfig } = await import("../config.js");
    const s = await session();
    expect(await s.delegationOrigin()).toBeNull();
    await s.connect(B);
    await s.connect(C);
    expect(s.relays()).toEqual([B]);
    expect(loadFullConfig().sync_url).toBe(B);
    expect(await s.pulled()).toEqual([B]);
    await expectDelegationRelayGoverns(s, B);
  });

  it("(c) flag=A, no /connect: delegation submits to A, and A is pulled", async () => {
    const s = await session({ flag: A });
    expect(await s.pulled()).toEqual([A]);
    await expectDelegationRelayGoverns(s, A);
  });

  it("(c) env=A, no /connect: delegation submits to A, and A is pulled", async () => {
    const s = await session({ env: A });
    expect(await s.pulled()).toEqual([A]);
    await expectDelegationRelayGoverns(s, A);
  });

  it("no relay at start, /connect B, another process then saves C: both are pulled; B failing withholds while C answers", async () => {
    const { loadFullConfig, saveFullConfig } = await import("../config.js");
    const s = await session();
    await s.connect(B);
    // Another process saves C after the connect: C is asked through the saved
    // config, B only because it entered the session through `/connect`.
    saveFullConfig({ ...loadFullConfig(), sync_url: C });
    expect(await s.pulled()).toEqual([B, C]);
    feedAnswer = { [B]: http500 };
    expect(await s.present()).toBe("withheld");
    await expectDelegationRelayGoverns(s, B);
  });

  it("no relay at start, /connect B: delegation submits to B; B answering 500 withholds", async () => {
    const s = await session();
    expect(await s.present()).toBe("presented");
    expect(feedCalls).toHaveLength(0);
    await s.connect(B);
    feedAnswer = { [B]: http500 };
    feedCalls = [];
    expect(await s.present()).toBe("withheld");
    expect(feedCalls).toEqual([feed(B)]);
    await expectDelegationRelayGoverns(s, B);
  });

  it("no relay at start, /connect B, saved config then removed: B stays in the set (the session keeps it)", async () => {
    const s = await session();
    await s.connect(B);
    // `/connect` also saved B to config. Remove it (as `motebit sync disable`
    // from another shell would): only the session's own record keeps B asked.
    rmSync(join(dir, "config.json"), { force: true });
    expect(await s.pulled()).toEqual([B]);
  });

  it("the relay the saved config names when /connect overwrites it stays in the set", async () => {
    const { loadFullConfig, saveFullConfig } = await import("../config.js");
    const s = await session();
    // Another process saves C after this session started; the REPL's startup
    // config object does not know it. `/connect B` is about to overwrite it.
    saveFullConfig({ ...loadFullConfig(), sync_url: C });
    expect(await s.pulled()).toEqual([C]);
    await s.connect(B);
    expect(loadFullConfig().sync_url).toBe(B);
    expect(await s.pulled()).toEqual([B, C]);
  });

  it("a relay saved to config by another process mid-session is asked on the next turn", async () => {
    const { loadFullConfig, saveFullConfig } = await import("../config.js");
    const s = await session();
    expect(await s.present()).toBe("presented");
    saveFullConfig({ ...loadFullConfig(), sync_url: B });
    feedAnswer = { [B]: http500 };
    feedCalls = [];
    expect(await s.present()).toBe("withheld");
    expect(feedCalls).toEqual([feed(B)]);
  });

  it("SessionRelays only grows: add normalises and de-duplicates, and its view cannot edit it", () => {
    const relays = new grantMod.SessionRelays();
    relays.add(undefined);
    relays.add("  ");
    relays.add(`${A}/`);
    relays.add(A);
    relays.add(B);
    expect(relays.urls).toEqual([A, B]);
    (relays.urls as string[]).length = 0;
    expect(relays.urls).toEqual([A, B]);
  });
});

// The daemon: `daemonGrantRelayUrls` over the REAL `daemonRelay`, which is what
// apps/cli/src/daemon.ts passes as the presenter's `relayUrls`.
describe("revocation pull: serve --direct --grant asks the relay `grant revoke` posts to", () => {
  const C = "https://config-relay.invalid";
  afterEach(() => {
    vi.stubEnv("MOTEBIT_SYNC_URL", ENV_RELAY);
    rmSync(join(dir, "config.json"), { force: true });
  });

  async function daemonSession(
    env: string,
    transport: "stdio" | "http",
    fetchImpl: FakeFetch,
  ): Promise<{ status: string; relay: { syncUrl?: string; intentUrl?: string } }> {
    const { daemonRelay } = await import("../sync-configured.js");
    const { loadFullConfig, saveFullConfig } = await import("../config.js");
    const { parseCliArgs } = await import("../args.js");
    saveFullConfig({ ...loadFullConfig(), sync_url: C });
    vi.stubEnv("MOTEBIT_SYNC_URL", env);
    const config = parseCliArgs([]);
    const relay = daemonRelay(config, loadFullConfig(), transport);
    const { grantId } = await storeGrant();
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => grantMod.daemonGrantRelayUrls(relay, config),
      fetch: fetchImpl,
    });
    return { status: (await presenter!.presentForTurn()).status, relay };
  }

  it('MOTEBIT_SYNC_URL="" + config sync_url: the daemon names no relay, the config relay is still asked, a failed pull withholds', async () => {
    const fetchImpl = json(500, {});
    const out = await daemonSession("", "http", fetchImpl);
    // The pre-existing disagreement this floor covers: the daemon's own
    // resolution yields none, while `grant revoke` posts to the config relay.
    expect(out.relay).toEqual({ syncUrl: undefined, intentUrl: undefined });
    expect(out.status).toBe("withheld");
    expect(fetchImpl.calls).toEqual([`${C}/api/v1/delegations/revocations`]);
  });

  // Today `daemonRelay` derives intentUrl/syncUrl from the same flag/env/config
  // the composer also reads, so they are redundant. They stay as a defence if
  // that ever diverges; these cases isolate each term: a relay NO other source
  // names must still be asked.
  for (const [term, relay, flag] of [
    [
      "relay.intentUrl",
      { intentUrl: "https://intent-only.invalid", syncUrl: undefined },
      undefined,
    ],
    ["relay.syncUrl", { intentUrl: undefined, syncUrl: "https://push-only.invalid" }, undefined],
    [
      "config.syncUrl (the flag)",
      { intentUrl: undefined, syncUrl: undefined },
      "https://flag-only.invalid",
    ],
  ] as Array<
    [string, { intentUrl: string | undefined; syncUrl: string | undefined }, string | undefined]
  >) {
    it(`a relay named only by ${term} is asked, and its failure withholds`, async () => {
      vi.stubEnv("MOTEBIT_SYNC_URL", "");
      rmSync(join(dir, "config.json"), { force: true });
      const only = relay.intentUrl ?? relay.syncUrl ?? flag!;
      const fetchImpl = relayRouter({ [only]: feedStatus(500) });
      const { grantId } = await storeGrant();
      const presenter = await grantMod.createGrantPresenter(grantId, {
        relayUrls: () => grantMod.daemonGrantRelayUrls(relay, { syncUrl: flag }),
        fetch: fetchImpl,
      });
      expect((await presenter!.presentForTurn()).status).toBe("withheld");
      expect(fetchImpl.calls).toEqual([feedUrl(only)]);
    });
  }

  it("stdio serve (pushes to no relay): the named relay is asked once", async () => {
    vi.stubEnv("MOTEBIT_SYNC_URL", "");
    const fetchImpl = json(200, { records: [] });
    const { daemonRelay } = await import("../sync-configured.js");
    const { loadFullConfig, saveFullConfig } = await import("../config.js");
    const { parseCliArgs } = await import("../args.js");
    saveFullConfig({ ...loadFullConfig(), sync_url: C });
    delete process.env["MOTEBIT_SYNC_URL"];
    const config = parseCliArgs([]);
    const relay = daemonRelay(config, loadFullConfig(), "stdio");
    expect(relay.syncUrl).toBeUndefined();
    expect(relay.intentUrl).toBe(C);
    const { grantId } = await storeGrant();
    const presenter = await grantMod.createGrantPresenter(grantId, {
      relayUrls: () => grantMod.daemonGrantRelayUrls(relay, config),
      fetch: fetchImpl,
    });
    expect((await presenter!.presentForTurn()).status).toBe("presented");
    expect(fetchImpl.calls).toEqual([`${C}/api/v1/delegations/revocations`]);
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
  const presenter = await grantMod.createGrantPresenter(grantId, {
    relayUrls: () => [RELAY],
    fetch: fetchImpl,
  });
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
    relayUrls: () => [sessionRelay],
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
