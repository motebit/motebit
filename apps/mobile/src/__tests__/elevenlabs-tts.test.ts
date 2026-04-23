import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks (same shape as openai-tts.test.ts — the two adapters share a sink)
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

import { ElevenLabsTTSProvider, ELEVENLABS_VOICES } from "../adapters/elevenlabs-tts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(overrides?: { apiKey?: string; voice?: string; model?: string }) {
  return new ElevenLabsTTSProvider({
    apiKey: overrides?.apiKey ?? "xi-test",
    voice: overrides?.voice,
    model: overrides?.model,
  });
}

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

function mockFetchError(status = 500, body = "") {
  const mockResponse = {
    ok: false,
    status,
    text: vi.fn(async () => body),
    arrayBuffer: vi.fn(),
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => mockResponse),
  );
  return mockResponse;
}

function setupSoundAutoFinish() {
  let playbackCallback: ((status: { didJustFinish: boolean }) => void) | null = null;

  const player = {
    play: vi.fn(() => {
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

describe("ElevenLabsTTSProvider (mobile)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetAudioMode.mockResolvedValue(undefined);
    mockWriteString.mockResolvedValue(undefined);
    mockDeleteAsync.mockResolvedValue(undefined);
  });

  describe("exports", () => {
    it("exports the curated voice table with Rachel", () => {
      expect(ELEVENLABS_VOICES.Rachel).toBe("21m00Tcm4TlvDq8ikWAM");
    });
  });

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

  describe("constructor", () => {
    it("resolves curated voice name to voice_id in the URL", async () => {
      mockFetchSuccess();
      setupSoundAutoFinish();

      const provider = makeProvider({ voice: "Rachel" });
      await provider.speak("test");

      const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(fetchCall[0]).toContain(`/v1/text-to-speech/${ELEVENLABS_VOICES.Rachel}`);
    });

    it("accepts a raw voice_id", async () => {
      mockFetchSuccess();
      setupSoundAutoFinish();

      const provider = makeProvider({ voice: "some-raw-id" });
      await provider.speak("test");

      const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(fetchCall[0]).toContain("/v1/text-to-speech/some-raw-id");
    });

    it("defaults to Rachel when no voice is specified", async () => {
      mockFetchSuccess();
      setupSoundAutoFinish();

      const provider = makeProvider();
      await provider.speak("test");

      const fetchCall = (fetch as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(fetchCall[0]).toContain(ELEVENLABS_VOICES.Rachel);
    });
  });

  describe("speak()", () => {
    it("posts the ElevenLabs body shape with xi-api-key header", async () => {
      mockFetchSuccess();
      setupSoundAutoFinish();

      const provider = makeProvider({ apiKey: "xi-real" });
      await provider.speak("hello world");

      expect(fetch).toHaveBeenCalledWith(
        expect.stringMatching(/elevenlabs\.io\/v1\/text-to-speech\//),
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "xi-api-key": "xi-real",
            "Content-Type": "application/json",
            Accept: "audio/mpeg",
          }),
        }),
      );

      const body = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![1].body);
      expect(body.text).toBe("hello world");
      expect(body.model_id).toBe("eleven_flash_v2_5");
      expect(body.voice_settings).toEqual({
        stability: 0.5,
        similarity_boost: 0.75,
        use_speaker_boost: true,
      });
    });

    it("throws on API error", async () => {
      mockFetchError(429, "rate limited");

      const provider = makeProvider();
      await expect(provider.speak("test")).rejects.toThrow(/ElevenLabs TTS error: 429/);
      expect(provider.speaking).toBe(false);
    });

    it("writes MP3 to cache and deletes it after playback", async () => {
      mockFetchSuccess();
      setupSoundAutoFinish();

      const provider = makeProvider();
      await provider.speak("cleanup test");

      expect(mockWriteString).toHaveBeenCalledWith(
        expect.stringMatching(/^\/mock\/cache\/tts_eleven_\d+\.mp3$/),
        expect.any(String),
        { encoding: "base64" },
      );
      expect(mockDeleteAsync).toHaveBeenCalledWith(
        expect.stringMatching(/^\/mock\/cache\/tts_eleven_\d+\.mp3$/),
        { idempotent: true },
      );
    });
  });

  describe("cancel()", () => {
    it("is safe to call when not speaking", () => {
      const provider = makeProvider();
      expect(() => provider.cancel()).not.toThrow();
      expect(provider.speaking).toBe(false);
    });

    it("pauses and removes player when active", () => {
      const player = {
        play: vi.fn(),
        pause: vi.fn(),
        remove: vi.fn(),
        addListener: vi.fn(() => ({ remove: vi.fn() })),
      };

      const provider = makeProvider();
      (provider as unknown as { _player: unknown })._player = player;

      provider.cancel();

      expect(player.pause).toHaveBeenCalled();
      expect(player.remove).toHaveBeenCalled();
      expect(provider.speaking).toBe(false);
    });
  });
});
