import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { CliConfig } from "../args.js";

// === Mocks ===

vi.mock("../config.js", () => ({
  CONFIG_DIR: "/tmp/motebit-test",
  loadFullConfig: vi.fn().mockReturnValue({
    motebit_id: "test-mote-id",
    device_id: "test-device-id",
    sync_url: "https://relay.test",
  }),
  saveFullConfig: vi.fn(),
}));

vi.mock("../identity.js", () => ({
  fromHex: vi.fn(),
  promptPassphrase: vi.fn().mockResolvedValue("test-passphrase"),
  encryptPrivateKey: vi.fn(),
  decryptPrivateKey: vi.fn(),
  bootstrapIdentity: vi.fn(),
}));

vi.mock("@motebit/encryption", () => ({
  hexPublicKeyToDidKey: vi.fn(),
  verifyVerifiableCredential: vi.fn(),
  verifyVerifiablePresentation: vi.fn(),
  createSignedToken: vi.fn(),
  secureErase: vi.fn(),
  bytesToHex: vi.fn(),
}));

vi.mock("@motebit/persistence", () => ({
  openMotebitDatabase: vi.fn(),
}));

vi.mock("@motebit/event-log", () => ({
  EventStore: vi.fn(),
}));

vi.mock("@motebit/identity-file", () => ({
  generate: vi.fn(),
  verifyIdentityFile: vi.fn(),
  rotate: vi.fn(),
}));

vi.mock("@motebit/core-identity", () => ({
  rotateIdentityKeys: vi.fn(),
}));

vi.mock("../runtime-factory.js", () => ({
  getDbPath: vi.fn().mockReturnValue("/tmp/test.db"),
}));

// Import after mocks
import { handleBalance, handleWithdraw, handleFund, handleDelegate } from "../subcommands/index.js";
import { loadFullConfig } from "../config.js";

// === Test helpers ===

function makeConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    dbPath: undefined,
    noStream: false,
    version: false,
    help: false,
    syncUrl: "https://relay.test",
    syncToken: "test-bearer-token",
    operator: false,
    capability: undefined,
    target: undefined,
    budget: undefined,
    destination: undefined,
    price: undefined,
    plan: false,
    json: false,
    positionals: [],
    identity: undefined,
    direct: false,
    serveTransport: "stdio",
    servePort: undefined,
    tools: undefined,
    selfTest: false,
    routingStrategy: undefined,
    ...overrides,
  } as CliConfig;
}

function mockFetchResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function mockFetchText(text: string, status: number) {
  return Promise.resolve(new Response(text, { status }));
}

let exitSpy: { mockRestore: () => void };
let mockConsoleError: ReturnType<typeof vi.spyOn>;
let mockConsoleLog: ReturnType<typeof vi.spyOn>;
let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // `as never` is required: process.exit returns `never`, which conflicts with vi.spyOn's generic return
  exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: unknown) => {
    throw new Error(`process.exit(${String(code)})`);
  }) as never);
  mockConsoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  mockConsoleLog = vi.spyOn(console, "log").mockImplementation(() => {});
  mockFetch = vi.fn();
  vi.stubGlobal("fetch", mockFetch);
});

afterEach(() => {
  exitSpy.mockRestore();
  mockConsoleError.mockRestore();
  mockConsoleLog.mockRestore();
  vi.unstubAllGlobals();
});

// ============================================================
// handleBalance
// ============================================================

describe("handleBalance", () => {
  it("displays balance and recent transactions", async () => {
    mockFetch.mockReturnValueOnce(
      mockFetchResponse({
        balance: 42.5,
        currency: "USD",
        transactions: [
          { type: "deposit", amount: 50, created_at: new Date().toISOString() },
          { type: "task_payment", amount: -7.5, created_at: new Date().toISOString() },
        ],
      }),
    );

    await handleBalance(makeConfig({ positionals: ["balance"] }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0]![0] as string;
    expect(url).toContain("/api/v1/agents/test-mote-id/balance");
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("$42.50"));
  });

  it("outputs JSON when --json flag is set", async () => {
    const data = { balance: 10, currency: "USD", transactions: [] };
    mockFetch.mockReturnValueOnce(mockFetchResponse(data));

    await handleBalance(makeConfig({ positionals: ["balance"], json: true }));

    expect(mockConsoleLog).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
  });

  it("exits with error when no identity exists", async () => {
    (loadFullConfig as ReturnType<typeof vi.fn>).mockReturnValueOnce({});

    await expect(handleBalance(makeConfig({ positionals: ["balance"] }))).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("no motebit identity"));
  });

  it("exits with error on relay failure", async () => {
    mockFetch.mockReturnValueOnce(mockFetchText("internal error", 500));

    await expect(handleBalance(makeConfig({ positionals: ["balance"] }))).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Failed to get balance"));
  });

  it("exits with error on network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(handleBalance(makeConfig({ positionals: ["balance"] }))).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Failed to get balance"));
  });

  it("handles missing transactions array gracefully", async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse({ balance: 5, currency: "USD" }));

    await handleBalance(makeConfig({ positionals: ["balance"] }));
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("$5.00"));
  });
});

// ============================================================
// handleWithdraw
// ============================================================

describe("handleWithdraw", () => {
  it("submits withdrawal and displays confirmation", async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse({ withdrawal_id: "wd-123" }));

    await handleWithdraw(makeConfig({ positionals: ["withdraw", "10"] }));

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url as string).toContain("/api/v1/agents/test-mote-id/withdraw");
    expect((opts as RequestInit).method).toBe("POST");
    const body = JSON.parse((opts as RequestInit).body as string) as { amount: number };
    expect(body.amount).toBe(10);
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("$10.00"));
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("wd-123"));
  });

  it("includes destination when provided", async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse({}));

    await handleWithdraw(makeConfig({ positionals: ["withdraw", "5"], destination: "0xabc" }));

    const body = JSON.parse((mockFetch.mock.calls[0]![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body.destination).toBe("0xabc");
  });

  it("exits with error when no amount provided", async () => {
    await expect(handleWithdraw(makeConfig({ positionals: ["withdraw"] }))).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  it("exits with error for non-positive amount", async () => {
    await expect(handleWithdraw(makeConfig({ positionals: ["withdraw", "0"] }))).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("positive number"));
  });

  it("exits with error for non-numeric amount", async () => {
    await expect(handleWithdraw(makeConfig({ positionals: ["withdraw", "abc"] }))).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("positive number"));
  });

  it("detects HTTP 402 as insufficient balance", async () => {
    mockFetch.mockReturnValueOnce(mockFetchText("", 402));

    await expect(handleWithdraw(makeConfig({ positionals: ["withdraw", "1000"] }))).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockConsoleError).toHaveBeenCalledWith("Insufficient balance.");
  });

  it("reports relay error with status code", async () => {
    mockFetch.mockReturnValueOnce(mockFetchText("bad request", 400));

    await expect(handleWithdraw(makeConfig({ positionals: ["withdraw", "5"] }))).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("400"));
  });

  it("reports network failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(handleWithdraw(makeConfig({ positionals: ["withdraw", "5"] }))).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("could not reach relay"));
  });

  it("sends idempotency key header", async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse({}));

    await handleWithdraw(makeConfig({ positionals: ["withdraw", "5"] }));

    const headers = (mockFetch.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toBeDefined();
  });
});

// ============================================================
// handleFund
// ============================================================

describe("handleFund", () => {
  it("creates checkout session and opens URL", { timeout: 15_000 }, async () => {
    // Checkout creation
    mockFetch.mockReturnValueOnce(
      mockFetchResponse({
        checkout_url: "https://checkout.stripe.com/test",
        session_id: "sess-123",
      }),
    );
    // Balance poll — simulate immediate confirmation
    mockFetch.mockReturnValueOnce(mockFetchResponse({ balance: 10 })); // startBalance
    mockFetch.mockReturnValueOnce(mockFetchResponse({ balance: 20 })); // after deposit

    await handleFund(makeConfig({ positionals: ["fund", "10"] }));

    const [url, opts] = mockFetch.mock.calls[0]!;
    expect(url as string).toContain("/checkout");
    expect((opts as RequestInit).method).toBe("POST");
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("checkout.stripe.com"));
  });

  it("exits with error when no amount provided", async () => {
    await expect(handleFund(makeConfig({ positionals: ["fund"] }))).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  it("exits with error for amount below minimum ($0.50)", async () => {
    await expect(handleFund(makeConfig({ positionals: ["fund", "0.10"] }))).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining("minimum amount is $0.50"),
    );
  });

  it("exits with error on checkout creation failure", async () => {
    mockFetch.mockReturnValueOnce(mockFetchText("stripe error", 500));

    await expect(handleFund(makeConfig({ positionals: ["fund", "5"] }))).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Checkout failed"));
  });

  it("exits with error on network failure during checkout", async () => {
    mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    await expect(handleFund(makeConfig({ positionals: ["fund", "5"] }))).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("could not reach relay"));
  });
});

// ============================================================
// handleDelegate
// ============================================================

describe("handleDelegate", () => {
  it("discovers agent, submits task, and polls for result", { timeout: 15_000 }, async () => {
    // Discovery
    mockFetch.mockReturnValueOnce(
      mockFetchResponse({
        candidates: [{ motebit_id: "worker-1", composite: 0.85, selected: true }],
      }),
    );
    // Task submission
    mockFetch.mockReturnValueOnce(mockFetchResponse({ task_id: "task-123" }));
    // Poll — completed on first try
    mockFetch.mockReturnValueOnce(
      mockFetchResponse({
        task: { status: "completed" },
        receipt: {
          status: "completed",
          result: "The answer is 42.",
          motebit_id: "worker-1",
        },
      }),
    );

    await handleDelegate(makeConfig({ positionals: ["delegate", "What is the meaning of life?"] }));

    // Discovery call
    const discoveryUrl = mockFetch.mock.calls[0]![0] as string;
    expect(discoveryUrl).toContain("/api/v1/market/candidates");

    // Submission call
    const submitUrl = mockFetch.mock.calls[1]![0] as string;
    expect(submitUrl).toContain("/agent/worker-1/task");

    // Result displayed
    expect(mockConsoleLog).toHaveBeenCalledWith(expect.stringContaining("42"));
  });

  it("exits with error when no prompt provided", async () => {
    await expect(handleDelegate(makeConfig({ positionals: ["delegate"] }))).rejects.toThrow(
      "process.exit(1)",
    );
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Usage"));
  });

  it("uses --target to skip discovery", { timeout: 15_000 }, async () => {
    // Task submission (no discovery)
    mockFetch.mockReturnValueOnce(mockFetchResponse({ task_id: "task-456" }));
    // Poll
    mockFetch.mockReturnValueOnce(
      mockFetchResponse({
        task: { status: "completed" },
        receipt: { status: "completed", result: "Done.", motebit_id: "target-1" },
      }),
    );

    await handleDelegate(
      makeConfig({
        positionals: ["delegate", "Do something"],
        target: "target-1",
      }),
    );

    // First call should be task submission, not discovery
    const firstUrl = mockFetch.mock.calls[0]![0] as string;
    expect(firstUrl).toContain("/agent/target-1/task");
    expect(firstUrl).not.toContain("candidates");
  });

  it("detects HTTP 402 as insufficient balance", async () => {
    // Discovery
    mockFetch.mockReturnValueOnce(
      mockFetchResponse({
        candidates: [{ motebit_id: "worker-1", composite: 0.85, selected: true }],
      }),
    );
    // Task submission — 402
    mockFetch.mockReturnValueOnce(mockFetchText("", 402));

    await expect(
      handleDelegate(makeConfig({ positionals: ["delegate", "test prompt"] })),
    ).rejects.toThrow("process.exit(1)");
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("Insufficient balance"));
  });

  it("exits when no agents found for capability", async () => {
    mockFetch.mockReturnValueOnce(mockFetchResponse({ candidates: [] }));

    await expect(
      handleDelegate(makeConfig({ positionals: ["delegate", "test"], capability: "rare_skill" })),
    ).rejects.toThrow("process.exit(1)");
    expect(mockConsoleError).toHaveBeenCalledWith(expect.stringContaining("No agents found"));
  });

  it("passes --capability and --budget to discovery", { timeout: 15_000 }, async () => {
    mockFetch.mockReturnValueOnce(
      mockFetchResponse({ candidates: [{ motebit_id: "w-1", selected: true }] }),
    );
    mockFetch.mockReturnValueOnce(mockFetchResponse({ task_id: "t-1" }));
    mockFetch.mockReturnValueOnce(
      mockFetchResponse({
        task: { status: "completed" },
        receipt: { status: "completed", result: "ok", motebit_id: "w-1" },
      }),
    );

    await handleDelegate(
      makeConfig({
        positionals: ["delegate", "test"],
        capability: "code_review",
        budget: "5.00",
      }),
    );

    const discoveryUrl = mockFetch.mock.calls[0]![0] as string;
    expect(discoveryUrl).toContain("capability=code_review");
    expect(discoveryUrl).toContain("max_budget=5");
  });

  it("reports discovery failure", async () => {
    mockFetch.mockReturnValueOnce(mockFetchText("server error", 500));

    await expect(handleDelegate(makeConfig({ positionals: ["delegate", "test"] }))).rejects.toThrow(
      "process.exit(1)",
    );
  });
});
