import { describe, it, expect, vi, beforeEach } from "vitest";
import { TauriTTSProvider } from "../tauri-tts";

// ---------------------------------------------------------------------------
// Browser APIs (Audio, URL.createObjectURL, atob) — shimmed
// ---------------------------------------------------------------------------

class FakeAudio {
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src: string;
  paused = false;
  playResolve: (() => void) | null = null;
  playReject: ((e: Error) => void) | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  static instances: FakeAudio[] = [];

  constructor(src: string) {
    this.src = src;
    FakeAudio.instances.push(this);
  }

  play(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.playResolve = resolve;
      this.playReject = reject;
      // Default: resolve immediately to continue play chain
      setTimeout(() => resolve(), 0);
    });
  }

  pause() {
    this.paused = true;
  }

  fireEnded() {
    this.onended?.();
  }

  fireError() {
    this.onerror?.();
  }
}

beforeEach(() => {
  FakeAudio.instances = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Audio = FakeAudio;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).URL = {
    createObjectURL: vi.fn(() => "blob:fake-url"),
    revokeObjectURL: vi.fn(),
  };
  // Minimal atob for base64 → binary
  if (typeof globalThis.atob === "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis as any).atob = (b64: string) => Buffer.from(b64, "base64").toString("binary");
  }
});

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe("TauriTTSProvider construction", () => {
  it("uses defaults when no options provided", () => {
    const invoke = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tts = new TauriTTSProvider(invoke as any);
    expect(tts.speaking).toBe(false);
  });

  it("accepts custom voice + model options", () => {
    const invoke = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tts = new TauriTTSProvider(invoke as any, { voice: "nova", model: "tts-1-hd" });
    expect(tts.speaking).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// speak
// ---------------------------------------------------------------------------

describe("TauriTTSProvider.speak", () => {
  it("invokes tts_openai_speech and plays audio to completion", async () => {
    // Tiny MP3 payload (dummy bytes)
    const payload = Buffer.from("fake-mp3-bytes").toString("base64");
    const invoke = vi.fn(async () => payload);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tts = new TauriTTSProvider(invoke as any);

    const promise = tts.speak("hello");
    // Let microtasks run so Audio is constructed
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    // Fire ended to resolve the inner promise
    const audio = FakeAudio.instances[0];
    expect(audio).toBeDefined();
    audio?.fireEnded();
    await promise;
    expect(tts.speaking).toBe(false);
    expect(invoke).toHaveBeenCalledWith("tts_openai_speech", {
      text: "hello",
      voice: "alloy",
      model: "tts-1",
    });
  });

  it("rejects when audio errors", async () => {
    const payload = Buffer.from("fake").toString("base64");
    const invoke = vi.fn(async () => payload);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tts = new TauriTTSProvider(invoke as any);

    const promise = tts.speak("hello");
    await new Promise((r) => setTimeout(r, 5));
    const audio = FakeAudio.instances[0];
    audio?.fireError();
    await expect(promise).rejects.toThrow(/Audio playback failed/);
    expect(tts.speaking).toBe(false);
  });

  it("propagates invoke errors", async () => {
    const invoke = vi.fn(async () => {
      throw new Error("keyring locked");
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tts = new TauriTTSProvider(invoke as any);
    await expect(tts.speak("hi")).rejects.toThrow("keyring locked");
    expect(tts.speaking).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cancel
// ---------------------------------------------------------------------------

describe("TauriTTSProvider.cancel", () => {
  it("is safe to call when not speaking", () => {
    const invoke = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tts = new TauriTTSProvider(invoke as any);
    expect(() => tts.cancel()).not.toThrow();
    expect(tts.speaking).toBe(false);
  });

  it("stops in-flight speech when invoked pre-decode", async () => {
    // Hold the invoke promise open so cancel fires before Audio construction
    let resolveInvoke: (v: string) => void = () => {};
    const invoke = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveInvoke = resolve;
        }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tts = new TauriTTSProvider(invoke as any);
    const speakPromise = tts.speak("hi");
    expect(tts.speaking).toBe(true);
    tts.cancel();
    // Resolve the invoke; the post-invoke _cancelled check should abort cleanly
    resolveInvoke(Buffer.from("fake").toString("base64"));
    await speakPromise;
    expect(tts.speaking).toBe(false);
  });
});
