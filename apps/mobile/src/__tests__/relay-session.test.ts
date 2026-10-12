/**
 * RelaySession — the one door to the relay. Once disposed, nothing it
 * started can act: fetch refuses (and in-flight requests abort), owned
 * timers never fire, guarded adapters refuse calls and late results,
 * statuses go silent, owned handles are released exactly once.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RelaySession, RelaySessionDisposedError, isRelaySessionDisposed } from "../relay-session";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("RelaySession", () => {
  it("fetch refuses after dispose and aborts a request in flight", async () => {
    let seen: AbortSignal | undefined;
    const fetchSpy = vi.fn(
      (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          seen = init?.signal ?? undefined;
          seen?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const session = new RelaySession();
    const inFlight = session.fetch("https://relay.test/x");
    session.dispose();
    await expect(inFlight).rejects.toThrow();
    expect(seen?.aborted).toBe(true);
    await expect(session.fetch("https://relay.test/y")).rejects.toBeInstanceOf(
      RelaySessionDisposedError,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("a response that lands after dispose is refused", async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((r) => (resolve = r))),
    );
    const session = new RelaySession();
    const p = session.fetch("https://relay.test/x");
    session.dispose();
    resolve(new Response("{}"));
    await expect(p).rejects.toSatisfy(isRelaySessionDisposed);
  });

  it("owned timers and intervals are cancelled by dispose", async () => {
    const session = new RelaySession();
    const fn = vi.fn();
    session.setTimeout(fn, 1_000);
    session.setInterval(fn, 1_000);
    session.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    session.setTimeout(fn, 1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("run / token reject once the session ended meanwhile", async () => {
    const session = new RelaySession();
    let release!: (v: string) => void;
    const mint = session.token(() => new Promise<string>((r) => (release = r)));
    const p = mint();
    session.dispose();
    release("tok");
    await expect(p).rejects.toSatisfy(isRelaySessionDisposed);
    const work = vi.fn(() => Promise.resolve(1));
    await expect(session.run(work)).rejects.toSatisfy(isRelaySessionDisposed);
    expect(work).not.toHaveBeenCalled();
  });

  it("guard refuses calls after dispose and results that arrive after it", async () => {
    const session = new RelaySession();
    let release!: () => void;
    const target = {
      calls: 0,
      push(): Promise<string> {
        this.calls++;
        return new Promise<string>((r) => (release = () => r("ok")));
      },
    };
    const guarded = session.guard(target);
    const p = guarded.push();
    session.dispose();
    release();
    await expect(p).rejects.toSatisfy(isRelaySessionDisposed);
    // Refused without a synchronous throw (a library timer may be the caller).
    await expect(guarded.push()).rejects.toBeInstanceOf(RelaySessionDisposedError);
    expect(target.calls).toBe(1);
  });

  it("guard never throws synchronously after dispose (a library timer may call it)", () => {
    const session = new RelaySession();
    const target = { hasLiveWork: vi.fn(() => true) };
    const guarded = session.guard(target);
    expect(guarded.hasLiveWork()).toBe(true);
    session.dispose();
    // The sync engine's watchdog asks `hasLiveWork() === true` from a timer.
    expect(() => guarded.hasLiveWork()).not.toThrow();
    expect((guarded.hasLiveWork() as unknown) === true).toBe(false);
    expect(target.hasLiveWork).toHaveBeenCalledTimes(1);
  });

  it("status is silent after dispose; owned handles release once, and late ones at once", () => {
    const onStatus = vi.fn();
    const session = new RelaySession<"idle" | "error">(onStatus);
    const release = vi.fn();
    session.own(release);
    session.status("idle");
    session.dispose();
    session.dispose();
    session.status("error");
    expect(onStatus.mock.calls).toEqual([["idle"]]);
    expect(release).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    session.own(late);
    expect(late).toHaveBeenCalledTimes(1);
  });
});
