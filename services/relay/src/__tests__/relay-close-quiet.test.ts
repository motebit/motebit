/**
 * Nothing a relay starts at boot may write to the console after `close()`
 * resolves.
 *
 * The relay suite's teardown flake — `EnvironmentTeardownError:
 * [vitest-worker]: Closing rpc while "onUserConsoleLog" was pending`, blamed
 * on whichever short file (fees, revocation, identity-binding-unit, …) was
 * running — was a console write that landed while the worker was closing.
 * Its source: every relay fires the x402 facilitator handshake
 * (`x402HTTPResourceServer.initialize()` → `GET <facilitator>/supported`)
 * unawaited at boot, and `@x402/core` `console.warn`s when it fails. A slow
 * or rate-limited facilitator (its client retries 429s with backoff) answers
 * after the test that booted the relay has closed it — in a short file,
 * after the file's last hook.
 *
 * The facilitator here is held open until after `close()`, then answered:
 * the deterministic form of "the answer arrives late".
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestRelay } from "./test-helpers.js";
import { abortGetSupportedOn } from "../tasks.js";

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

describe("relay close(): no console output afterwards", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("the boot-time facilitator handshake is ended by close(), not answered after it", async () => {
    // Every non-local request is held until the test releases it.
    const held: Array<() => void> = [];
    const requested: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requested.push(url);
      return new Promise<Response>((resolve) =>
        held.push(() => resolve(new Response("rate limited", { status: 503 }))),
      );
    });

    const late: string[] = [];
    let closed = false;
    for (const method of CONSOLE_METHODS) {
      const real = console[method].bind(console);
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        if (closed) late.push(`console.${method}: ${args.map(String).join(" ")}`);
        else real(...args);
      });
    }

    const relay = await createTestRelay();
    // The handshake this test is about really was started at boot.
    expect(requested.some((u) => u.endsWith("/supported"))).toBe(true);

    await relay.close();
    closed = true;
    // The facilitator (and any other remote) answers now, after close().
    held.splice(0).forEach((answer) => answer());
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(late).toEqual([]);
  });
});

describe("abortGetSupportedOn", () => {
  function fakeClient() {
    let answer: (v: unknown) => void = () => {};
    return {
      calls: [] as string[],
      getSupported() {
        this.calls.push("getSupported");
        return new Promise((resolve) => (answer = resolve));
      },
      verify(x: number) {
        this.calls.push("verify");
        return Promise.resolve(x + 1);
      },
      answer: (v: unknown) => answer(v),
      url: "https://facilitator.example",
    };
  }

  it("a pending getSupported rejects as soon as the signal aborts", async () => {
    const ctl = new AbortController();
    const client = abortGetSupportedOn(fakeClient(), ctl.signal);
    const p = client.getSupported();
    ctl.abort();
    await expect(p).rejects.toThrow(/aborted: relay closed/);
  });

  it("after abort, getSupported never reaches the client", async () => {
    const ctl = new AbortController();
    const inner = fakeClient();
    const client = abortGetSupportedOn(inner, ctl.signal);
    ctl.abort();
    await expect(client.getSupported()).rejects.toThrow(/aborted/);
    expect(inner.calls).toEqual([]);
  });

  it("an answer before abort passes through; other methods and fields are untouched", async () => {
    const ctl = new AbortController();
    const inner = fakeClient();
    const client = abortGetSupportedOn(inner, ctl.signal);
    const p = client.getSupported();
    inner.answer({ kinds: [] });
    await expect(p).resolves.toEqual({ kinds: [] });
    ctl.abort();
    await expect(client.verify(1)).resolves.toBe(2);
    expect(client.url).toBe("https://facilitator.example");
  });

  it("a getSupported failure is passed through as an Error", async () => {
    const ctl = new AbortController();
    const client = abortGetSupportedOn(
      // A non-Error rejection on purpose: the wrapper must hand back an Error.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      { getSupported: () => Promise.reject("boom") },
      ctl.signal,
    );
    await expect(client.getSupported()).rejects.toThrow("boom");
  });
});
