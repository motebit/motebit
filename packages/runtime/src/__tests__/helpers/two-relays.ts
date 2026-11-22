/**
 * Two fake relays on `.invalid` hosts, behind one stubbed `fetch`. Nothing
 * leaves the process: a request to any other host throws.
 *
 * Every request is recorded with the relay it reached, its method, path and
 * `Authorization` header, so a test can say "every tokened request went to
 * B, carrying a token B's source minted". A response can be HELD (the
 * request is recorded at once, the answer waits for `release()`), which is
 * how a test rebinds the runtime while a call is in flight.
 *
 * The relays serve what the delegation paths read: signed relay metadata,
 * discovery (one priced, P2P-payable worker), P2P eligibility, the listing,
 * task submission, the task read, credential submission and the worker's
 * capabilities. Ephemeral keys only; no money moves (wallets are mocks).
 */
import type { ExecutionReceipt } from "@motebit/sdk";
import { isRelayMetadataUrl, relayMetadataResponse } from "./signed-relay-metadata.js";

export const RELAY_A = "https://relay-a.invalid";
export const RELAY_B = "https://relay-b.invalid";
export const WORKER = "bob-worker";
export const WORKER_ADDR = "BobWorkerAddr1111111111111111111111111111111";

export type RelayName = "A" | "B";

export interface RecordedRequest {
  relay: RelayName;
  method: string;
  path: string;
  auth: string | undefined;
}

/** A token source whose every token names the relay binding that minted it. */
export function tokenSource(name: RelayName): (aud?: string) => Promise<string> {
  return async (aud?: string) => `${name}:${aud ?? "none"}`;
}

export function workerReceipt(
  taskId: string,
  overrides: Partial<ExecutionReceipt> = {},
): ExecutionReceipt {
  return {
    task_id: taskId,
    motebit_id: WORKER,
    device_id: "bob-device",
    submitted_at: Date.now() - 1000,
    completed_at: Date.now(),
    status: "completed",
    // Long enough, with a tool, to read as quality work (the trust bump's
    // quality gate) so a credential is issued.
    result: "the worker's answer — ".repeat(30),
    tools_used: ["web_search"],
    memories_formed: 0,
    prompt_hash: "a".repeat(64),
    result_hash: "b".repeat(64),
    suite: "motebit-jcs-ed25519-b64-v1",
    signature: "fake-sig-for-test",
    ...overrides,
  } as ExecutionReceipt;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export interface TwoRelays {
  readonly requests: RecordedRequest[];
  /** Requests that reached `name`. */
  to(name: RelayName): RecordedRequest[];
  /** Requests that carried a token. */
  tokened(): RecordedRequest[];
  /**
   * Hold the next `count` responses matching `relay` + `method` + path
   * predicate. The request is recorded when it arrives; the answer is sent on
   * `release()`.
   */
  hold(
    relay: RelayName,
    method: string,
    match: (path: string) => boolean,
    count?: number,
  ): { arrived(): number; release(): void };
  /** How the task read answers (default: delivered). */
  taskRead: (relay: RelayName, taskId: string) => Response;
  /** The task id the next submission is given, per relay. */
  nextTaskId: (relay: RelayName) => string;
  restore(): void;
}

export function installTwoRelays(me: string): TwoRelays {
  const originalFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  const holds: Array<{
    relay: RelayName;
    method: string;
    match: (path: string) => boolean;
    left: number;
    arrived: number;
    waiters: Array<() => void>;
    released: boolean;
  }> = [];
  let taskSeq = 0;

  const state: TwoRelays = {
    requests,
    to: (name) => requests.filter((r) => r.relay === name),
    tokened: () => requests.filter((r) => r.auth != null && r.auth !== ""),
    hold(relay, method, match, count = 1) {
      const h = {
        relay,
        method,
        match,
        left: count,
        arrived: 0,
        waiters: [] as Array<() => void>,
        released: false,
      };
      holds.push(h);
      return {
        arrived: () => h.arrived,
        release: () => {
          h.released = true;
          for (const w of h.waiters.splice(0)) w();
        },
      };
    },
    taskRead: (_relay, taskId) =>
      json(200, { task: { status: "completed" }, receipt: workerReceipt(taskId) }),
    nextTaskId: (relay) => `task-${relay}-${++taskSeq}`,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const relay: RelayName | null = url.startsWith(RELAY_A)
      ? "A"
      : url.startsWith(RELAY_B)
        ? "B"
        : null;
    if (relay == null) throw new Error(`unexpected network call: ${url}`);
    const parsed = new URL(url);
    const path = parsed.pathname;
    const method = init?.method ?? "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const auth = headers.Authorization ?? headers.authorization;
    requests.push({ relay, method, path, auth });

    const hold = holds.find(
      (h) => !h.released && h.left > 0 && h.relay === relay && h.method === method && h.match(path),
    );
    if (hold != null) {
      hold.left--;
      hold.arrived++;
      await new Promise<void>((resolve) => hold.waiters.push(resolve));
    }

    if (isRelayMetadataUrl(url)) return relayMetadataResponse();
    if (path === "/api/v1/agents/discover") {
      return json(200, {
        agents: [
          {
            motebit_id: WORKER,
            capabilities: ["web_search"],
            settlement_address: WORKER_ADDR,
            settlement_modes: "relay,p2p",
            pricing: [{ capability: "web_search", unit_cost: 0.25 }],
          },
        ],
      });
    }
    if (path.endsWith("/p2p-eligibility")) {
      return json(200, { allowed: true, settlement_address: WORKER_ADDR });
    }
    if (path === `/api/v1/agents/${WORKER}/listing`) {
      return json(200, { pricing: [{ capability: "web_search", unit_cost: 0.25 }] });
    }
    if (method === "POST" && path === `/agent/${me}/task`) {
      return json(201, { task_id: state.nextTaskId(relay), status: "pending" });
    }
    const taskRead = new RegExp(`^/agent/[^/]+/task/([^/]+)$`).exec(path);
    if (method === "GET" && taskRead != null) return state.taskRead(relay, taskRead[1]!);
    if (method === "POST" && /\/api\/v1\/agents\/[^/]+\/credentials\/submit$/.test(path)) {
      return json(200, { accepted: 1, rejected: 0 });
    }
    if (method === "GET" && /^\/agent\/[^/]+\/capabilities$/.test(path)) {
      return json(200, { hardware_attestations: [] });
    }
    return json(404, { error: "not stubbed" });
  }) as typeof fetch;

  return state;
}
