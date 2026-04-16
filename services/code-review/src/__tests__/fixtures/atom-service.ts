/**
 * Test fixture: spin up a real read-url atom MCP server with a real keypair
 * for the code-review molecule to delegate into.
 *
 * Kept local to services/code-review (mirrors services/read-url/src/__tests__
 * /fixtures/atom-service.ts). We duplicate the ~120 lines rather than create
 * a cross-service helper package because (a) test code, (b) test fixtures
 * should stay easy to evolve per consumer, and (c) the fixture is the
 * thinnest possible wrapper around @motebit/mcp-server's already-shared
 * primitives (buildServiceReceipt, McpServerAdapter).
 *
 * embed and proxy are skipped — they are utility services that do not sign
 * receipts and therefore have no signed-receipt E2E to write.
 */

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import { InMemoryToolRegistry, readUrlDefinition } from "@motebit/tools";
import { McpServerAdapter, buildServiceReceipt } from "@motebit/mcp-server";
import type { MotebitServerDeps } from "@motebit/mcp-server";
import { generateKeypair, bytesToHex, verifySignedToken } from "@motebit/encryption";
import type { KeyPair } from "@motebit/encryption";
import { generate as generateIdentity } from "@motebit/identity-file";
import type { ToolResult } from "@motebit/sdk";
import { AgentTrustLevel } from "@motebit/sdk";

export interface AtomFixture {
  server: McpServerAdapter;
  runtime: MotebitRuntime;
  keypair: KeyPair;
  motebitId: string;
  deviceId: string;
  publicKeyHex: string;
  port: number;
  authToken: string;
  url: string;
  stop(): Promise<void>;
}

export interface ReadUrlAtomOptions {
  motebitId: string;
  deviceId: string;
  port: number;
  authToken?: string;
  readUrlResponse: (url: string) => ToolResult;
  /**
   * Motebit-signed-token callers this atom trusts. Required when the consumer
   * uses `McpClientAdapter({ motebit: true })` — the client sends a
   * `motebit:<signed-token>` bearer and the atom verifies against this map.
   */
  knownCallers?: Map<string, { publicKey: string; trustLevel: AgentTrustLevel }>;
}

const DEFAULT_TOKEN = "test-atom-token";

/** Start a real read-url atom MCP server backed by a caller-provided handler. */
export async function startReadUrlAtom(opts: ReadUrlAtomOptions): Promise<AtomFixture> {
  const keypair = await generateKeypair();
  const publicKeyHex = bytesToHex(keypair.publicKey);
  const authToken = opts.authToken ?? DEFAULT_TOKEN;

  const identityContent = await generateIdentity(
    {
      motebitId: opts.motebitId,
      ownerId: "test-owner",
      publicKeyHex,
      service: {
        type: "service",
        service_name: "read-url-atom",
        service_description: "read-url atom fixture",
        capabilities: ["read_url"],
      },
    },
    keypair.privateKey,
  );

  const registry = new InMemoryToolRegistry();
  registry.register(readUrlDefinition, async (args: Record<string, unknown>) =>
    opts.readUrlResponse(args["url"] as string),
  );

  const runtime = new MotebitRuntime(
    { motebitId: opts.motebitId },
    { storage: createInMemoryStorage(), renderer: new NullRenderer(), tools: registry },
  );
  await runtime.init();

  const deps: MotebitServerDeps = {
    motebitId: opts.motebitId,
    publicKeyHex,
    listTools: () => runtime.getToolRegistry().list(),
    filterTools: (tools) => runtime.policy.filterTools(tools),
    validateTool: () => ({ allowed: true, requiresApproval: false }),
    executeTool: (name, args) => runtime.getToolRegistry().execute(name, args),
    getState: () => runtime.getState() as unknown as Record<string, unknown>,
    getMemories: async () => [],
    logToolCall: () => {},
    verifySignedToken: async (token, pk) => verifySignedToken(token, pk),
    identityFileContent: identityContent,
    handleAgentTask: async function* (
      prompt: string,
      options?: { relayTaskId?: string; delegatedScope?: string },
    ) {
      const taskId = crypto.randomUUID();
      const submittedAt = Date.now();
      let result: ToolResult;
      try {
        result = await runtime.getToolRegistry().execute("read_url", { url: prompt });
      } catch (err: unknown) {
        result = { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
      const resultStr = result.ok
        ? typeof result.data === "string"
          ? result.data
          : JSON.stringify(result.data ?? null)
        : (result.error ?? "error");
      const signed = await buildServiceReceipt({
        motebitId: opts.motebitId,
        deviceId: opts.deviceId,
        privateKey: keypair.privateKey,
        publicKey: keypair.publicKey,
        prompt,
        taskId,
        submittedAt,
        result: resultStr,
        ok: result.ok,
        toolsUsed: ["read_url"],
        relayTaskId: options?.relayTaskId,
        delegatedScope: options?.delegatedScope,
      });
      yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
    },
  };

  const server = new McpServerAdapter(
    {
      name: `read-url-atom-${opts.motebitId.slice(0, 8)}`,
      transport: "http",
      port: opts.port,
      motebitType: "service",
      authToken,
      knownCallers: opts.knownCallers,
    },
    deps,
  );
  await server.start();

  return {
    server,
    runtime,
    keypair,
    motebitId: opts.motebitId,
    deviceId: opts.deviceId,
    publicKeyHex,
    port: opts.port,
    authToken,
    url: `http://localhost:${opts.port}/mcp`,
    async stop(): Promise<void> {
      try {
        await server.stop();
      } catch {
        /* ignore */
      }
      try {
        runtime.stop();
      } catch {
        /* ignore */
      }
    },
  };
}
