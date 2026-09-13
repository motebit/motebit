import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockCreate = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(function () {
    return { messages: { create: mockCreate } };
  }),
}));

// Capture constructor args for the default McpClientAdapter factory — lets us
// verify that when no adapterFactory is injected, reviewPrViaMotebit wires up
// a real McpClientAdapter instance with this service's identity.
const mcpConstructorCalls: Array<Record<string, unknown>> = [];
vi.mock("@motebit/mcp-client", () => ({
  McpClientAdapter: class MockMcpClientAdapter {
    constructor(config: Record<string, unknown>) {
      mcpConstructorCalls.push(config);
    }
    async connect() {}
    async disconnect() {}
    async executeTool() {
      return { ok: false, error: "not stubbed" };
    }
    getAndResetDelegationReceipts() {
      return [];
    }
  },
}));

import type { AdapterFactory, AtomAdapter, ReviewConfig } from "../review-via-motebit.js";
import { parsePatch, reviewPrViaMotebit } from "../review-via-motebit.js";
import type { ExecutionReceipt } from "@motebit/sdk";

/**
 * Stub adapter — the injectable test seam. Mirrors `McpClientAdapter`'s
 * contract without spinning up an MCP server.
 */
class StubAtomAdapter implements AtomAdapter {
  private pending: ExecutionReceipt[] = [];
  public connected = 0;
  public disconnected = 0;
  public calls: { qualified: string; args: Record<string, unknown> }[] = [];

  constructor(private readonly queue: ExecutionReceipt[]) {}

  async connect(): Promise<void> {
    this.connected++;
  }

  async disconnect(): Promise<void> {
    this.disconnected++;
  }

  async executeTool(qualified: string, args: Record<string, unknown>) {
    this.calls.push({ qualified, args });
    if (this.queue.length > 0) {
      const receipt = this.queue.shift()!;
      this.pending.push(receipt);
      return { ok: true, data: JSON.stringify(receipt) };
    }
    return { ok: false, error: "no receipt queued" };
  }

  getAndResetDelegationReceipts(): ExecutionReceipt[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }
}

function makeFactory(adapter: StubAtomAdapter): AdapterFactory {
  return ({ name }) => {
    if (name !== "read-url") throw new Error(`unexpected atom: ${name}`);
    return adapter;
  };
}

function makeReceipt(
  overrides: Partial<ExecutionReceipt> & { result: string; signature: string },
): ExecutionReceipt {
  return {
    task_id: "task-stub",
    motebit_id: "mote-read-url",
    device_id: "read-url-service",
    submitted_at: 0,
    completed_at: Date.now(),
    status: "completed",
    tools_used: ["read_url"],
    memories_formed: 0,
    prompt_hash: "",
    result_hash: "",
    ...overrides,
  } as ExecutionReceipt;
}

const baseConfig: ReviewConfig = {
  anthropicApiKey: "sk-ant-test",
  readUrlUrl: "http://read-url.test/mcp",
  callerMotebitId: "motebit-code-review",
  callerDeviceId: "code-review-service",
  callerPrivateKey: new Uint8Array(32),
};

const SAMPLE_PATCH = [
  "From abc123def456",
  "From: Alice Example <alice@example.com>",
  "Date: Mon, 14 Apr 2026 10:00:00 +0000",
  "Subject: [PATCH] Add sovereign settlement",
  "",
  "diff --git a/foo.ts b/foo.ts",
  "@@ -1,3 +1,4 @@",
  " existing line",
  "+new line",
  " existing line",
].join("\n");

describe("parsePatch", () => {
  it("extracts title from Subject header (stripping [PATCH] tag)", () => {
    expect(parsePatch(SAMPLE_PATCH).title).toBe("Add sovereign settlement");
  });

  it("extracts author name from From header", () => {
    expect(parsePatch(SAMPLE_PATCH).author).toBe("Alice Example");
  });

  it("extracts the diff block starting at the first `diff --git` marker", () => {
    const { diff } = parsePatch(SAMPLE_PATCH);
    expect(diff.startsWith("diff --git a/foo.ts")).toBe(true);
    expect(diff).toContain("+new line");
    // Header metadata should not appear in the diff body
    expect(diff).not.toContain("Subject:");
    expect(diff).not.toContain("From:");
  });

  it("falls back to defaults when headers are missing", () => {
    const pr = parsePatch("no headers, just text");
    expect(pr.title).toBe("(untitled PR)");
    expect(pr.author).toBe("unknown");
  });

  it("truncates diffs larger than 80KB", () => {
    const big = "From: a\nSubject: big\n\ndiff --git a/x b/x\n" + "+".repeat(100_000);
    const pr = parsePatch(big);
    expect(pr.diff).toContain("[... diff truncated ...]");
    expect(pr.diff.length).toBeLessThan(100_000);
  });
});

describe("reviewPrViaMotebit — delegation chain", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mcpConstructorCalls.length = 0;
  });

  it("delegates fetch to read-url, accumulates its receipt, and returns the chain", async () => {
    const receipt = makeReceipt({
      task_id: "read-url-1",
      motebit_id: "mote-read-url",
      result: SAMPLE_PATCH,
      signature: "sig-ru-1",
    });
    const readUrl = new StubAtomAdapter([receipt]);
    mockCreate.mockResolvedValueOnce({
      content: [{ type: "text", text: "## Verdict: APPROVE" }],
    });

    const result = await reviewPrViaMotebit("https://github.com/foo/bar/pull/7", {
      ...baseConfig,
      adapterFactory: makeFactory(readUrl),
    });

    expect(result.review).toBe("## Verdict: APPROVE");
    expect(result.pr.title).toBe("Add sovereign settlement");
    expect(result.pr.author).toBe("Alice Example");
    expect(result.delegation_receipts).toHaveLength(1);
    expect(result.delegation_receipts[0]!.signature).toBe("sig-ru-1");
    expect(readUrl.connected).toBe(1);
    expect(readUrl.disconnected).toBe(1);
  });

  it("requests the .patch URL (mbox format — has author/subject headers + diff)", async () => {
    const readUrl = new StubAtomAdapter([
      makeReceipt({ result: SAMPLE_PATCH, signature: "sig-1" }),
    ]);
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });

    await reviewPrViaMotebit("https://github.com/foo/bar/pull/7", {
      ...baseConfig,
      adapterFactory: makeFactory(readUrl),
    });

    expect(readUrl.calls).toHaveLength(1);
    expect(readUrl.calls[0]!.qualified).toBe("read-url__motebit_task");
    expect(readUrl.calls[0]!.args["prompt"]).toBe("https://github.com/foo/bar/pull/7.patch");
  });

  it("strips a trailing slash before appending .patch", async () => {
    const readUrl = new StubAtomAdapter([
      makeReceipt({ result: SAMPLE_PATCH, signature: "sig-1" }),
    ]);
    mockCreate.mockResolvedValueOnce({ content: [{ type: "text", text: "ok" }] });

    await reviewPrViaMotebit("https://github.com/foo/bar/pull/7/", {
      ...baseConfig,
      adapterFactory: makeFactory(readUrl),
    });

    expect(readUrl.calls[0]!.args["prompt"]).toBe("https://github.com/foo/bar/pull/7.patch");
  });

  it("disconnects the adapter even when the read-url call errors", async () => {
    const readUrl = new StubAtomAdapter([]); // empty queue → returns error
    await expect(
      reviewPrViaMotebit("https://github.com/foo/bar/pull/7", {
        ...baseConfig,
        adapterFactory: makeFactory(readUrl),
      }),
    ).rejects.toThrow(/no receipt/);
    expect(readUrl.disconnected).toBe(1);
  });

  it("error message omits trailing detail when the adapter result has no error string", async () => {
    // Adapter returns ok=false with no error field — defensive branch in the
    // error-message constructor (the ternary at the call site).
    class SilentFailureAdapter implements AtomAdapter {
      public connected = 0;
      public disconnected = 0;
      async connect() {
        this.connected++;
      }
      async disconnect() {
        this.disconnected++;
      }
      async executeTool() {
        return { ok: false };
      }
      getAndResetDelegationReceipts() {
        return [];
      }
    }
    const adapter = new SilentFailureAdapter();
    await expect(
      reviewPrViaMotebit("https://github.com/foo/bar/pull/7", {
        ...baseConfig,
        adapterFactory: () => adapter,
      }),
    ).rejects.toThrow(
      "Delegated fetch of https://github.com/foo/bar/pull/7.patch returned no receipt",
    );
  });

  it("throws when the receipt's result is non-string (no patch text to parse)", async () => {
    // executeTool returns ok with a queued receipt, but the receipt's `result`
    // field is an object instead of a string — defensive branch for any atom
    // that returns structured payloads instead of plain text.
    const receipt = makeReceipt({
      // The makeReceipt helper requires `result: string`, so cast around it
      // to set a non-string value for this defensive branch.
      result: "" as unknown as string,
      signature: "sig-1",
    });
    (receipt as { result: unknown }).result = { kind: "object" };
    const readUrl = new StubAtomAdapter([receipt]);

    await expect(
      reviewPrViaMotebit("https://github.com/foo/bar/pull/7", {
        ...baseConfig,
        adapterFactory: makeFactory(readUrl),
      }),
    ).rejects.toThrow(/no patch text/);
  });

  it("fails fast on private repo signal (HTTP 404/401 in receipt result)", async () => {
    const readUrl = new StubAtomAdapter([
      makeReceipt({ result: "HTTP 404: Not Found", signature: "sig-1" }),
    ]);
    await expect(
      reviewPrViaMotebit("https://github.com/secret/repo/pull/1", {
        ...baseConfig,
        adapterFactory: makeFactory(readUrl),
      }),
    ).rejects.toThrow(/private repos are not yet supported/);
  });

  it("defaults to a real McpClientAdapter wired with caller identity when no factory injected", async () => {
    const privateKey = new Uint8Array([1, 2, 3]);
    // Adapter will fail (no real server), but we only inspect the constructor
    // args — that's the contract under test.
    await expect(
      reviewPrViaMotebit("https://github.com/foo/bar/pull/7", {
        ...baseConfig,
        callerPrivateKey: privateKey,
      }),
    ).rejects.toThrow();
    expect(mcpConstructorCalls).toHaveLength(1);
    expect(mcpConstructorCalls[0]).toMatchObject({
      name: "read-url",
      transport: "http",
      url: "http://read-url.test/mcp",
      motebit: true,
      motebitType: "service",
      callerMotebitId: "motebit-code-review",
      callerDeviceId: "code-review-service",
      callerPrivateKey: privateKey,
    });
  });
});

describe("relay binding — code-review presents the read-url hop itself", () => {
  const baseCfg = {
    anthropicApiKey: "k",
    readUrlUrl: "http://read-url.test/mcp",
    callerMotebitId: "code-review-mote",
    callerDeviceId: "cr-dev",
    callerPrivateKey: new Uint8Array(32),
    syncUrl: "http://relay.test",
    readUrlTargetId: "read-url-mote",
    mintRelayToken: async () => "signed.task:submit",
  };
  let originalFetch: typeof fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockCreate.mockResolvedValue({ content: [{ type: "text", text: "LGTM" }] });
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("opens the relay task as the one presenter and forwards relay_task_id + dispatch_token", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(JSON.stringify({ task_id: "rt-1", dispatch_token: "disp.tok" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const readUrl = new StubAtomAdapter([
      makeReceipt({ result: SAMPLE_PATCH, signature: "sig-1" }),
    ]);
    await reviewPrViaMotebit("https://github.com/o/r/pull/1", {
      ...baseCfg,
      adapterFactory: makeFactory(readUrl),
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    if (init == null) throw new Error("relay call had no init");
    expect(url).toBe("http://relay.test/agent/read-url-mote/task");
    const body = JSON.parse(init.body as string);
    expect(body.presenter).toBe("submitter");
    expect(body.required_capabilities).toEqual(["read_url"]);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer signed.task:submit",
    );
    expect(readUrl.calls[0]!.args.relay_task_id).toBe("rt-1");
    expect(readUrl.calls[0]!.args.dispatch_token).toBe("disp.tok");
  });

  it("falls back to the direct call LOUDLY only for the named blocker (unpaid priced atom)", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "TASK_P2P_PROOF_REQUIRED", error: "pay first" }), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const logs: string[] = [];
    const readUrl = new StubAtomAdapter([
      makeReceipt({ result: SAMPLE_PATCH, signature: "sig-1" }),
    ]);
    await reviewPrViaMotebit("https://github.com/o/r/pull/1", {
      ...baseCfg,
      adapterFactory: makeFactory(readUrl),
      log: (m) => logs.push(m),
    });
    expect(readUrl.calls).toHaveLength(1);
    expect(readUrl.calls[0]!.args).not.toHaveProperty("dispatch_token");
    expect(logs.join("\n")).toContain("NOT admitted");
    expect(logs.join("\n")).toContain("no payer seam");
  });

  it("forwards relay_task_id alone when an older relay returns no dispatch_token", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ task_id: "rt-old" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const readUrl = new StubAtomAdapter([
      makeReceipt({ result: SAMPLE_PATCH, signature: "sig-1" }),
    ]);
    await reviewPrViaMotebit("https://github.com/o/r/pull/1", {
      ...baseCfg,
      adapterFactory: makeFactory(readUrl),
    });
    expect(readUrl.calls[0]!.args.relay_task_id).toBe("rt-old");
    expect(readUrl.calls[0]!.args).not.toHaveProperty("dispatch_token");
  });

  it("the named-blocker fallback is loud on the default logger too (console)", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "TASK_P2P_PROOF_REQUIRED" }), {
          status: 402,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const readUrl = new StubAtomAdapter([
        makeReceipt({ result: SAMPLE_PATCH, signature: "sig-1" }),
      ]);
      await reviewPrViaMotebit("https://github.com/o/r/pull/1", {
        ...baseCfg,
        adapterFactory: makeFactory(readUrl),
      });
      expect(spy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("NOT admitted");
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses to run the hop free on any other relay refusal", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("nope", { status: 401 }),
    ) as unknown as typeof fetch;
    const readUrl = new StubAtomAdapter([
      makeReceipt({ result: SAMPLE_PATCH, signature: "sig-1" }),
    ]);
    await expect(
      reviewPrViaMotebit("https://github.com/o/r/pull/1", {
        ...baseCfg,
        adapterFactory: makeFactory(readUrl),
        log: () => {},
      }),
    ).rejects.toThrow(/not admitted by the relay/);
    expect(readUrl.calls).toHaveLength(0);
  });

  it("calls read-url directly when no relay binding is configured (dev)", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const readUrl = new StubAtomAdapter([
      makeReceipt({ result: SAMPLE_PATCH, signature: "sig-1" }),
    ]);
    const { syncUrl: _s, readUrlTargetId: _t, mintRelayToken: _m, ...noRelay } = baseCfg;
    await reviewPrViaMotebit("https://github.com/o/r/pull/1", {
      ...noRelay,
      adapterFactory: makeFactory(readUrl),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readUrl.calls[0]!.args).toEqual({ prompt: "https://github.com/o/r/pull/1.patch" });
  });
});
