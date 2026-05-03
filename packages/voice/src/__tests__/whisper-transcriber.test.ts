import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { WhisperTranscriber } from "../whisper-transcriber.js";
import type { FileTranscriber } from "../stt.js";

// ---------------------------------------------------------------------------
// Mock fetch + FormData
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  fields: Map<string, string>;
  fileBlob: Blob | null;
  fileName: string | null;
}

let captured: CapturedRequest | null = null;

class MockFormData {
  private readonly fields = new Map<string, string>();
  private fileBlob: Blob | null = null;
  private fileName: string | null = null;

  append(name: string, value: Blob | string, fileName?: string): void {
    if (value instanceof Blob) {
      this.fileBlob = value;
      this.fileName = fileName ?? null;
    } else {
      this.fields.set(name, value);
    }
  }

  get _fields(): Map<string, string> {
    return this.fields;
  }
  get _fileBlob(): Blob | null {
    return this.fileBlob;
  }
  get _fileName(): string | null {
    return this.fileName;
  }
}

function installMocks(options?: { status?: number; text?: string }): void {
  captured = null;
  const status = options?.status ?? 200;
  const text = options?.text ?? "  hello there  ";

  Object.defineProperty(globalThis, "FormData", {
    value: MockFormData,
    writable: true,
    configurable: true,
  });

  Object.defineProperty(globalThis, "fetch", {
    value: vi.fn(async (url: string, init: RequestInit) => {
      const fd = init.body as unknown as MockFormData;
      captured = {
        url,
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        fields: fd._fields,
        fileBlob: fd._fileBlob,
        fileName: fd._fileName,
      };
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => text,
      };
    }),
    writable: true,
    configurable: true,
  });
}

describe("WhisperTranscriber", () => {
  beforeEach(() => installMocks());
  afterEach(() => {
    captured = null;
  });

  it("implements FileTranscriber interface", () => {
    const t: FileTranscriber = new WhisperTranscriber({ apiKey: "sk-test" });
    expect(typeof t.transcribe).toBe("function");
  });

  it("POSTs to /v1/audio/transcriptions with correct shape", async () => {
    const t = new WhisperTranscriber({ apiKey: "sk-test-key" });
    const blob = new Blob(["audio"], { type: "audio/webm" });
    await t.transcribe(blob);

    expect(captured?.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(captured?.method).toBe("POST");
    expect(captured?.headers.Authorization).toBe("Bearer sk-test-key");
    expect(captured?.fields.get("model")).toBe("whisper-1");
    expect(captured?.fields.get("response_format")).toBe("text");
    expect(captured?.fileBlob).toBe(blob);
    expect(captured?.fileName).toBe("audio.webm");
  });

  it("uses configured model override", async () => {
    const t = new WhisperTranscriber({ apiKey: "sk", model: "whisper-2" });
    await t.transcribe(new Blob(["x"]));
    expect(captured?.fields.get("model")).toBe("whisper-2");
  });

  it("attaches language hint when configured", async () => {
    const t = new WhisperTranscriber({ apiKey: "sk", language: "en" });
    await t.transcribe(new Blob(["x"]));
    expect(captured?.fields.get("language")).toBe("en");
  });

  it("omits language field when not configured", async () => {
    const t = new WhisperTranscriber({ apiKey: "sk" });
    await t.transcribe(new Blob(["x"]));
    expect(captured?.fields.has("language")).toBe(false);
  });

  it("uses custom baseUrl", async () => {
    const t = new WhisperTranscriber({ apiKey: "sk", baseUrl: "https://proxy.example.com" });
    await t.transcribe(new Blob(["x"]));
    expect(captured?.url).toBe("https://proxy.example.com/v1/audio/transcriptions");
  });

  it("returns trimmed transcript text", async () => {
    installMocks({ text: "  spaced transcript  \n" });
    const t = new WhisperTranscriber({ apiKey: "sk" });
    const result = await t.transcribe(new Blob(["x"]));
    expect(result).toBe("spaced transcript");
  });

  it("throws on non-2xx response with body", async () => {
    installMocks({ status: 401, text: "Invalid API key" });
    const t = new WhisperTranscriber({ apiKey: "sk-bad" });
    await expect(t.transcribe(new Blob(["x"]))).rejects.toThrow(
      "Whisper error: 401 — Invalid API key",
    );
  });

  it("throws on non-2xx response with empty body", async () => {
    installMocks({ status: 500, text: "" });
    const t = new WhisperTranscriber({ apiKey: "sk" });
    await expect(t.transcribe(new Blob(["x"]))).rejects.toThrow("Whisper error: 500");
  });

  it("survives response.text() throwing during error path", async () => {
    Object.defineProperty(globalThis, "fetch", {
      value: vi.fn(async () => ({
        ok: false,
        status: 502,
        text: async () => {
          throw new Error("body read failed");
        },
      })),
      writable: true,
      configurable: true,
    });
    const t = new WhisperTranscriber({ apiKey: "sk" });
    await expect(t.transcribe(new Blob(["x"]))).rejects.toThrow("Whisper error: 502");
  });
});
