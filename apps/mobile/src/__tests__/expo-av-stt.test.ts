import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let mockRecording: {
  stopAndUnloadAsync: ReturnType<typeof vi.fn>;
  getURI: ReturnType<typeof vi.fn>;
};

const mockRequestPermissions = vi.fn();
const mockSetAudioMode = vi.fn();
const mockCreateRecording = vi.fn();
const mockGetInfoAsync = vi.fn();
const mockUploadAsync = vi.fn();

vi.mock("expo-av", () => ({
  Audio: {
    requestPermissionsAsync: (...args: unknown[]) =>
      mockRequestPermissions(...args),
    setAudioModeAsync: (...args: unknown[]) => mockSetAudioMode(...args),
    Recording: {
      createAsync: (...args: unknown[]) => mockCreateRecording(...args),
    },
    RecordingOptionsPresets: {
      HIGH_QUALITY: {},
    },
  },
}));

vi.mock("expo-file-system", () => ({
  getInfoAsync: (...args: unknown[]) => mockGetInfoAsync(...args),
  uploadAsync: (...args: unknown[]) => mockUploadAsync(...args),
  FileSystemUploadType: {
    MULTIPART: 1,
  },
}));

import { ExpoAVSTTProvider } from "../adapters/expo-av-stt.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(overrides?: { apiKey?: string; model?: string; language?: string }) {
  return new ExpoAVSTTProvider({
    apiKey: overrides?.apiKey ?? "test-api-key",
    model: overrides?.model,
    language: overrides?.language,
  });
}

function setupSuccessfulRecording(uri = "file:///mock/audio.m4a") {
  mockRecording = {
    stopAndUnloadAsync: vi.fn(async () => {}),
    getURI: vi.fn(() => uri),
  };
  mockRequestPermissions.mockResolvedValue({ granted: true, status: "granted" });
  mockSetAudioMode.mockResolvedValue(undefined);
  mockCreateRecording.mockResolvedValue({ recording: mockRecording });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ExpoAVSTTProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Interface compliance
  // -------------------------------------------------------------------------

  describe("STTProvider interface", () => {
    it("has start, stop, listening, onResult, onError, onEnd", () => {
      const provider = makeProvider();
      expect(typeof provider.start).toBe("function");
      expect(typeof provider.stop).toBe("function");
      expect(typeof provider.listening).toBe("boolean");
      expect(provider.onResult).toBeNull();
      expect(provider.onError).toBeNull();
      expect(provider.onEnd).toBeNull();
    });

    it("listening defaults to false", () => {
      expect(makeProvider().listening).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // start()
  // -------------------------------------------------------------------------

  describe("start()", () => {
    it("requests microphone permission and creates recording", async () => {
      setupSuccessfulRecording();
      const provider = makeProvider();

      provider.start();
      // Let the async _startRecording() complete
      await vi.waitFor(() => expect(provider.listening).toBe(true));

      expect(mockRequestPermissions).toHaveBeenCalled();
      expect(mockSetAudioMode).toHaveBeenCalledWith({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });
      expect(mockCreateRecording).toHaveBeenCalled();
    });

    it("fires onError when permission denied", async () => {
      mockRequestPermissions.mockResolvedValue({ granted: false, status: "denied" });
      const provider = makeProvider();
      const onError = vi.fn();
      provider.onError = onError;

      provider.start();
      await vi.waitFor(() => expect(mockRequestPermissions).toHaveBeenCalled());
      // Allow async to settle
      await new Promise((r) => setTimeout(r, 0));

      expect(onError).toHaveBeenCalledWith("Microphone permission denied");
      expect(provider.listening).toBe(false);
    });

    it("fires onError when recording creation fails", async () => {
      mockRequestPermissions.mockResolvedValue({ granted: true, status: "granted" });
      mockSetAudioMode.mockResolvedValue(undefined);
      mockCreateRecording.mockRejectedValue(new Error("Audio hardware busy"));

      const provider = makeProvider();
      const onError = vi.fn();
      provider.onError = onError;

      provider.start();
      await vi.waitFor(() => expect(onError).toHaveBeenCalled());

      expect(onError).toHaveBeenCalledWith("Audio hardware busy");
    });

    it("ignores duplicate start calls", async () => {
      setupSuccessfulRecording();
      const provider = makeProvider();

      provider.start();
      await vi.waitFor(() => expect(provider.listening).toBe(true));

      provider.start(); // second call — should be ignored
      expect(mockCreateRecording).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // stop() + transcription
  // -------------------------------------------------------------------------

  describe("stop()", () => {
    it("stops recording, transcribes via Whisper, and fires onResult", async () => {
      setupSuccessfulRecording();
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockUploadAsync.mockResolvedValue({
        body: JSON.stringify({ text: "hello world" }),
      });

      const provider = makeProvider();
      const onResult = vi.fn();
      const onEnd = vi.fn();
      provider.onResult = onResult;
      provider.onEnd = onEnd;

      provider.start();
      await vi.waitFor(() => expect(provider.listening).toBe(true));

      provider.stop();
      await vi.waitFor(() => expect(onEnd).toHaveBeenCalled());

      expect(mockRecording.stopAndUnloadAsync).toHaveBeenCalled();
      expect(onResult).toHaveBeenCalledWith("hello world", true);
      expect(provider.listening).toBe(false);
    });

    it("sends correct API parameters to Whisper", async () => {
      setupSuccessfulRecording("file:///mock/test.m4a");
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockUploadAsync.mockResolvedValue({
        body: JSON.stringify({ text: "test" }),
      });

      const provider = makeProvider({
        apiKey: "sk-test-key",
        model: "whisper-1",
        language: "fr",
      });
      const onEnd = vi.fn();
      provider.onEnd = onEnd;

      provider.start();
      await vi.waitFor(() => expect(provider.listening).toBe(true));

      provider.stop();
      await vi.waitFor(() => expect(onEnd).toHaveBeenCalled());

      expect(mockUploadAsync).toHaveBeenCalledWith(
        "https://api.openai.com/v1/audio/transcriptions",
        "file:///mock/test.m4a",
        expect.objectContaining({
          httpMethod: "POST",
          fieldName: "file",
          parameters: {
            model: "whisper-1",
            language: "fr",
          },
          headers: {
            Authorization: "Bearer sk-test-key",
          },
        }),
      );
    });

    it("uses default model and language when not specified", async () => {
      setupSuccessfulRecording();
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockUploadAsync.mockResolvedValue({
        body: JSON.stringify({ text: "hi" }),
      });

      const provider = makeProvider({ apiKey: "key" });
      const onEnd = vi.fn();
      provider.onEnd = onEnd;

      provider.start();
      await vi.waitFor(() => expect(provider.listening).toBe(true));
      provider.stop();
      await vi.waitFor(() => expect(onEnd).toHaveBeenCalled());

      const uploadCall = mockUploadAsync.mock.calls[0]!;
      expect(uploadCall[2].parameters.model).toBe("whisper-1");
      expect(uploadCall[2].parameters.language).toBe("en");
    });

    it("fires onEnd when no recording exists", async () => {
      const provider = makeProvider();
      const onEnd = vi.fn();
      provider.onEnd = onEnd;

      // Force listening state without a recording
      (provider as unknown as { _listening: boolean })._listening = true;
      provider.stop();
      await vi.waitFor(() => expect(onEnd).toHaveBeenCalled());

      expect(provider.listening).toBe(false);
    });

    it("fires onEnd when recording has no URI", async () => {
      setupSuccessfulRecording();
      const provider = makeProvider();
      const onResult = vi.fn();
      const onEnd = vi.fn();
      provider.onResult = onResult;
      provider.onEnd = onEnd;

      provider.start();
      await vi.waitFor(() => expect(provider.listening).toBe(true));

      // Simulate no URI
      mockRecording.getURI.mockReturnValue(null);

      provider.stop();
      await vi.waitFor(() => expect(onEnd).toHaveBeenCalled());

      expect(onResult).not.toHaveBeenCalled();
    });

    it("does not fire onResult for empty transcription", async () => {
      setupSuccessfulRecording();
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockUploadAsync.mockResolvedValue({
        body: JSON.stringify({ text: "" }),
      });

      const provider = makeProvider();
      const onResult = vi.fn();
      const onEnd = vi.fn();
      provider.onResult = onResult;
      provider.onEnd = onEnd;

      provider.start();
      await vi.waitFor(() => expect(provider.listening).toBe(true));
      provider.stop();
      await vi.waitFor(() => expect(onEnd).toHaveBeenCalled());

      expect(onResult).not.toHaveBeenCalled();
    });

    it("returns empty string if file does not exist", async () => {
      setupSuccessfulRecording();
      mockGetInfoAsync.mockResolvedValue({ exists: false });

      const provider = makeProvider();
      const onResult = vi.fn();
      const onEnd = vi.fn();
      provider.onResult = onResult;
      provider.onEnd = onEnd;

      provider.start();
      await vi.waitFor(() => expect(provider.listening).toBe(true));
      provider.stop();
      await vi.waitFor(() => expect(onEnd).toHaveBeenCalled());

      expect(onResult).not.toHaveBeenCalled();
      expect(mockUploadAsync).not.toHaveBeenCalled();
    });

    it("ignores stop when not listening", () => {
      const provider = makeProvider();
      const onEnd = vi.fn();
      provider.onEnd = onEnd;

      provider.stop(); // not listening — noop
      expect(onEnd).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  describe("error handling", () => {
    it("fires onError on stopAndUnloadAsync failure", async () => {
      setupSuccessfulRecording();
      mockRecording.stopAndUnloadAsync.mockRejectedValue(
        new Error("Unload failed"),
      );

      const provider = makeProvider();
      const onError = vi.fn();
      const onEnd = vi.fn();
      provider.onError = onError;
      provider.onEnd = onEnd;

      provider.start();
      await vi.waitFor(() => expect(provider.listening).toBe(true));
      provider.stop();
      await vi.waitFor(() => expect(onEnd).toHaveBeenCalled());

      expect(onError).toHaveBeenCalledWith("Unload failed");
    });

    it("returns empty string on transcription network error", async () => {
      setupSuccessfulRecording();
      mockGetInfoAsync.mockResolvedValue({ exists: true });
      mockUploadAsync.mockRejectedValue(new Error("Network error"));

      const provider = makeProvider();
      const onResult = vi.fn();
      const onEnd = vi.fn();
      provider.onResult = onResult;
      provider.onEnd = onEnd;

      provider.start();
      await vi.waitFor(() => expect(provider.listening).toBe(true));
      provider.stop();
      await vi.waitFor(() => expect(onEnd).toHaveBeenCalled());

      // Transcription failure is caught internally — empty string returned
      expect(onResult).not.toHaveBeenCalled();
    });
  });
});
