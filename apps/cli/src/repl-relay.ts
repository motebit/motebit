/**
 * The REPL's relay wiring (index.ts), in startup order: register the device,
 * the first push, the periodic push (#962; `replStartupSync`), then
 * interactive delegation and agent discovery.
 *
 * Relay sync is opt-in (`sync-opt-in.ts`). With no relay named (flag, env,
 * config.json) this does NOTHING and returns undefined: no bootstrap, no
 * push, no discovery — the REPL makes zero relay calls.
 */
import { mintAudienceToken } from "@motebit/encryption";
import type { EventStoreAdapter } from "@motebit/event-log";
import type { MotebitRuntime } from "@motebit/runtime";
import type { CliConfig } from "./args.js";
import { replStartupSync, type CliEventPush } from "./cli-event-push.js";
import { dim, success } from "./colors.js";

export interface ReplRelayOptions {
  runtime: MotebitRuntime;
  config: Pick<CliConfig, "syncToken" | "routingStrategy" | "payNewAgents">;
  /** The relay the operator named, or undefined: relay sync is off. */
  syncUrl: string | undefined;
  motebitId: string;
  eventStore: EventStoreAdapter;
  /** The decrypted identity key, when it opened. */
  privateKeyBytes: Uint8Array | undefined;
  deviceId: string | undefined;
  devicePublicKey: string | undefined;
  /** The pinned relay operator key (`motebit register`), when one is pinned. */
  relayPublicKey: string | undefined;
  log: (line: string) => void;
  warn: (line: string) => void;
  /** Injected for tests; default the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** The periodic push interval (ms). Default `PUSH_INTERVAL_MS`. */
  pushIntervalMs?: number;
}

/** Wire the REPL to its relay; undefined (and no network) when relay sync is off. */
export async function startReplRelay(opts: ReplRelayOptions): Promise<CliEventPush | undefined> {
  const { runtime, config, syncUrl, motebitId, privateKeyBytes, deviceId } = opts;
  if (syncUrl == null || syncUrl === "") return undefined;

  const push = await replStartupSync({
    runtime,
    syncUrl,
    motebitId,
    eventStore: opts.eventStore,
    ...(privateKeyBytes && deviceId && opts.devicePublicKey
      ? {
          device: {
            deviceId,
            publicKeyHex: opts.devicePublicKey,
            privateKey: privateKeyBytes,
          },
        }
      : {}),
    log: (line) => opts.log(dim(line)),
    warn: opts.warn,
    ...(opts.pushIntervalMs !== undefined ? { pushIntervalMs: opts.pushIntervalMs } : {}),
  });

  // Enable delegation with audience-scoped device tokens (submit vs query).
  // Falls back to raw API token only when device keys are unavailable.
  // `enableInvokeCapability` is wired to the same relay coordinates so
  // the deterministic `/invoke <cap> <prompt>` path shares transport with
  // the AI-loop delegation path (surface-determinism doctrine).
  const shared = {
    syncUrl,
    ...(config.routingStrategy !== undefined ? { routingStrategy: config.routingStrategy } : {}),
    // Cold-start opt-in (`--pay-new-agents`) — admit paid P2P delegation
    // to a no-history worker (else relay-mode). Shared by both the chat
    // (delegate_to_agent) and deterministic (invokeCapability) paths.
    ...(config.payNewAgents ? { acknowledgeNoHistoryRisk: true } : {}),
    // The PINNED relay operator key (motebit register, TOFU over the
    // signed transparency declaration). With the sovereign rail
    // present, this is what unlocks the P2P path — the treasury
    // address derives FROM the pin, never from a fetched response.
    ...(opts.relayPublicKey ? { relayPublicKey: opts.relayPublicKey } : {}),
  };
  if (privateKeyBytes && deviceId) {
    const pk = privateKeyBytes;
    const did = deviceId;
    const authToken = async (audience = "task:submit"): Promise<string> => {
      return (await mintAudienceToken({ mid: motebitId, did, aud: audience }, pk)).token;
    };
    const delegationCfg = { ...shared, authToken };
    runtime.enableInteractiveDelegation(delegationCfg);
    runtime.enableInvokeCapability(delegationCfg);
  } else {
    const apiToken = config.syncToken ?? process.env["MOTEBIT_API_TOKEN"];
    if (apiToken) {
      const delegationCfg = { ...shared, authToken: () => Promise.resolve(apiToken) };
      runtime.enableInteractiveDelegation(delegationCfg);
      runtime.enableInvokeCapability(delegationCfg);
    }
  }

  // Discover remote agents and populate service listings for interactive delegation
  try {
    const token = config.syncToken ?? process.env["MOTEBIT_API_TOKEN"];
    const headers: Record<string, string> = {};
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const resp = await (opts.fetchImpl ?? fetch)(`${syncUrl}/api/v1/agents/discover`, { headers });
    if (resp.ok) {
      const data = (await resp.json()) as {
        agents: Array<{
          motebit_id: string;
          capabilities: string[];
          endpoint_url?: string;
        }>;
      };
      // Filter out self, populate service listings for agents with capabilities
      const others = data.agents.filter(
        (a) => a.motebit_id !== motebitId && a.capabilities.length > 0,
      );
      for (const agent of others) {
        await runtime.registerServiceListing({
          motebit_id: agent.motebit_id,
          capabilities: agent.capabilities,
          pricing: [],
          sla: { max_latency_ms: 30_000, availability_guarantee: 0.99 },
          description: agent.capabilities.join(", "),
        });
      }
      if (others.length > 0) {
        opts.log(success(`Discovered ${others.length} agent(s) on the network`));
      }
    }
  } catch {
    // Discovery is best-effort — offline mode still works
  }
  return push;
}
