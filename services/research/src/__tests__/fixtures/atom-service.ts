/**
 * Test fixture: spin up real web-search + read-url atom MCP servers with
 * real Ed25519 keypairs for the research molecule to delegate into.
 *
 * Kept local to services/research (mirrors services/read-url and
 * services/code-review fixtures). The fixture is the thinnest possible
 * wrapper around @motebit/mcp-server's already-shared primitives
 * (`buildServiceReceipt`, `McpServerAdapter`).
 *
 * embed and proxy are skipped — they are utility services that do not sign
 * receipts and have no signed-receipt E2E to write.
 */

import { MotebitRuntime, NullRenderer, createInMemoryStorage } from "@motebit/runtime";
import { InMemoryToolRegistry, webSearchDefinition, readUrlDefinition } from "@motebit/tools";
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

export interface AtomOptions {
  kind: "web-search" | "read-url";
  motebitId: string;
  deviceId: string;
  port: number;
  authToken?: string;
  /** Handler response for the atom's one tool. */
  handler: (args: Record<string, unknown>) => ToolResult;
  /** Motebit-signed-token callers this atom trusts. Required when McpClientAdapter uses `motebit: true`. */
  knownCallers?: Map<string, { publicKey: string; trustLevel: AgentTrustLevel }>;
}

const DEFAULT_TOKEN = "test-atom-token";

/**
 * Start a real atom MCP server. `kind` picks the tool (web-search or read-url);
 * the signing path, identity wiring, and caller verification are identical.
 */
export async function startAtom(opts: AtomOptions): Promise<AtomFixture> {
  const keypair = await generateKeypair();
  const publicKeyHex = bytesToHex(keypair.publicKey);
  const authToken = opts.authToken ?? DEFAULT_TOKEN;

  const toolName = opts.kind === "web-search" ? "web_search" : "read_url";
  const capability = opts.kind === "web-search" ? "web_search" : "read_url";
  const definition = opts.kind === "web-search" ? webSearchDefinition : readUrlDefinition;

  const identityContent = await generateIdentity(
    {
      motebitId: opts.motebitId,
      ownerId: "test-owner",
      publicKeyHex,
      service: {
        type: "service",
        service_name: `${opts.kind}-atom`,
        service_description: `${opts.kind} atom fixture`,
        capabilities: [capability],
      },
    },
    keypair.privateKey,
  );

  const registry = new InMemoryToolRegistry();
  registry.register(definition, async (args: Record<string, unknown>) => opts.handler(args));

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
      const toolArgs = opts.kind === "web-search" ? { query: prompt } : { url: prompt };
      let result: ToolResult;
      try {
        result = await runtime.getToolRegistry().execute(toolName, toolArgs);
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
        toolsUsed: [toolName],
        relayTaskId: options?.relayTaskId,
        delegatedScope: options?.delegatedScope,
      });
      yield { type: "task_result" as const, receipt: signed as unknown as Record<string, unknown> };
    },
  };

  const server = new McpServerAdapter(
    {
      name: `${opts.kind}-atom-${opts.motebitId.slice(0, 8)}`,
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
