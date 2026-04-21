/**
 * Motebit Read-URL Service (Charlie)
 *
 * A minimal tool server exposing only read_url via MCP. Used as the
 * second hop in multi-hop delegation: Alice → Bob → Charlie.
 *
 * ### Identity lifecycle
 *
 * The service self-bootstraps its motebit identity on first boot via
 * `runMolecule()` from `@motebit/molecule-runner`, which composes
 * `bootstrapAndEmitIdentity` + database open + runtime init + MCP
 * server start. Same shared protocol every other surface
 * (desktop/mobile/web/spatial/cli) uses, just with filesystem-backed
 * storage targeting the data dir.
 *
 * First boot under a fresh Fly volume:
 *   1. `/data/motebit.json` doesn't exist → bootstrap generates a
 *      fresh Ed25519 keypair, creates a motebit_id, persists both
 *   2. `/data/motebit.md` is written as a signed canonical identity
 *      file for inbound callers that want to verify our identity
 *
 * Every subsequent boot:
 *   1. `/data/motebit.json` + `/data/motebit.key` already exist → reload
 *   2. `/data/motebit.md` is regenerated with a fresh `created_at`
 *      timestamp but the same motebit_id / keypair
 *
 * The volume is the persistence layer. Losing it = losing this agent's
 * accumulated trust. Fly volume snapshots are the backup primitive —
 * same as any persistent-state service.
 */

import { buildServiceReceipt, runMolecule } from "@motebit/molecule-runner";
import { InMemoryToolRegistry, readUrlDefinition, createReadUrlHandler } from "@motebit/tools";
import { loadConfig } from "./helpers.js";

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

async function main(): Promise<void> {
  const config = loadConfig();

  const handle = await runMolecule(
    {
      dataDir: config.dataDir,
      dbPath: config.dbPath,
      port: config.port,
      serviceName: "motebit-read-url",
      displayName: "Read URL",
      serviceDescription: "Minimal URL reader (second hop in multi-hop delegation proof)",
      capabilities: ["read_url"],
      ...(config.authToken != null ? { authToken: config.authToken } : {}),
      ...(config.syncUrl != null ? { syncUrl: config.syncUrl } : {}),
      ...(config.apiToken != null ? { apiToken: config.apiToken } : {}),
      ...(config.publicUrl != null ? { publicUrl: config.publicUrl } : {}),
    },
    (identity) => {
      const { motebitId, deviceId, publicKey, privateKey } = identity;

      const registry = new InMemoryToolRegistry();
      registry.register(readUrlDefinition, createReadUrlHandler());

      const handleAgentTask = async function* (
        prompt: string,
        options?: { delegatedScope?: string; relayTaskId?: string },
      ) {
        const taskId = crypto.randomUUID();
        const submittedAt = Date.now();

        let result: { ok: boolean; data?: unknown; error?: string };
        try {
          result = await registry.execute("read_url", { url: prompt });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          result = { ok: false, error: msg };
        }
        const completedAt = Date.now();

        const resultStr = result.ok
          ? typeof result.data === "string"
            ? result.data
            : JSON.stringify(result.data ?? null)
          : (result.error ?? "error");
        const signed = await buildServiceReceipt({
          motebitId,
          deviceId,
          privateKey,
          publicKey,
          prompt,
          taskId,
          submittedAt,
          completedAt,
          result: resultStr,
          ok: result.ok,
          toolsUsed: ["read_url"],
          relayTaskId: options?.relayTaskId,
          delegatedScope: options?.delegatedScope,
        });
        log(`receipt=${signed.signature.slice(0, 12)}… url="${prompt.slice(0, 60)}"`);
        yield {
          type: "task_result" as const,
          receipt: signed as unknown as Record<string, unknown>,
        };
      };

      return { toolRegistry: registry, handleAgentTask };
    },
  );

  // Keep the handle in scope so the server's process-signal handlers
  // can invoke shutdown — the process blocks on the HTTP server,
  // returning here would let the event loop drain. `handle.shutdown` is
  // wired inside `startServiceServer` to SIGINT/SIGTERM already.
  void handle;
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Fatal: ${msg}`);
  process.exit(1);
});
