/**
 * Relay registration for a locally-run motebit (daemon / serve): the agent
 * authenticates to its relay AS ITSELF.
 *
 * Every call here carries a short-lived, audience-bound token signed by the
 * agent's own device key — never the relay operator's master token. The
 * operator's token used to be the daemon's bearer whenever it was configured
 * and, when it was not, registration went out unauthenticated and 401'd; a
 * hosted-relay user's daemon therefore never appeared in discovery unless it
 * held the operator's secret. This is the CLI half of the same rule the
 * first-party workers follow (`docs/doctrine/task-admission.md`
 * § "The worker authenticates as itself").
 *
 * Sequence: `bootstrap` (public, rate-limited, idempotent on (id, key);
 * same id + different key ⇒ 409) introduces the key → `register`
 * (`admin:query`) → optional listing (`market:listing`) → heartbeat every
 * five minutes with a FRESH `admin:query` token per tick (the old code minted
 * one 24-hour token and reused it) → `deregister` on shutdown.
 *
 * No signing key ⇒ registration is skipped and the caller is told why. There
 * is deliberately no shared-secret fallback.
 */

import { mintAudienceToken } from "@motebit/encryption";
import type { TokenAudience } from "@motebit/sdk";

export interface RelayRegistrationIdentity {
  motebitId: string;
  deviceId: string;
  /** 64-char hex Ed25519 public key — what `bootstrap` introduces. */
  publicKeyHex: string;
  privateKey: Uint8Array;
}

export interface RelayRegistrationOptions {
  syncUrl: string;
  identity: RelayRegistrationIdentity;
  /** The `/api/v1/agents/register` body: endpoint_url, capabilities, metadata, guardian fields… */
  registration: Record<string, unknown>;
  /** Tool names the listing prices (only when `price` resolves to a positive number). */
  toolNames: string[];
  /** `--price` value; falls back to `MOTEBIT_PRICE`. Absent/invalid ⇒ no listing. */
  price?: string;
  /** Listing description. */
  description: string;
  log?: (msg: string) => void;
  heartbeatMs?: number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

export interface RelayRegistrationHandle {
  registered: boolean;
  /** Stop the heartbeat. Idempotent. */
  stop(): void;
  /** Stop the heartbeat and remove the registry entry (best-effort). */
  deregister(): Promise<void>;
}

const DEFAULT_HEARTBEAT_MS = 5 * 60 * 1000;

/** Bearer headers signed by the agent's own key for `audience`, minted fresh per call. */
export async function signedRelayHeaders(
  identity: Pick<RelayRegistrationIdentity, "motebitId" | "deviceId" | "privateKey">,
  audience: TokenAudience,
  json = true,
): Promise<Record<string, string>> {
  const { token } = await mintAudienceToken(
    { mid: identity.motebitId, did: identity.deviceId, aud: audience },
    identity.privateKey,
  );
  return {
    ...(json ? { "Content-Type": "application/json" } : {}),
    Authorization: `Bearer ${token}`,
  };
}

export async function registerWithRelay(
  opts: RelayRegistrationOptions,
): Promise<RelayRegistrationHandle> {
  const log = opts.log ?? console.log;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const env = opts.env ?? process.env;
  const syncUrl = opts.syncUrl.replace(/\/+$/, "");
  const { identity } = opts;
  const noop: RelayRegistrationHandle = {
    registered: false,
    stop: () => {},
    deregister: async () => {},
  };

  // 1. Introduce the key. Idempotent; a 409 means this motebit_id is bound to a
  //    different key on this relay — say so, the register call will refuse too.
  try {
    const boot = await fetchImpl(`${syncUrl}/api/v1/agents/bootstrap`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        motebit_id: identity.motebitId,
        device_id: identity.deviceId,
        public_key: identity.publicKeyHex,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (boot.status === 409) {
      log(
        "Discovery: this motebit_id is bound to a DIFFERENT key on the relay — registration refused (rotate via the signed succession path, never by re-bootstrapping)",
      );
      return noop;
    }
  } catch (err: unknown) {
    log(
      `Discovery: relay bootstrap unreachable (${err instanceof Error ? err.message : String(err)}) — continuing to register`,
    );
  }

  // 2. Register, signed as ourselves.
  let regResp: Response;
  try {
    regResp = await fetchImpl(`${syncUrl}/api/v1/agents/register`, {
      method: "POST",
      headers: await signedRelayHeaders(identity, "admin:query"),
      body: JSON.stringify(opts.registration),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err: unknown) {
    log(
      `Discovery: registry registration failed (${err instanceof Error ? err.message : String(err)}) — continuing`,
    );
    return noop;
  }
  if (!regResp.ok) {
    log(`Discovery: registry registration returned ${regResp.status} (skipping)`);
    return noop;
  }
  log(`Discovery: registered with relay (${opts.toolNames.length} tools)`);

  // 3. Listing — the market surface has its own audience.
  await publishListing();

  // 4. Heartbeat with a fresh token per tick.
  let timer: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    void (async () => {
      try {
        await fetchImpl(`${syncUrl}/api/v1/agents/heartbeat`, {
          method: "POST",
          headers: await signedRelayHeaders(identity, "admin:query"),
          body: JSON.stringify({}),
          signal: AbortSignal.timeout(10_000),
        });
      } catch {
        // Best-effort heartbeat
      }
    })();
  }, opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
  if (typeof timer.unref === "function") timer.unref();

  const stop = (): void => {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  };

  return {
    registered: true,
    stop,
    deregister: async () => {
      stop();
      try {
        await fetchImpl(`${syncUrl}/api/v1/agents/deregister`, {
          method: "DELETE",
          headers: await signedRelayHeaders(identity, "admin:query", false),
          signal: AbortSignal.timeout(5_000),
        });
      } catch {
        // Best-effort deregistration
      }
    },
  };

  async function publishListing(): Promise<void> {
    const raw = opts.price ?? env["MOTEBIT_PRICE"];
    if (!raw) return;
    const unitCost = parseFloat(raw);
    if (isNaN(unitCost) || unitCost <= 0) {
      log(`Warning: --price "${raw}" is not a valid positive number — earning disabled`);
      return;
    }
    try {
      const resp = await fetchImpl(`${syncUrl}/api/v1/agents/${identity.motebitId}/listing`, {
        method: "POST",
        headers: await signedRelayHeaders(identity, "market:listing"),
        body: JSON.stringify({
          capabilities: opts.toolNames,
          pricing: opts.toolNames.map((cap) => ({
            capability: cap,
            unit_cost: unitCost,
            currency: "USD",
            per: "task",
          })),
          sla: { max_latency_ms: 60_000, availability_guarantee: 0.95 },
          description: opts.description,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) log(`Pricing: $${unitCost.toFixed(2)}/task — earning enabled`);
      else log(`Pricing: listing returned ${resp.status} — earning not enabled`);
    } catch {
      // Best-effort listing
    }
  }
}
