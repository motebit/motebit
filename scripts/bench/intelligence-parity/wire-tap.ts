/**
 * Wire tap — observes every Anthropic `/v1/messages` exchange at the fetch
 * boundary, for EVERY route, with one instrument.
 *
 * WHY THE FETCH BOUNDARY. The bench must report the parameters motebit
 * ACTUALLY sent, not what its config claims it would send: `AnthropicProvider`
 * drops `temperature` on models that reject sampling, bumps `max_tokens` under
 * extended thinking, attaches `cache_control` — a config read would miss all of
 * it. Wrapping `fetch` sees the final bytes and needs no product change, which
 * is the bench's hard rule (it measures; it never edits a prompt, a context
 * policy, a route or a default).
 *
 * WHY ONE INSTRUMENT FOR ALL ROUTES. Route B is sent through this same tap, so
 * TTFT and token counts for A and B come from the same clock and the same SSE
 * parser — a difference between them cannot be a measurement artefact.
 *
 * The response stream is TEE'd: the caller (the provider adapter) reads its
 * branch exactly as it would unobserved; the tap drains the other.
 */

import type { Usage, WireExchange } from "./types.js";

export const ZERO_USAGE: Usage = Object.freeze({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}) as Usage;

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
  };
}

type Fetch = typeof globalThis.fetch;

export interface WireTap {
  readonly exchanges: WireExchange[];
  /** The wrapped fetch (also installed on globalThis while the tap is live). */
  readonly fetch: Fetch;
  /** Resolves once every observed response body has been fully drained. */
  settled(): Promise<void>;
  restore(): void;
}

function isMessagesCall(url: string, init?: RequestInit): boolean {
  return /\/v1\/messages(\?|$)/.test(url) && (init?.method ?? "GET").toUpperCase() === "POST";
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function mergeUsage(target: WireExchange, raw: unknown): void {
  if (raw == null || typeof raw !== "object") return;
  const u = raw as Record<string, unknown>;
  // message_start carries input + cache counts; message_delta carries the final
  // output count (cumulative). Take the max per field so either order is safe.
  target.usage = {
    input_tokens: Math.max(target.usage.input_tokens, num(u["input_tokens"])),
    output_tokens: Math.max(target.usage.output_tokens, num(u["output_tokens"])),
    cache_read_input_tokens: Math.max(
      target.usage.cache_read_input_tokens,
      num(u["cache_read_input_tokens"]),
    ),
    cache_creation_input_tokens: Math.max(
      target.usage.cache_creation_input_tokens,
      num(u["cache_creation_input_tokens"]),
    ),
  };
}

/** Apply one parsed SSE event to the exchange record. Exported for tests. */
export function applySseEvent(
  ex: WireExchange,
  event: Record<string, unknown>,
  now: number,
  partialJson: Map<number, string>,
): void {
  switch (event["type"]) {
    case "message_start": {
      const msg = event["message"] as Record<string, unknown> | undefined;
      mergeUsage(ex, msg?.["usage"]);
      break;
    }
    case "content_block_start": {
      const index = num(event["index"]);
      const block = { ...(event["content_block"] as Record<string, unknown>) };
      ex.content[index] = block;
      break;
    }
    case "content_block_delta": {
      const index = num(event["index"]);
      const delta = event["delta"] as Record<string, unknown>;
      const block = (ex.content[index] ??= { type: "text", text: "" });
      if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
        block["text"] = String(block["text"] ?? "") + delta["text"];
        ex.text += delta["text"];
        if (ex.first_text_at === undefined && delta["text"].length > 0) ex.first_text_at = now;
      } else if (delta["type"] === "thinking_delta") {
        block["thinking"] = String(block["thinking"] ?? "") + String(delta["thinking"] ?? "");
      } else if (delta["type"] === "signature_delta") {
        block["signature"] = String(delta["signature"] ?? "");
      } else if (delta["type"] === "input_json_delta") {
        partialJson.set(
          index,
          (partialJson.get(index) ?? "") + String(delta["partial_json"] ?? ""),
        );
      }
      break;
    }
    case "content_block_stop": {
      const index = num(event["index"]);
      const json = partialJson.get(index);
      const block = ex.content[index];
      if (block && json !== undefined) {
        try {
          block["input"] = json.length > 0 ? JSON.parse(json) : {};
        } catch {
          block["input"] = { _unparsed: json };
        }
        partialJson.delete(index);
      }
      break;
    }
    case "message_delta": {
      const delta = event["delta"] as Record<string, unknown> | undefined;
      if (typeof delta?.["stop_reason"] === "string") ex.stop_reason = delta["stop_reason"];
      mergeUsage(ex, event["usage"]);
      break;
    }
    case "message_stop":
      ex.ended_at = now;
      break;
    case "error":
      ex.error = JSON.stringify(event["error"] ?? event);
      break;
    default:
      break;
  }
}

/** Drain an SSE body into `ex`. `clock` is injectable so tests are deterministic. */
export async function drainSse(
  ex: WireExchange,
  body: ReadableStream<Uint8Array>,
  clock: () => number,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const partialJson = new Map<number, string>();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data.length === 0 || data === "[DONE]") continue;
        try {
          applySseEvent(ex, JSON.parse(data) as Record<string, unknown>, clock(), partialJson);
        } catch {
          // A malformed frame is the adapter's problem to surface, not the tap's.
        }
      }
    }
  }
  ex.ended_at ??= clock();
}

function applyJsonResponse(ex: WireExchange, data: Record<string, unknown>, now: number): void {
  mergeUsage(ex, data["usage"]);
  const content = Array.isArray(data["content"])
    ? (data["content"] as Array<Record<string, unknown>>)
    : [];
  ex.content = content.map((b) => ({ ...b }));
  ex.text = content
    .filter((b) => b["type"] === "text")
    .map((b) => String(b["text"] ?? ""))
    .join("");
  if (typeof data["stop_reason"] === "string") ex.stop_reason = data["stop_reason"];
  if (ex.text.length > 0) ex.first_text_at = now;
  ex.ended_at = now;
}

export function installWireTap(
  options: { underlying?: Fetch; clock?: () => number } = {},
): WireTap {
  const previous = globalThis.fetch;
  const underlying = options.underlying ?? previous;
  const clock = options.clock ?? (() => performance.now());
  const exchanges: WireExchange[] = [];
  const pending: Promise<void>[] = [];

  const tapped: Fetch = async (input, init) => {
    const url = urlOf(input);
    if (!isMessagesCall(url, init)) return underlying(input, init);

    let requestBody: Record<string, unknown> = {};
    try {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      requestBody = { _unparsed: String(init?.body) };
    }
    const ex: WireExchange = {
      url,
      request_body: requestBody,
      status: 0,
      started_at: clock(),
      usage: { ...ZERO_USAGE },
      content: [],
      text: "",
    };
    exchanges.push(ex);

    let res: Response;
    try {
      res = await underlying(input, init);
    } catch (err) {
      ex.error = err instanceof Error ? err.message : String(err);
      ex.ended_at = clock();
      throw err;
    }
    ex.status = res.status;
    if (!res.ok || res.body == null) {
      ex.ended_at = clock();
      if (!res.ok) {
        const copy = res.clone();
        pending.push(
          copy.text().then(
            (t) => void (ex.error = `HTTP ${res.status}: ${t.slice(0, 500)}`),
            () => void (ex.error = `HTTP ${res.status}`),
          ),
        );
      }
      return res;
    }
    if (requestBody["stream"] === true) {
      const [mine, theirs] = res.body.tee();
      pending.push(drainSse(ex, mine, clock));
      return new Response(theirs, { status: res.status, headers: res.headers });
    }
    const copy = res.clone();
    pending.push(
      copy.json().then(
        (data) => applyJsonResponse(ex, data as Record<string, unknown>, clock()),
        (err: unknown) => void (ex.error = err instanceof Error ? err.message : String(err)),
      ),
    );
    return res;
  };

  globalThis.fetch = tapped;
  return {
    exchanges,
    fetch: tapped,
    async settled() {
      // Drains can enqueue while we wait (a tool round fires a new call), so
      // loop until the pending set stops growing.
      let seen = -1;
      while (seen !== pending.length) {
        seen = pending.length;
        await Promise.allSettled(pending.slice());
      }
    },
    restore() {
      if (globalThis.fetch === tapped) globalThis.fetch = previous;
    },
  };
}
