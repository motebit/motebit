/**
 * React Native's fetch, for tests: whatwg-fetch (resolved through
 * react-native, as the mobile app gets it) over an XHR that delivers the
 * whole response at `onload` — after `msPerEvent` per event it carries, plus
 * `pushMs` for a push. Every request is logged with when it started and how
 * it ended.
 */
import { createRequire } from "node:module";
import { vi } from "vitest";
import type { FakeRelay } from "./fake-relay.js";

export interface WhatwgFetch {
  fetch: typeof fetch;
  Response: typeof Response;
  Headers: typeof Headers;
}

export function loadWhatwgFetch(): WhatwgFetch {
  const fromMobile = createRequire(
    new URL("../../../../apps/mobile/package.json", import.meta.url),
  );
  const fromRn = createRequire(fromMobile.resolve("react-native/package.json"));
  return fromRn("whatwg-fetch") as WhatwgFetch;
}

export interface XhrLogEntry {
  path: string;
  start: number;
  end?: number;
  outcome?: "load" | "abort";
}

export interface RnLink {
  msPerEvent: number;
  pushMs: number;
  log: XhrLogEntry[];
}

const W = loadWhatwgFetch();
const NativeResponse = globalThis.Response;

/** Stub the globals so every request goes through whatwg-fetch over the slow link. */
export function onReactNative(relay: FakeRelay, link: RnLink): void {
  class SlowXhr {
    status = 0;
    statusText = "";
    responseText = "";
    responseURL = "";
    readyState = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    onabort: (() => void) | null = null;
    onreadystatechange: (() => void) | null = null;
    withCredentials = false;
    private method = "GET";
    private url = "";
    private headers: Record<string, string> = {};
    private timer: ReturnType<typeof setTimeout> | null = null;
    private entry: XhrLogEntry | null = null;
    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
    }
    setRequestHeader(name: string, value: string): void {
      this.headers[name] = value;
    }
    getAllResponseHeaders(): string {
      return "content-type: application/json\r\n";
    }
    send(body: string | null): void {
      const path = new URL(this.url).pathname;
      this.entry = { path, start: Date.now() };
      link.log.push(this.entry);
      globalThis.Response = NativeResponse;
      const pending = relay.fetch(this.url, {
        method: this.method,
        headers: this.headers,
        ...(body !== null ? { body } : {}),
      });
      globalThis.Response = W.Response;
      void pending.then(async (res) => {
        const text = await res.text();
        const events = (JSON.parse(text) as { events?: unknown[] }).events?.length ?? 0;
        if (this.readyState === 4) return; // aborted meanwhile
        this.timer = setTimeout(
          () => {
            this.status = res.status;
            this.statusText = res.statusText;
            this.responseText = text;
            this.responseURL = this.url;
            this.readyState = 4;
            this.entry!.end = Date.now();
            this.entry!.outcome = "load";
            this.onreadystatechange?.();
            this.onload?.();
          },
          1 + link.msPerEvent * events + (path.endsWith("/push") ? link.pushMs : 0),
        );
      });
    }
    abort(): void {
      if (this.timer) clearTimeout(this.timer);
      this.readyState = 4;
      if (this.entry && !this.entry.outcome) {
        this.entry.end = Date.now();
        this.entry.outcome = "abort";
      }
      this.onreadystatechange?.();
      this.onabort?.();
    }
  }
  vi.stubGlobal("Response", W.Response);
  vi.stubGlobal("Headers", W.Headers);
  vi.stubGlobal("XMLHttpRequest", SlowXhr);
  vi.stubGlobal("fetch", W.fetch);
}
