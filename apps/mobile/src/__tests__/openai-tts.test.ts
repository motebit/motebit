import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockSetAudioMode = vi.fn();
const mockPlayerPause = vi.fn();
const mockPlayerRemove = vi.fn();
const mockCreatePlayer = vi.fn();
const mockWriteString = vi.fn();
const mockDeleteAsync = vi.fn();

vi.mock("expo-audio", () => ({
  setAudioModeAsync: (...args: unknown[]) => mockSetAudioMode(...args),
  createAudioPlayer: (...args: unknown[]) => mockCreatePlayer(...args),
}));

vi.mock("expo-file-system/legacy", () => ({
  cacheDirectory: "/mock/cache/",
  writeAsStringAsync: (...args: unknown[]) => mockWriteString(...args),
  deleteAsync: (...args: unknown[]) => mockDeleteAsync(...args),
  EncodingType: {
    Base64: "base64",
  },
}));

import { OpenAITTSProvider, TTS_VOICES } from "../adapters/openai-tts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(overrides?: { apiKey?: string; voice?: string; model?: string }) {
  return new OpenAITTSProvider({
    apiKey: overrides?.apiKey ?? "test-key",
    voice: overrides?.voice,
    model: overrides?.model,
  });
}

/**
 * Create a mock fetch response for a successful TTS call.
 * Returns a minimal valid response with an arrayBuffer.
 */
function mockFetchSuccess(audioBytes = new Uint8Array([0xff, 0xfb, 0x90])) {
  const mockResponse = {
    ok: true,
    status: 200,
    arrayBuffer: vi.fn(async () => audioBytes.buffer),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => mockResponse),
  );
  return mockResponse;
}

function mockFetchError(status = 500) {
  const mockResponse = {
    ok: false,
    status,
    arrayBuffer: vi.fn(),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => mockResponse),
  );
  return mockResponse;
}

/**
 * Set up AudioPlayer mock that immediately finishes playback
 * when play is called.
 */
function setupSoundAutoFinish() {
  let playbackCallback: ((status: { didJustFinish: boolean }) => void) | null = null;

  const player = {
    play: vi.fn(() => {
      // Trigger didJustFinish on next microtask
      queueMicrotask(() => playbackCallback?.({ didJustFinish: true }));
    }),
    pause: mockPlayerPause,
    remove: mockPlayerRemove,
    addListener: vi.fn((_ev: string, cb: (status: { didJustFinish: boolean }) => void) => {
      playbackCallback = cb;
      return { remove: vi.fn() };
    }),
  };

  mockCreatePlayer.mockReturnValue(player);
  return player;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("OpenAITTSProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetAudioMode.mockResolvedValue(undefined);
    mockWriteString.mockResolvedValue(undefined);
    mockDeleteAsync.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------------------------
  // Exports
  // -------------------------------------------------------------------------

  describe("exports", () => {
    it("exports TTS_VOICES array with 6 voices", () => {
      expect(TTS_VOICES).toEqual(["alloy", "echo", "fable", "onyx", "nova", "shimmer"]);
    });
  });

  // -------------------------------------------------------------------------
  // Interface compliance
  // -------------------------------------------------------------------------

  describe("TTSProvider interface", () => {
    it("has speak, cancel, speaking", () => {
      const provider = makeProvider();
      expect(typeof provider.speak).toBe("function");
      expect(typeof provider.cancel).toBe("function");
      expect(typeof provider.speaking).toBe("boolean");
    });

    it("speaking defaults to false", () => {
      expect(makeProvider().speaking).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Constructor defaults
  // -------------------------------------------------------------------------

  describe("constructor", () => {
    it("defaults voice to alloy and model to tts-1", async () => {
      mockFetchSuccess();
      setupSoundAutoFinish();

      const provider = makeProvider({ apiKey: "key123" });
      await provider.speak("test");

      const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const body = JSON.parse(fetchCall[1].body);
      expect(body.voice).toBe("alloy");
      expect(body.model).toBe("tts-1");
    });

    it("accepts custom voice and model", async () => {
      mockFetchSuccess();
      setupSoundAutoFinish();

      const provider = makeProvider({
        apiKey: "key",
        voice: "nova",
        model: "tts-1-hd",
      });
      await provider.speak("test");

      const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
      const body = JSON.parse(fetchCall[1].body);
      expect(body.voice).toBe("nova");
      expect(body.model).toBe("tts-1-hd");
    });
  });

  // -------------------------------------------------------------------------
  // speak()
  // -------------------------------------------------------------------------

  describe("speak()", () => {
    it("sets audio mode, calls OpenAI API, writes file, and plays", async () => {
      mockFetchSuccess();
      setupSoundAutoFinish();

      const provider = makeProvider({ apiKey: "sk-test" });
      await provider.speak("hello world");

      // Audio mode set for playback
      expect(mockSetAudioMode).toHaveBeenCalledWith({
        allowsRecording: false,
        playsInSilentMode: true,
      });

      // Fetch called with correct URL and headers
      expect(fetch).toHaveBeenCalledWith(
        "https://api.openai.com/v1/audio/speech",
        expect.objectContaining({
          method: "POST",
          headers: {
            Authorization: "Bearer sk-test",
            "Content-Type": "application/json",
          },
        }),
      );

      // Body contains the text
      const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.input).toBe("hello world");
      expect(body.response_format).toBe("mp3");

      // File written to cache
      expect(mockWriteString).toHaveBeenCalledWith(
        expect.stringMatching(/^\/mock\/cache\/tts_\d+\.mp3$/),
        expect.any(String),
        { encoding: "base64" },
      );

      // Sound created and played
      expect(mockCreatePlayer).toHaveBeenCalled();
    });

    it("speaking is false after speak() resolves", async () => {
      mockFetchSuccess();
      setupSoundAutoFinish();

      const provider = makeProvider();
      await provider.speak("test");
      expect(provider.speaking).toBe(false);
    });

    it("throws on API error", async () => {
      mockFetchError(429);

      const provider = makeProvider();
      await expect(provider.speak("test")).rejects.toThrow("OpenAI TTS error: 429");
      expect(provider.speaking).toBe(false);
    });

    it("throws on network error", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw new Error("Network failure");
        }),
      );

      const provider = makeProvider();
      await expect(provider.speak("test")).rejects.toThrow("Network failure");
      expect(provider.speaking).toBe(false);
    });

    it("converts response bytes to base64 and writes to cache", async () => {
      // Use known bytes so we can verify the base64 output
      const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      mockFetchSuccess(bytes);
      setupSoundAutoFinish();

      const provider = makeProvider();
      await provider.speak("test");

      // btoa("Hello") = "SGVsbG8="
      expect(mockWriteString).toHaveBeenCalledWith(expect.any(String), "SGVsbG8=", {
        encoding: "base64",
      });
    });

    it("early-returns without playing if cancelled after API response", async () => {
      // Set up fetch that resolves normally
      mockFetchSuccess();

      const provider = makeProvider();

      // Set cancelled before speak starts
      (provider as unknown as { _cancelled: boolean })._cancelled = true;

      // speak() sets _cancelled = false on entry, so we need a different approach.
      // Instead, test that cancel before file write short-circuits.

      // Reset
      (provider as unknown as { _cancelled: boolean })._cancelled = false;

      // Use a fetch mock that sets _cancelled during arrayBuffer()
      const mockResponse = {
        ok: true,
        status: 200,
        arrayBuffer: vi.fn(async () => {
          // Simulate cancel happening during download
          provider.cancel();
          return new Uint8Array([1, 2, 3]).buffer;
        }),
      };
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => mockResponse),
      );

      await provider.speak("test");

      // Should not have created a sound because _cancelled was set
      expect(mockCreatePlayer).not.toHaveBeenCalled();
      expect(provider.speaking).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // cancel()
  // -------------------------------------------------------------------------

  describe("cancel()", () => {
    it("sets speaking to false", () => {
      const provider = makeProvider();
      // Manually set speaking state
      (provider as unknown as { _speaking: boolean })._speaking = true;
      provider.cancel();
      expect(provider.speaking).toBe(false);
    });

    it("can be called safely when not speaking", () => {
      const provider = makeProvider();
      expect(() => provider.cancel()).not.toThrow();
    });

    it("stops and unloads player when active", () => {
      const player = {
        play: vi.fn(),
        pause: vi.fn(),
        remove: vi.fn(),
        addListener: vi.fn(() => ({ remove: vi.fn() })),
      };

      const provider = makeProvider();
      // Set internal _player to simulate active playback
      (provider as unknown as { _player: unknown })._player = player;

      provider.cancel();

      expect(player.pause).toHaveBeenCalled();
      expect(player.remove).toHaveBeenCalled();
      expect(provider.speaking).toBe(false);
    });

    it("nulls the player reference after cancel", () => {
      const player = {
        play: vi.fn(),
        pause: vi.fn(),
        remove: vi.fn(),
        addListener: vi.fn(() => ({ remove: vi.fn() })),
      };

      const provider = makeProvider();
      (provider as unknown as { _player: unknown })._player = player;

      provider.cancel();

      expect((provider as unknown as { _player: unknown })._player).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe("cleanup", () => {
    it("deletes temp MP3 file after playback", async () => {
      mockFetchSuccess();
      setupSoundAutoFinish();

      const provider = makeProvider();
      await provider.speak("cleanup test");

      expect(mockDeleteAsync).toHaveBeenCalledWith(
        expect.stringMatching(/^\/mock\/cache\/tts_\d+\.mp3$/),
        { idempotent: true },
      );
    });

    it("removes player after playback", async () => {
      mockFetchSuccess();
      const player = setupSoundAutoFinish();

      const provider = makeProvider();
      await provider.speak("test");

      expect(player.remove).toHaveBeenCalled();
    });
  });
});
